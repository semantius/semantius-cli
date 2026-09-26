/**
 * OAuth endpoint discovery. Two chains, picked by whether the host serves a
 * platform document (src/auth/platform.ts):
 *
 *   platform  GET <idp_well_known>, an OIDC discovery URL taken verbatim
 *             → the issuer and every endpoint, in one hop
 *
 *   legacy    1. RFC 9728  GET <host>/.well-known/oauth-protected-resource
 *                → authorization_servers[0] (the issuer) and the resource's
 *                  scopes (tenant:<tenant id>:user)
 *             2. RFC 8414  GET <issuer origin>/.well-known/oauth-authorization-server<issuer path>
 *                → authorization, token and revocation endpoints
 *
 * Which trust check applies where:
 *
 *  - Both: the transport floor — issuer, authorization_endpoint and
 *    token_endpoint must be https:, or http: on a loopback host.
 *  - Legacy only: RFC 8414 §3.3 — the metadata must claim the issuer it was
 *    fetched for, binding the document to the issuer that led to it.
 *  - Platform only: issuer and authorization_endpoint must share an origin.
 *    §3.3 has nothing to bind here (there is no second document to agree
 *    with; the trust root is the origin the user typed), and the OIDC §4.3
 *    equivalent — document URL == issuer + the well-known path — is failed by
 *    our own bundled idp, which serves its document at the origin root while
 *    its issuer is <origin>/idp. The origin check is strictly weaker than
 *    §3.3, and covers the mix-up that matters: PKCE cannot protect a login
 *    whose browser leg and whose code exchange go to different servers. It is
 *    deliberately not extended to token_endpoint, which legitimately differs
 *    (Google's issuer is accounts.google.com, its token endpoint
 *    oauth2.googleapis.com), and which the login callback check cannot reach
 *    anyway.
 *
 * The client id is in none of these documents: it comes from the platform
 * document, or from the control plane (HostFacts.clientId). Results are cached
 * in the host's cache file — beside its control-plane record where there is
 * one, alone on a self-hosted host — sharing the 24 h TTL and --reset-cache,
 * because a refresh needs the token endpoint and would otherwise rediscover on
 * every invocation. `login` passes rediscover and never reads that cache.
 *
 * The matching check on the login callback (RFC 9207) lives in session.ts.
 */

import { debug, getConnectTimeoutMs } from '../config.js';
import {
  type HostFacts,
  HostResolutionError,
  type OAuthMetadata,
  isLoopback,
  readCachedOAuthMetadata,
  writeCachedOAuthMetadata,
} from '../host.js';
import type { PlatformConfig } from './platform.js';

const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

/** In-flight discovery per host, so one invocation never fetches twice. */
const _pending = new Map<string, Promise<OAuthMetadata>>();

/**
 * The host's OAuth endpoints: from the disk cache, from an in-flight fetch, or
 * discovered now. `platform` is the already-resolved platform config (null on
 * a host that serves no document), which decides the chain.
 */
export function getOAuthMetadata(
  host: HostFacts,
  opts: { rediscover?: boolean; platform?: PlatformConfig | null } = {},
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
    pending = discover(host, opts.platform ?? null);
    _pending.set(host.host, pending);
    pending.catch(() => _pending.delete(host.host));
  }
  return pending;
}

/**
 * The scope string for a login.
 *
 * A platform document's non-empty `scope` is sent verbatim: it is the
 * operator's explicit statement of what this deployment's API needs, and the
 * same string its web app sends. An empty one means "whatever discovery
 * advertises", which is today's behaviour.
 */
export function buildScope(
  metadata: OAuthMetadata,
  platform?: PlatformConfig | null,
): string {
  if (platform?.scope) {
    if (!platform.scope.split(/\s+/).includes('offline_access')) {
      debug(
        `The platform document's scope omits offline_access: this login will succeed but receive no refresh token`,
      );
    }
    return platform.scope;
  }
  return [...new Set([...BASE_SCOPES, ...metadata.resourceScopes])].join(' ');
}

function discover(
  host: HostFacts,
  platform: PlatformConfig | null,
): Promise<OAuthMetadata> {
  return platform ? discoverFromPlatform(host, platform) : discoverLegacy(host);
}

/** One hop: the OIDC discovery document the platform document names. */
async function discoverFromPlatform(
  host: HostFacts,
  platform: PlatformConfig,
): Promise<OAuthMetadata> {
  const url = platform.idpWellKnown;
  const server = await fetchJson(url);

  const issuer = asString(server.issuer);
  const authorizationEndpoint = asString(server.authorization_endpoint);
  const tokenEndpoint = asString(server.token_endpoint);
  if (!issuer || !authorizationEndpoint || !tokenEndpoint) {
    throw new HostResolutionError(
      `${url} is missing issuer, authorization_endpoint or token_endpoint`,
    );
  }

  const issuerUrl = requireSecure(issuer, 'issuer', url);
  const authorizeUrl = requireSecure(
    authorizationEndpoint,
    'authorization_endpoint',
    url,
  );
  const tokenUrl = requireSecure(tokenEndpoint, 'token_endpoint', url);

  if (issuerUrl.origin !== authorizeUrl.origin) {
    throw new HostResolutionError(
      `${url} declares issuer "${issuer}" but sends the browser to "${authorizationEndpoint}", on a different origin`,
    );
  }
  if (tokenUrl.origin !== issuerUrl.origin) {
    // Legitimate at some providers; the callback check binds the issuer, and
    // PKCE binds the exchange, so this is a note rather than a refusal.
    debug(
      `${url}: token_endpoint ${tokenEndpoint} is on a different origin than the issuer ${issuer}`,
    );
  }

  return record(host, {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: asString(server.revocation_endpoint),
    deviceAuthorizationEndpoint: deviceEndpoint(
      server.device_authorization_endpoint,
      issuer,
      url,
    ),
    // The platform chain never fetches an RFC 9728 document, so there are no
    // resource scopes to add. The document's own `scope` covers that.
    resourceScopes: [],
    issParameterSupported:
      server.authorization_response_iss_parameter_supported === true,
  });
}

/** RFC 9728 → RFC 8414: the chain for a host that serves no platform document. */
async function discoverLegacy(host: HostFacts): Promise<OAuthMetadata> {
  const resource = await fetchJson(host.discoveryUrl);
  const issuer = asStringArray(resource.authorization_servers)[0];
  if (!issuer) {
    throw new HostResolutionError(
      `${host.discoveryUrl} names no authorization server (authorization_servers is missing or empty)`,
    );
  }

  // Before the fetch: a plaintext issuer should cost no request at all.
  requireSecure(issuer, 'issuer', host.discoveryUrl);

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

  requireSecure(authorizationEndpoint, 'authorization_endpoint', metadataUrl);
  requireSecure(tokenEndpoint, 'token_endpoint', metadataUrl);

  return record(host, {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: asString(server.revocation_endpoint),
    deviceAuthorizationEndpoint: deviceEndpoint(
      server.device_authorization_endpoint,
      issuer,
      metadataUrl,
    ),
    resourceScopes: asStringArray(resource.scopes_supported),
    issParameterSupported:
      server.authorization_response_iss_parameter_supported === true,
  });
}

function record(host: HostFacts, metadata: OAuthMetadata): OAuthMetadata {
  debug(
    `OAuth endpoints for ${host.host}: authorize ${metadata.authorizationEndpoint}, token ${metadata.tokenEndpoint}`,
  );
  writeCachedOAuthMetadata(host.host, metadata);
  return metadata;
}

/**
 * The transport floor: a credential may only travel over TLS, or to a loopback
 * address in local development. Applies to both chains — the legacy one took
 * its issuer from authorization_servers[0] with no scheme check at all.
 */
/**
 * The device authorization endpoint (RFC 8628), if advertised, checked harder
 * than the other endpoints: a device flow has no loopback callback, so
 * issuerMismatch() — the CLI's defence against a metadata mix-up where the
 * browser leg and the token leg go to different servers — never runs on it.
 * Binding it to the issuer's origin is the compensating control, and mirrors
 * what the platform chain already requires of authorization_endpoint.
 *
 * Absent is normal and means "this server cannot do device code": a headless
 * login then reports that rather than guessing an endpoint.
 */
function deviceEndpoint(
  value: unknown,
  issuer: string,
  docUrl: string,
): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const url = requireSecure(raw, 'device_authorization_endpoint', docUrl);
  if (url.origin !== new URL(issuer).origin) {
    throw new HostResolutionError(
      `${docUrl} declares issuer "${issuer}" but a device_authorization_endpoint on a different origin: "${raw}"`,
    );
  }
  return raw;
}

function requireSecure(value: string, field: string, docUrl: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostResolutionError(
      `${docUrl} names an invalid ${field}: "${value}"`,
    );
  }
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new HostResolutionError(
      `${docUrl} names a ${field} that is not HTTPS: "${value}"`,
    );
  }
  return url;
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
