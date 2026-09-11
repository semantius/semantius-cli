// LOCAL REPLACEMENT — not synced. scripts/sync-postgrest-mcp.ts never writes
// this file. The upstream module reads _settings through Kysely/Neon with
// server-side DB credentials, which a CLI does not have; this file keeps the
// same path and export so the vendored tool files import it unchanged.

/**
 * Placeholder until the local crud layer lands: a no-op, so vendored tools
 * that fire-and-forget a schema-cache reset do nothing when run in-process.
 */
export async function resetSchemaCache(
  _host: string,
  _token?: string,
): Promise<unknown> {
  return null;
}
