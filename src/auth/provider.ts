/**
 * OAuth endpoint discovery — the chain MCP clients use against the same
 * server, because cli-auth has none of its own:
 *
 *   1. RFC 9728  GET <host>/.well-known/oauth-protected-resource
 *                → authorization_servers[0] (the issuer) and the resource's
 *                  scopes (tenant:<tenant id>:user)
 *   2. RFC 8414  GET <issuer origin>/.well-known/oauth-authorization-server<issuer path>
 *                → authorization, token and revocation endpoints
 *
 * The client id is in neither document: it comes from the control plane
 * (HostFacts.clientId). Results are cached with the host's control-plane
 * record — same file, same 24 h TTL, same --reset-cache — because every call
 * that uses a stored session may need the token endpoint for a refresh.
 *
 * No issuer is verified here (neither the metadata's nor the callback's): the
 * server advertises authorization_response_iss_parameter_supported but sends
 * its global app issuer, so a compliant check would reject every login. Both
 * checks arrive together with the server-side fix.
 */

import { debug, getConnectTimeoutMs } from '../config.js';
import {
  type HostFacts,
  HostResolutionError,
  type OAuthMetadata,
  readCachedOAuthMetadata,
  writeCachedOAuthMetadata,
} from '../host.js';

/** Scopes every login asks for, before the resource's own scopes are added. */
const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

const _pending = new Map<string, Promise<OAuthMetadata>>();

/**
 * The host's OAuth endpoints, from the disk cache or by discovery. Memoized
 * per host for the life of the process (an invocation talks to one host), so
 * parallel connections share a single discovery.
 */
export function getOAuthMetadata(host: HostFacts): Promise<OAuthMetadata> {
  const cached = readCachedOAuthMetadata(host.host);
  if (cached) return Promise.resolve(cached);

  let pending = _pending.get(host.host);
  if (!pending) {
    pending = discover(host);
    _pending.set(host.host, pending);
    pending.catch(() => _pending.delete(host.host));
  }
  return pending;
}

/** The scope string for a login: the base scopes plus the resource's own. */
export function buildScope(metadata: OAuthMetadata): string {
  return [...new Set([...BASE_SCOPES, ...metadata.resourceScopes])].join(' ');
}

async function discover(host: HostFacts): Promise<OAuthMetadata> {
  const resource = await fetchJson(host.discoveryUrl);
  const issuer = asStringArray(resource.authorization_servers)[0];
  if (!issuer) {
    throw new HostResolutionError(
      `${host.discoveryUrl} names no authorization server (authorization_servers is missing or empty)`,
    );
  }

  const metadataUrl = authorizationServerMetadataUrl(issuer, host);
  const server = await fetchJson(metadataUrl);
  const authorizationEndpoint = asString(server.authorization_endpoint);
  const tokenEndpoint = asString(server.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new HostResolutionError(
      `${metadataUrl} is missing authorization_endpoint or token_endpoint`,
    );
  }

  const metadata: OAuthMetadata = {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: asString(server.revocation_endpoint),
    resourceScopes: asStringArray(resource.scopes_supported),
  };
  debug(
    `OAuth endpoints for ${host.host}: authorize ${authorizationEndpoint}, token ${tokenEndpoint}`,
  );
  writeCachedOAuthMetadata(host.host, metadata);
  return metadata;
}

/**
 * RFC 8414 §3.1: the metadata of an issuer with a path lives under
 * /.well-known/oauth-authorization-server followed by that path, e.g.
 * https://acme.semantius.cloud/api/auth →
 * https://acme.semantius.cloud/.well-known/oauth-authorization-server/api/auth
 */
function authorizationServerMetadataUrl(
  issuer: string,
  host: HostFacts,
): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new HostResolutionError(
      `${host.discoveryUrl} names an invalid authorization server: "${issuer}"`,
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  debug(`OAuth discovery: GET ${url}`);
  let response: Response;
  try {
    const timeoutMs = getConnectTimeoutMs();
    response = await fetch(
      url,
      timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
  } catch (error) {
    throw new HostResolutionError(
      `could not reach ${url}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new HostResolutionError(`${url} returned ${response.status}`);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HostResolutionError(`unexpected response from ${url}: not JSON`);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
