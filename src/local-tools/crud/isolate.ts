/**
 * The shims around the vendored postgrest-mcp code, for the lifetime of a
 * crud call (connection.ts) and of a --stream request (stream.ts). A module of
 * its own so --stream does not load the full tool registry.
 */

import { format } from 'node:util';
import { getPrefixedEnv } from '../../config.js';

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
 * Run `fn` with (1) console.log and console.error forwarded to debug() —
 * upstream logs every request, and every failure with its request body and
 * stack, which is a server log on Deno but output corruption and noise here;
 * the CLI reports failures itself — and (2) the GUARDED_ENV_VARS hidden.
 * Everything is restored afterwards.
 */
export async function isolateVendoredCall<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  // What debug() does, but through the saved console.error: debug() itself
  // writes via console.error, which is redirected here (hence no second prefix
  // for a CLI debug() line that runs inside the window).
  const toDebug = (...args: unknown[]) => {
    if (!getPrefixedEnv('DEBUG')) return;
    const text = format(...args);
    originalError(
      text.startsWith('[semantius] ') ? text : `[semantius] ${text}`,
    );
  };
  console.log = toDebug;
  console.error = toDebug;
  const saved = GUARDED_ENV_VARS.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of GUARDED_ENV_VARS) delete process.env[name];
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
