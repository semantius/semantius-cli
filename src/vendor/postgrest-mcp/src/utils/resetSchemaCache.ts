// LOCAL REPLACEMENT — not synced. scripts/sync-postgrest-mcp.ts never writes
// this file. The upstream module reads _settings through Kysely/Neon with
// server-side DB credentials, which a CLI does not have; this file keeps the
// same path and export so the vendored tool files import it unchanged.
//
// Cloud: ask the original crud MCP server (Deno) to refresh the tenant's
// PostgREST schema cache via its refresh_schema_cache tool — it keeps the
// _settings slug logic. Self-hosted: no-op (pg_semantius refreshes itself).
//
// Six of the seven callers fire and forget (`.catch(() => {})`), so every
// in-flight call is tracked and the CLI drains them before it exits.

import {
  callTool,
  connectToServer,
  debug,
  safeClose,
} from '../../../../client.js';
import { REMOTE_CRUD_MCP, getPrefixedEnv } from '../../../../config.js';
import { getCurrentHost } from '../../../../local-tools/crud/context.js';

const DEFAULT_SIDE_EFFECT_TIMEOUT_MS = 10_000;

const pending = new Set<Promise<unknown>>();

export function resetSchemaCache(
  _host: string,
  token?: string,
): Promise<unknown> {
  const host = getCurrentHost();
  if (!host || host.mode !== 'cloud' || !token) return Promise.resolve(null);

  const call: Promise<unknown> = refreshRemoteSchemaCache(token).finally(() =>
    pending.delete(call),
  );
  pending.add(call);
  return call;
}

async function refreshRemoteSchemaCache(token: string): Promise<unknown> {
  const { headers: _apiKeyHeader, ...remote } = REMOTE_CRUD_MCP();
  let connection: Awaited<ReturnType<typeof connectToServer>> | undefined;
  try {
    connection = await connectToServer('crud-mcp', {
      ...remote,
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = (await callTool(
      connection.client,
      'refresh_schema_cache',
      {},
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text =
      result.content
        ?.filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('\n') ?? '';
    if (result.isError) {
      throw new Error(text.replace(/^Error:\s*/, '') || 'tool returned an error');
    }
    debug('resetSchemaCache: refresh_schema_cache ok');
    // The remote tool formats the refresh endpoint's body; hand back the
    // parsed body so the local refresh_schema_cache tool formats it the same.
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    debug(
      `resetSchemaCache: refresh_schema_cache failed: ${(error as Error).message}`,
    );
    throw error;
  } finally {
    if (connection) await safeClose(connection.close);
  }
}

/** ${PREFIX}_SIDE_EFFECT_TIMEOUT (seconds), default 10 s. */
function sideEffectTimeoutMs(): number {
  const seconds = Number.parseInt(getPrefixedEnv('SIDE_EFFECT_TIMEOUT') ?? '', 10);
  return Number.isNaN(seconds) || seconds < 0
    ? DEFAULT_SIDE_EFFECT_TIMEOUT_MS
    : seconds * 1000;
}

/**
 * Wait for in-flight schema-cache refreshes, at most `timeoutMs`. Their
 * failures are already logged under ${PREFIX}_DEBUG and never fail the command.
 */
export async function drainPendingSideEffects(
  timeoutMs = sideEffectTimeoutMs(),
): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([
    Promise.allSettled([...pending]),
    timedOut,
  ]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    debug(
      `resetSchemaCache: ${pending.size} refresh_schema_cache call(s) still pending after ${timeoutMs} ms; exiting without them`,
    );
  }
}

/** Number of in-flight side effects (for tests). */
export function pendingSideEffectCount(): number {
  return pending.size;
}
