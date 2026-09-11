/**
 * --stream: the raw path for `call crud postgrestRequest`.
 *
 * Sends the request the vendored postgrestRequest handler would send, but
 * pipes the PostgREST response body to stdout unchanged — no JSON parse, no
 * MCP envelope, no pretty-print. The output is PostgREST's own: compact JSON,
 * or CSV for `accept: text/csv` (which the non-stream path cannot return).
 *
 * The vendored code offers nothing reusable here (getHeaders is private and
 * makePostgrestRequest parses the body), so the request construction is
 * duplicated; tests/stream.test.ts proves it equal to the handler's.
 */

import { z } from 'zod';
import { getAccessToken } from '../../auth/token.js';
import type { PostgrestServerConfig } from '../../config.js';
import { ErrorCode } from '../../errors.js';
import { resolveHost } from '../../host.js';
import { recordJwt, recordUrl, timeMcp } from '../../logger.js';
import { postgrestRequestTool } from '../../vendor/postgrest-mcp/src/tools/postgrestRequest.js';
import { isolateVendoredCall } from './isolate.js';
import { withLocalRetries } from './retry.js';

const argsSchema = z.object(postgrestRequestTool.options.inputSchema);

export type StreamArgs = z.infer<typeof argsSchema>;

export interface StreamRequest {
  url: string;
  method: StreamArgs['method'];
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * The request makePostgrestRequest builds for postgrestRequest: URL =
 * PostgREST base + path, JSON content type, return=representation, the
 * optional accept, the bearer — and never an `apikey`.
 */
export function buildStreamRequest(
  postgrestUrl: string,
  token: string,
  args: StreamArgs,
): StreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    prefer: 'return=representation',
    ...(args.accept ? { accept: args.accept } : {}),
    authorization: `Bearer ${token}`,
  };
  return {
    url: new URL(`${postgrestUrl}${args.path}`).toString(),
    method: args.method,
    headers,
    body: args.body
      ? typeof args.body === 'string'
        ? args.body
        : JSON.stringify(args.body)
      : undefined,
  };
}

/** Same text shape as makePostgrestRequest's errors: "(code) message". */
function postgrestErrorText(body: string): string {
  try {
    const json = JSON.parse(body);
    const message = json.message || body;
    return json.code ? `(${json.code}) ${message}` : message;
  } catch {
    return body;
  }
}

/** 401/403 → 5, 5xx → 3, any other non-2xx → 4. */
export function streamExitCode(status: number): number {
  if (status === 401 || status === 403) return ErrorCode.AUTH_ERROR;
  if (status >= 500) return ErrorCode.NETWORK_ERROR;
  return ErrorCode.SERVER_ERROR;
}

/**
 * Validate the arguments, send the request (with the local retry loop) and
 * pipe a successful body to stdout. Errors go to stderr. Returns the exit
 * code: 0, 1 (invalid arguments), 3 (5xx or network), 4, or 5 (401/403).
 */
export async function streamPostgrestRequest(
  config: PostgrestServerConfig,
  rawArgs: Record<string, unknown>,
): Promise<number> {
  const parsed = argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
      .join('; ');
    console.error(`Error: invalid postgrestRequest arguments: ${issues}`);
    return ErrorCode.CLIENT_ERROR;
  }
  const args = parsed.data;

  const resolved = await resolveHost();
  const host =
    typeof config.postgrest === 'string'
      ? { ...resolved, postgrestUrl: config.postgrest.replace(/\/+$/, '') }
      : resolved;
  let token = await getAccessToken(host);
  recordUrl(host.postgrestUrl);
  recordJwt(token);

  // The last HTTP status seen, so a failure that exhausted its retries (and
  // surfaces as a thrown error) still maps to its exit code.
  let lastStatus: number | undefined;
  const attempt = async () => {
    lastStatus = undefined;
    const request = buildStreamRequest(host.postgrestUrl, token, args);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    if (response.ok) return { ok: true as const, response };
    lastStatus = response.status;
    const text = postgrestErrorText(await response.text());
    // Also the shape retryableErrorFromResult classifies, like a tool error.
    return {
      ok: false as const,
      isError: true,
      content: [{ type: 'text', text: `Error: ${text}` }],
    };
  };
  const refresh = async () => {
    token = await getAccessToken(host, { forceRefresh: true });
    recordJwt(token);
  };

  return isolateVendoredCall(async () => {
    try {
      const outcome = await timeMcp(() =>
        withLocalRetries(attempt, { refresh }),
      );
      if (outcome.ok) {
        await Bun.write(Bun.stdout, outcome.response);
        return 0;
      }
      console.error(outcome.content[0].text);
      return streamExitCode(lastStatus ?? 0);
    } catch (error) {
      const message = (error as Error).message;
      console.error(/^error\b/i.test(message) ? message : `Error: ${message}`);
      return lastStatus === undefined
        ? ErrorCode.NETWORK_ERROR
        : streamExitCode(lastStatus);
    }
  });
}
