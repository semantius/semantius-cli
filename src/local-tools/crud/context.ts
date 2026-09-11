/**
 * Request context for the vendored postgrest-mcp tool handlers.
 *
 * Upstream builds it from the inbound /mcp request; in-process there is no
 * request, so the CLI synthesises the one the handlers expect. getCurrentUser,
 * get_cli_config, sendEmail and get_cli_token derive the org slug and
 * api_baseurl from `request.url` / `request.headers`.
 */

import type { HostFacts } from '../../host.js';

export interface ToolContext {
  authInfo: {
    token: string;
    /** The tenant PostgREST base URL (upstream's name for it). */
    apiBaseUrl: string;
  };
  request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    query: Record<string, string>;
  };
}

/**
 * The context a handler sees. Cloud: request.url is the Deno host
 * (https://<org>.semantius.ai/mcp — webhooks live there), header keys are
 * lowercase, x-api-key only when the API-key credential is active.
 * Self-hosted: request.url is <host>/api/mcp.
 */
export function buildToolContext(
  host: HostFacts,
  token: string,
  apiKey?: string,
): ToolContext {
  const url = `${host.apiBaseUrl}/mcp`;
  const headers: Record<string, string> = { host: new URL(url).host };
  if (host.mode === 'cloud' && apiKey) headers['x-api-key'] = apiKey;
  return {
    authInfo: { token, apiBaseUrl: host.postgrestUrl },
    request: { method: 'POST', url, headers, query: {} },
  };
}

// Context holder: set by connection.ts before each call and updated after a
// token refresh; the registered tool wrapper reads it per call. The host is
// kept alongside for the schema-cache side effect (resetSchemaCache.ts).
let current: ToolContext | undefined;
let currentHost: HostFacts | undefined;

export function setCurrentContext(host: HostFacts, context: ToolContext): void {
  currentHost = host;
  current = context;
}

export function getCurrentContext(): ToolContext {
  if (!current) {
    throw new Error('crud tool called without a request context');
  }
  return current;
}

/** Host of the active crud connection, or undefined outside the local layer. */
export function getCurrentHost(): HostFacts | undefined {
  return currentHost;
}

/** Test seam: forget the active context. */
export function clearCurrentContext(): void {
  current = undefined;
  currentHost = undefined;
}
