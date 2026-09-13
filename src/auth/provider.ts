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
 * (HostFacts.clientId). Results are cached in the host's cache file — beside
 * its control-plane record where there is one, alone on a self-hosted host —
 * sharing the 24 h TTL and --reset-cache, because a refresh needs the token
 * endpoint and would otherwise rediscover on every invocation. `login` passes
 * rediscover and never reads that cache.
 *
 * RFC 8414 §3.3: the metadata must name the issuer it was fetched for, so the
 * document and the issuer that led to it are bound together. The matching
 * check on the login callback lives in session.ts.
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
export function getOAuthMetadata(
  host: HostFacts,
  opts: { rediscover?: boolean } = {},
): Promise<OAuthMetadata> {
  if (opts.rediscover) {
    // A login re-establishes trust in the host from scratch and must not build
    // on endpoints cached up to 24 h ago. An instance that has changed its
    // OAuth configuration would otherwise send the browser to a stale
    // authorization endpoint, and the callback's issuer check would compare
    // against the stale issuer — reporting a mismatch that blames the server
    // for what is really a stale cache.
    _pending.delete(host.host);
  } else {
    const cached = readCachedOAuthMetadata(host.host);
    if (cached) return Promise.resolve(cached);
  }

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

  // RFC 8414 §3.3: the document must claim the issuer it was fetched for.
  // Without this a resource could point at a document that belongs to a
  // different authorization server, and the callback check below would then
  // compare against the wrong issuer.
  const declared = asString(server.issuer);
  if (declared !== issuer) {
    throw new HostResolutionError(
      `${metadataUrl} declares issuer "${declared ?? '(none)'}" but ${host.discoveryUrl} names "${issuer}"`,
    );
  }

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
    issParameterSupported:
      server.authorization_response_iss_parameter_supported === true,
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
