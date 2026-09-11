/**
 * The shims around the vendored postgrest-mcp code, for the lifetime of a
 * crud call (connection.ts) and of a --stream request (stream.ts). A module of
 * its own so --stream does not load the full tool registry.
 */

import { format } from 'node:util';
import { debug } from '../../config.js';

/**
 * Env vars the vendored getHeaders / makePostgrestRequest / getCurrentUser
 * read. On Deno they are server config; in a developer's shell an unrelated
 * API_KEY would be sent to PostgREST as `apikey`.
 */
export const GUARDED_ENV_VARS = [
  'API_KEY',
  'SUPABASE_ANON_KEY',
  'API_BASE_URL',
  'SUPABASE_URL',
] as const;

/**
 * Run `fn` with (1) console.log forwarded to debug() — upstream logs every
 * request to stdout, a server log on Deno but output corruption here — and
 * (2) the GUARDED_ENV_VARS hidden. Both are restored afterwards.
 */
export async function isolateVendoredCall<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => debug(format(...args));
  const saved = GUARDED_ENV_VARS.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of GUARDED_ENV_VARS) delete process.env[name];
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
