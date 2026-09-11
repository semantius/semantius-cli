/**
 * Readable errors for PostgREST requests that fail without a PostgREST error.
 *
 * The vendored makePostgrestRequest reports a failure as the response body's
 * `(code) message` — meaningful when PostgREST answered, but when the host is
 * not PostgREST at all (a web app, a proxy, a wrong self-hosted host) the body
 * is empty or an HTML page, and the user sees "Request failed" or a page of
 * markup, without the status or the URL. The CLI records the failed requests
 * of a call and names them instead.
 */

import { STATUS_CODES } from 'node:http';
import type { HostFacts } from '../../host.js';

/** A failed PostgREST request: an error status, or fetch itself threw. */
export interface HttpFailure {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  /** The body is PostgREST's own JSON error — already meaningful. */
  postgrestError?: boolean;
  /** fetch threw (DNS, connection refused, TLS). */
  error?: string;
}

/**
 * Run `fn` with fetch wrapped to append every failed request to `failures`.
 * Error responses are cloned to classify their body; nothing else changes.
 */
export async function recordFetchFailures<T>(
  failures: HttpFailure[],
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      failures.push({ method, url, error: (error as Error).message });
      throw error;
    }
    if (!response.ok) {
      const body = await response
        .clone()
        .text()
        .catch(() => '');
      failures.push({
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        postgrestError: isPostgrestErrorBody(body),
      });
    }
    return response;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** The status text, or the standard phrase when there is none (HTTP/2 has no reason phrase). */
export function reasonPhrase(status?: number, statusText?: string): string {
  return statusText || (status && STATUS_CODES[status]) || 'error';
}

/** Whether an error body is PostgREST's JSON error ({ code?, message, … }). */
export function isPostgrestErrorBody(body: string): boolean {
  try {
    const json = JSON.parse(body);
    return !!json && typeof json === 'object' && 'message' in json;
  } catch {
    return false;
  }
}

/**
 * The last failed request to the host's PostgREST that PostgREST itself did
 * not explain, or undefined. Requests elsewhere (the schema-cache side effect
 * talks to the cloud MCP server) are ignored.
 */
export function unexplainedFailure(
  failures: HttpFailure[],
  host: HostFacts,
): HttpFailure | undefined {
  const last = failures
    .filter((f) => f.url.startsWith(host.postgrestUrl))
    .at(-1);
  return last && !last.postgrestError ? last : undefined;
}

/**
 * "(HTTP 405) Method Not Allowed from POST <url>" or "POST <url> failed: …",
 * plus, on self-hosted, whether the host is a Semantius instance at all. The
 * "(HTTP 401)" / "(HTTP 403)" forms keep auth failures recognisable (exit 5).
 */
export function describeFailure(f: HttpFailure, host: HostFacts): string {
  const what =
    f.error !== undefined
      ? `${f.method} ${f.url} failed: ${f.error}`
      : `(HTTP ${f.status}) ${reasonPhrase(f.status, f.statusText)} from ${f.method} ${f.url}`;
  return host.mode === 'selfhosted'
    ? `${what} — is ${host.host} a Semantius instance? Its PostgREST is expected at ${host.postgrestUrl}`
    : what;
}
