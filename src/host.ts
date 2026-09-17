/**
 * Host / server resolution.
 *
 * One host value decides where the CLI talks to (see resolveHostValue for
 * the full detail): --host, else --token's org (the two cannot be combined),
 * else the current host (`semantius use`), else — checking each in turn,
 * host before org at each — the shell environment, the local `.env` (cwd →
 * config-file dir → exe dir, first found) and the global `.env`
 * (`<user config dir>/.env`). An "org:"-prefixed ${PREFIX}_JWT /
 * ${PREFIX}_API_KEY supplies the org of whichever of those three it was
 * itself set in, the same way a bare ${PREFIX}_ORG would.
 *
 * A host resolved from the environment/.env layers that disagrees with an
 * org-bound credential *at that same layer* is a HOST_CONFLICT error rather
 * than a silent pick (host beats org within a layer, but not silently over a
 * credential's own claim) — a layer never reached because an earlier one
 * already resolved a host is simply not consulted, credential included.
 *
 * A host is a bare hostname[:port]; the CLI picks the protocol (hostBaseUrl).
 * A host matching *.semantius.cloud is the managed cloud: the org is its first
 * label and the control plane supplies the tenant's PostgREST URL, tenant id
 * and CLI OAuth client id (cached on disk for 24 h). Any other host is
 * self-hosted and resolves from fixed paths without network I/O.
 *
 * A self-hosted instance may also publish /.well-known/semantius.json, which
 * names its CLI client id, audience and IdP. That document is an auth-layer
 * concern (src/auth/platform.ts), deliberately not part of host resolution:
 * resolving a self-hosted host stays synchronous and network-free. Only its
 * cache slot lives here, beside the OAuth endpoints and under the same TTL.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CredentialOrgInfo,
  debug,
  describeEnvVar,
  getApiKeyOrgInfo,
  getConnectTimeoutMs,
  getEnvVarPosition,
  getGlobalEnvPath,
  getHostFlag,
  getJwtOrgInfo,
  getLocalEnvPath,
  getTokenArg,
  getUserConfigDir,
  prefixedEnvName,
  suppressCredential,
} from './config.js';
import { ErrorCode, formatCliError } from './errors.js';
import { getCurrentHost } from './hosts-index.js';

export interface HostFacts {
  mode: 'cloud' | 'selfhosted';
  /** Bare hostname[:port], e.g. acme.semantius.cloud */
  host: string;
  org: string | null;
  tenantId: string | null;
  postgrestUrl: string;
  /** Where OAuth discovery starts: the RFC 9728 protected-resource document. */
  discoveryUrl: string;
  tokenExchange: { method: 'POST' | 'GET'; url: string };
  clientId: string | null;
  apiBaseUrl: string;
  uiBaseUrl: string;
}

/**
 * Pre-discovery placeholder and legacy fallback for the CLI's client id on
 * self-hosted instances: the id every instance registered before
 * /.well-known/semantius.json existed (a public native client with the
 * loopback redirect URIs).
 *
 * An instance that serves the platform document names its own client id there
 * — a GUID, on an Entra-backed deployment — and that one wins. This value is
 * what a host without the document logs in with, and what makes the
 * pre-discovery "can this host be logged in to at all" gate vacuous for
 * self-hosted hosts.
 */
export const SELF_HOSTED_CLIENT_ID: string | null = 'semantius-cli';

/**
 * The OAuth endpoints of a host, discovered from its .well-known documents by
 * one of two chains (src/auth/provider.ts):
 *
 *   - the platform document names an OIDC discovery URL, which carries the
 *     issuer and the endpoints in one hop; or
 *   - the legacy chain: the issuer and the resource scopes come from the
 *     RFC 9728 protected-resource document, the endpoints from that issuer's
 *     RFC 8414 metadata.
 */
export interface OAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** Scopes the protected resource declares, e.g. tenant:<tenant id>:user. */
  resourceScopes: string[];
  /**
   * RFC 9207: the server promises an `iss` on every authorization response,
   * which makes a missing one a failure rather than an older server.
   */
  issParameterSupported: boolean;
}

/**
 * What /.well-known/semantius.json told us about a self-hosted instance.
 *
 * Client-registration facts, not endpoints — which is why they are not folded
 * into OAuthMetadata: the two have different invalidation needs (a stale
 * endpoint fails loudly, a stale client id fails as unauthorized_client) and
 * only one of them is re-resolved by `login`'s rediscover.
 *
 * Declared here rather than in src/auth/platform.ts so the cache layer does
 * not depend on the auth layer, exactly as OAuthMetadata is.
 */
export interface PlatformConfig {
  /** The document's own URL: error messages, and the base for relative URLs. */
  docUrl: string;
  /** The document's `version`. Also the cache shape guard. */
  docVersion: number;
  /** ADVISORY. Logged and quoted in errors; never branched on. */
  idpType: string;
  /** OIDC discovery URL, already absolute. */
  idpWellKnown: string;
  clientId: string;
  /** Loopback callbacks the instance registered, in the document's order. */
  redirects: ReadonlyArray<{ port: number; path: string }>;
  /** Verbatim scope string; '' means "whatever discovery advertises". */
  scope: string;
  /** RFC 8707 resource indicator for this instance's API. */
  audience?: string;
  /** Recorded, not consumed — see src/auth/platform.ts. */
  gatewayUrl?: string;
  apiUrl?: string;
}

/**
 * A cached platform slot: the config, or the marker that this host serves no
 * document at all. The marker is what keeps an un-upgraded deployment to one
 * request per 24 h instead of one per invocation.
 */
export type CachedPlatform = { absent: true } | PlatformConfig;

const CLOUD_SUFFIX = '.semantius.cloud';
const CONTROL_PLANE_URL = 'https://api.semantius.cloud';
export const HOST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Failure to turn the configured host into HostFacts. */
export class HostResolutionError extends Error {
  constructor(detail: string) {
    super(`Error [HOST_RESOLUTION_FAILED]: ${detail}`);
    this.name = 'HostResolutionError';
  }
}

// ============================================================================
// Host value
// ============================================================================

/**
 * Normalize a --host / ${PREFIX}_HOST value to a bare, lowercase
 * hostname[:port]: a leading https:// or http:// and trailing slashes are
 * stripped, as is a port that is the default for the given scheme; the
 * web-app / MCP / analytics names of a cloud org map to <org>.semantius.cloud.
 * Throws a formatted INVALID_HOST error for anything else (other schemes,
 * paths, credentials, queries).
 */
export function normalizeHost(value: string): string {
  const raw = value.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidHostError(value, 'not a valid hostname');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidHostError(value, `unsupported scheme "${url.protocol}"`);
  }
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw invalidHostError(
      value,
      'must be a hostname with an optional port, without a path, credentials, a query or a fragment',
    );
  }
  for (const [suffix, what] of OTHER_CLOUD_HOSTS) {
    if (url.hostname.endsWith(suffix) && url.hostname.length > suffix.length) {
      const host = `${url.hostname.split('.')[0]}${CLOUD_SUFFIX}`;
      debug(
        `${url.hostname} is ${what}; using the organization's host ${host}`,
      );
      return host;
    }
  }
  return url.host;
}

/**
 * The other per-org Semantius cloud domains. They are never self-hosted
 * instances, so the org is taken from them and mapped to <org>.semantius.cloud.
 */
const OTHER_CLOUD_HOSTS: ReadonlyArray<[suffix: string, what: string]> = [
  ['.semantius.app', 'the Semantius web app'],
  ['.semantius.ai', 'the Semantius cloud MCP server'],
  ['.semantius.io', 'the Semantius analytics (cube) server'],
];

function invalidHostError(value: string, reason: string): Error {
  return new Error(
    formatCliError({
      code: ErrorCode.CLIENT_ERROR,
      type: 'INVALID_HOST',
      message: `Invalid host "${value}": ${reason}`,
      suggestion:
        'Use a hostname: acme.semantius.cloud (managed cloud) or semantius.example.com[:port] (self-hosted)',
    }),
  );
}

/**
 * Hostnames reached over plain HTTP: local dev and test servers. Exported for
 * the transport floor in src/auth/provider.ts, which allows http: only here.
 */
export function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/** The URL a host is reached at: https://<host>, or http:// for loopback hosts. */
export function hostBaseUrl(host: string): string {
  const { hostname } = new URL(`https://${host}`);
  return `${isLoopback(hostname) ? 'http' : 'https'}://${host}`;
}

/**
 * Where the configured host came from. `'org'` covers a resolved organization
 * regardless of which layer named it (bare ${PREFIX}_ORG or a credential's
 * prefix) — unlike a resolved host, which distinguishes 'env' (shell) from
 * `dotenv:<path>` (a .env file). See resolveHostValue.
 */
export type HostSource =
  | 'flag'
  | 'token'
  | 'current'
  | 'env'
  | `dotenv:${string}`
  | 'org';

/** The three places ${PREFIX}_HOST / ${PREFIX}_ORG are checked, in order. */
type EnvLayer = 'shell' | 'local' | 'global';
const ENV_LAYERS: readonly EnvLayer[] = ['shell', 'local', 'global'];

/** `value`, but only if it is genuinely attributed to `layer` (never "" / unset). */
function valueAt(name: string, layer: EnvLayer): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return getEnvVarPosition(name) === layer ? raw : undefined;
}

/**
 * Every org-bound credential (JWT and/or API key) whose own var is
 * attributed to `layer` — both, if a project genuinely sets both there.
 * Kept separate from credentialAt below: a conflict check or a suppression
 * must catch either one, not just whichever credentialAt would prefer.
 */
function credentialsAt(
  layer: EnvLayer,
): Array<CredentialOrgInfo & { which: 'jwt' | 'apikey' }> {
  const result: Array<CredentialOrgInfo & { which: 'jwt' | 'apikey' }> = [];
  const jwt = getJwtOrgInfo();
  if (jwt && getEnvVarPosition(jwt.varName) === layer) {
    result.push({ ...jwt, which: 'jwt' });
  }
  const apiKey = getApiKeyOrgInfo();
  if (apiKey && getEnvVarPosition(apiKey.varName) === layer) {
    result.push({ ...apiKey, which: 'apikey' });
  }
  return result;
}

/**
 * The org-bound JWT or API key whose own var is attributed to `layer`, if
 * any (JWT wins, matching getCredentialSource's precedence) — for orgAt's
 * single "the org at this layer" answer. A conflict check or a suppression
 * needs every credential at the layer instead; see credentialsAt. Kept as
 * its own JWT-first check, not credentialsAt(layer)[0]: that array's order
 * is an implementation detail of a sibling function, not a contract this
 * one should depend on for its precedence.
 */
function credentialAt(
  layer: EnvLayer,
): (CredentialOrgInfo & { which: 'jwt' | 'apikey' }) | undefined {
  const jwt = getJwtOrgInfo();
  if (jwt && getEnvVarPosition(jwt.varName) === layer) {
    return { ...jwt, which: 'jwt' };
  }
  const apiKey = getApiKeyOrgInfo();
  if (apiKey && getEnvVarPosition(apiKey.varName) === layer) {
    return { ...apiKey, which: 'apikey' };
  }
  return undefined;
}

/**
 * The org that applies at `layer`: a credential's prefix there, a bare
 * ${PREFIX}_ORG genuinely attributed to that same layer, or — when both are
 * genuinely at this layer and disagree — a HOST_CONFLICT, the same way a
 * contradicting ${PREFIX}_HOST is caught by checkSameLayerConflict below.
 * Silently preferring the credential would hide a real contradiction in the
 * user's own config; silently preferring the bare org would send the
 * credential to a host it was never issued for.
 */
function orgAt(layer: EnvLayer): string | undefined {
  const credential = credentialAt(layer);
  const bareOrg = valueAt(prefixedEnvName('ORG'), layer);
  if (
    credential &&
    bareOrg &&
    orgToHost(credential.org) !== orgToHost(bareOrg)
  ) {
    throw hostConflictError(
      describeEnvVar(credential.varName),
      orgToHost(credential.org),
      prefixedEnvName('ORG'),
      describeEnvVar(prefixedEnvName('ORG')),
      orgToHost(bareOrg),
    );
  }
  return credential?.org ?? bareOrg;
}

/** An org, normalized into its cloud host the same way every other host value is (in particular, lowercased). */
function orgToHost(org: string): string {
  return normalizeHost(`${org}${CLOUD_SUFFIX}`);
}

function hostConflictError(
  credentialLabel: string,
  boundHost: string,
  otherVarName: string,
  otherLabel: string,
  otherHost: string,
): Error {
  return new Error(
    formatCliError({
      code: ErrorCode.CLIENT_ERROR,
      type: 'HOST_CONFLICT',
      message: `${credentialLabel} is bound to ${boundHost}, but ${otherLabel} names ${otherHost}`,
      suggestion: `Drop ${otherVarName}, or use a credential issued for ${otherHost}`,
    }),
  );
}

/**
 * A host resolved from ${PREFIX}_HOST at `layer` but contradicted by an
 * org-bound credential *at that same layer* (host is checked first within a
 * layer, but must still agree with every credential sharing it — the
 * classic case being both set in the same .env file; a project could
 * conceivably set both JWT and API key there, so both are checked, not just
 * the one getCredentialSource would end up using). A credential at any other
 * layer was never reached (an earlier layer already resolved something, or
 * this is a later layer that resolveHostValue never gets to) and is not
 * compared at all.
 */
function checkSameLayerConflict(layer: EnvLayer, resolvedHost: string): void {
  for (const credential of credentialsAt(layer)) {
    const boundHost = orgToHost(credential.org);
    if (boundHost === resolvedHost) continue;
    throw hostConflictError(
      describeEnvVar(credential.varName),
      boundHost,
      prefixedEnvName('HOST'),
      describeEnvVar(prefixedEnvName('HOST')),
      resolvedHost,
    );
  }
}

/**
 * Blank every org-bound credential attributed to a layer strictly after
 * `winningLayerIndex` (ENV_LAYERS[winningLayerIndex] is where the host was
 * actually resolved) — both JWT and API key, if a layer sets both, not just
 * whichever one credentialAt would prefer. Without this, getEnvJwt() /
 * getPrefixedEnv('API_KEY') — which read one flat, layer-blind value —
 * would still see it and could send it to a host it was never configured
 * for, even though it played no part in choosing that host and (per
 * checkSameLayerConflict) was never validated against it either.
 */
function suppressUnreachedCredentials(winningLayerIndex: number): void {
  for (let i = winningLayerIndex + 1; i < ENV_LAYERS.length; i++) {
    for (const credential of credentialsAt(ENV_LAYERS[i])) {
      suppressCredential(credential.which);
    }
  }
}

function hostSourceForLayer(layer: EnvLayer): HostSource {
  if (layer === 'shell') return 'env';
  const path = layer === 'local' ? getLocalEnvPath() : getGlobalEnvPath();
  return path ? `dotenv:${path}` : 'env';
}

/**
 * The configured host (normalized) and where it came from, or null when
 * nothing configures one. Order:
 *
 *   1. --host                                                        'flag'
 *   2. --token's org (cannot be combined with --host — see index.ts)  'token'
 *   3. the current host (`semantius use`, see hosts-index.ts)        'current'
 *   4. shell: ${PREFIX}_HOST, else ${PREFIX}_ORG (bare or credential)  'env'
 *   5. local .env: same pair                                  `dotenv:<path>`
 *   6. global .env: same pair                                `dotenv:<path>`
 *
 * Rungs 4-6 check host before org *within* that same rung, then move to the
 * next rung only if NEITHER was set. An org-bound credential (an "org:"
 * prefixed ${PREFIX}_JWT / ${PREFIX}_API_KEY) supplies the org of whichever
 * rung its own env var sits in; if that same rung's host disagrees, that is a
 * HOST_CONFLICT (checkSameLayerConflict) — but a credential at a rung this
 * walk never reaches (an earlier rung already resolved something) is simply
 * not consulted at all, and is actively suppressed from later credential
 * lookups too (suppressUnreachedCredentials), since those read one flat env
 * value with no notion of "rung".
 */
export function resolveHostValue(): {
  host: string;
  source: HostSource;
} | null {
  const flag = getHostFlag();
  if (flag) return { host: normalizeHost(flag), source: 'flag' };

  const tokenArg = getTokenArg();
  if (tokenArg) return { host: orgToHost(tokenArg.org), source: 'token' };

  const current = getCurrentHost();
  // Normalized like every other branch, not assumed pre-normalized: the
  // normal path (useCommand) always stores an already-normalized host, but
  // hosts.json is hand-editable (removeHost already defends against a
  // dangling entry left that way), so this shouldn't be the one source that
  // skips validation.
  if (current) return { host: normalizeHost(current), source: 'current' };

  for (let i = 0; i < ENV_LAYERS.length; i++) {
    const layer = ENV_LAYERS[i];

    const hostVal = valueAt(prefixedEnvName('HOST'), layer);
    if (hostVal) {
      const resolved = normalizeHost(hostVal);
      checkSameLayerConflict(layer, resolved);
      suppressUnreachedCredentials(i);
      return { host: resolved, source: hostSourceForLayer(layer) };
    }

    const org = orgAt(layer);
    if (org) {
      suppressUnreachedCredentials(i);
      return { host: orgToHost(org), source: 'org' };
    }
  }

  return null;
}

/** The configured host (normalized), or null when none is configured. */
export function getHost(): string | null {
  return resolveHostValue()?.host ?? null;
}

/** Where the configured host came from, or null when none is configured. */
export function getHostSource(): HostSource | null {
  return resolveHostValue()?.source ?? null;
}

/** Cloud-host rule: *.semantius.cloud is the managed cloud, anything else is self-hosted. */
export function isCloudHost(host: string): boolean {
  const { hostname } = new URL(`https://${host}`);
  return (
    hostname.endsWith(CLOUD_SUFFIX) && hostname.length > CLOUD_SUFFIX.length
  );
}

/** First label of a cloud host's hostname: acme.semantius.cloud → acme. */
export function orgFromHost(host: string): string {
  return new URL(`https://${host}`).hostname.split('.')[0];
}

/** Mode of the configured host, or null when no host is configured. */
export function getHostMode(): HostFacts['mode'] | null {
  const host = getHost();
  if (!host) return null;
  return isCloudHost(host) ? 'cloud' : 'selfhosted';
}

/**
 * On a cloud host, make ${PREFIX}_ORG the host's org (the host wins over an
 * ORG from .env). getDefaultConfig() still interpolates ${PREFIX}_ORG into
 * the cube URL and the remote crud MCP URL.
 */
export function propagateOrg(): void {
  const host = getHost();
  if (host && isCloudHost(host)) {
    process.env[prefixedEnvName('ORG')] = orgFromHost(host);
  }
}

// ============================================================================
// Resolution
// ============================================================================

// One resolution per host per process: `list` and `-md` connect to several
// servers in parallel, and each crud connection would otherwise repeat it.
const _resolved = new Map<string, Promise<HostFacts>>();

/**
 * Resolve the configured host into the facts the local crud layer needs.
 * Cloud hosts consult the control plane (cached on disk); self-hosted hosts
 * derive everything from fixed paths.
 */
export function resolveHost(): Promise<HostFacts> {
  let host: string | null;
  try {
    host = getHost();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!host) {
    return Promise.reject(
      new HostResolutionError(
        `no host configured: set ${prefixedEnvName('ORG')} or --host`,
      ),
    );
  }
  return resolveHostFacts(host);
}

/**
 * Resolve an arbitrary, already-normalized host into HostFacts — independent
 * of the configured-host machinery above. Used by `semantius use <host>` to
 * resolve the host it is about to log in to, before it becomes the current
 * one (so getHost()/resolveHostValue() cannot see it yet).
 */
export function resolveHostFacts(host: string): Promise<HostFacts> {
  let pending = _resolved.get(host);
  if (!pending) {
    pending = isCloudHost(host)
      ? resolveCloudHost(host)
      : Promise.resolve(selfHostedFacts(host));
    _resolved.set(host, pending);
    const key = host;
    pending.catch(() => _resolved.delete(key));
  }
  return pending;
}

function selfHostedFacts(host: string): HostFacts {
  const base = hostBaseUrl(host);
  return {
    mode: 'selfhosted',
    host,
    org: null,
    tenantId: null,
    postgrestUrl: `${base}/rest`,
    discoveryUrl: `${base}/.well-known/oauth-protected-resource`,
    tokenExchange: { method: 'GET', url: `${base}/api/auth/token` },
    clientId: SELF_HOSTED_CLIENT_ID,
    apiBaseUrl: `${base}/api`,
    uiBaseUrl: base,
  };
}

async function resolveCloudHost(host: string): Promise<HostFacts> {
  const org = orgFromHost(host);
  const record =
    readHostCache(host) ?? (await fetchControlPlaneRecord(host, org));
  return {
    mode: 'cloud',
    host,
    org,
    tenantId: record.id,
    postgrestUrl: record.postgrest_url.replace(/\/+$/, ''),
    discoveryUrl: `https://${org}${CLOUD_SUFFIX}/.well-known/oauth-protected-resource`,
    tokenExchange: {
      method: 'POST',
      url: `https://${org}${CLOUD_SUFFIX}/token`,
    },
    clientId: record.client_id_cli,
    apiBaseUrl: `https://${org}.semantius.ai`,
    uiBaseUrl: `https://${org}.semantius.app`,
  };
}

/** The control-plane fields the CLI uses — nothing else is cached (no secrets). */
interface ControlPlaneRecord {
  id: string;
  postgrest_url: string;
  client_id_cli: string | null;
}

async function fetchControlPlaneRecord(
  host: string,
  org: string,
): Promise<ControlPlaneRecord> {
  const url = `${CONTROL_PLANE_URL}/organization/${encodeURIComponent(org)}`;
  debug(`Resolving organization "${org}" from the control plane: ${url}`);

  let response: Response;
  try {
    const timeoutMs = getConnectTimeoutMs();
    response = await fetch(
      url,
      timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
  } catch (error) {
    throw new HostResolutionError(
      `could not reach the Semantius control plane (${url}): ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new HostResolutionError(
        `organization "${org}" not found on the Semantius control plane (${url} returned 404)`,
      );
    }
    const body = (await response.text().catch(() => '')).slice(0, 200);
    throw new HostResolutionError(
      `the Semantius control plane returned ${response.status} for ${url}${body ? `: ${body}` : ''}`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HostResolutionError(`unexpected response from ${url}: not JSON`);
  }
  if (
    typeof data?.postgrest_url !== 'string' ||
    !data.postgrest_url ||
    (typeof data.id !== 'string' && typeof data.id !== 'number')
  ) {
    throw new HostResolutionError(
      `unexpected response from ${url}: missing postgrest_url or id`,
    );
  }

  const record: ControlPlaneRecord = {
    id: String(data.id),
    postgrest_url: data.postgrest_url,
    client_id_cli:
      typeof data.client_id_cli === 'string' ? data.client_id_cli : null,
  };
  writeHostCache(host, record);
  return record;
}

// ============================================================================
// On-disk cache (cloud only)
// ============================================================================

let _cacheDirOverride: string | undefined;

/** Test seam: redirect the host cache away from the real user config dir. */
export function setHostCacheDirForTests(dir: string | undefined): void {
  _cacheDirOverride = dir;
  _resolved.clear();
}

/**
 * <user config dir>/hosts/<host>.json, with ":" and "/" in the host replaced
 * by "_" so the name is valid on Windows.
 */
export function getHostCachePath(host: string): string {
  const dir = _cacheDirOverride ?? join(getUserConfigDir(), 'hosts');
  return join(dir, `${host.replace(/[:/]/g, '_')}.json`);
}

interface HostCacheEntry {
  fetched_at: string;
  /**
   * The control-plane record. Absent on a self-hosted host, which has no
   * control plane to consult: there the entry exists only to cache `oauth`.
   */
  record?: ControlPlaneRecord;
  /** Discovered OAuth endpoints; absent until a login or a session refresh. */
  oauth?: OAuthMetadata;
  /**
   * The instance's platform document, or the marker that it serves none.
   * Self-hosted only: a cloud host is configured by the control plane.
   */
  platform?: CachedPlatform;
}

/** The cache entry if it exists and is still within the TTL. */
function readHostCacheEntry(host: string): HostCacheEntry | null {
  const path = getHostCachePath(host);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as HostCacheEntry;
    const fetchedAt = Date.parse(entry.fetched_at);
    // Without this an unparseable date makes every comparison below false, so
    // the entry would never expire. It governs the self-hosted OAuth metadata
    // too, which has no record whose own check would have caught it.
    if (Number.isNaN(fetchedAt)) {
      debug(`Host cache has an unreadable date: ${path}`);
      return null;
    }
    if (Date.now() - fetchedAt >= HOST_CACHE_TTL_MS) {
      debug(`Host cache expired: ${path}`);
      return null;
    }
    return entry;
  } catch (error) {
    debug(`Host cache read failed (${path}): ${(error as Error).message}`);
    return null;
  }
}

/** Discovered OAuth endpoints for a host, or null when not cached (yet). */
export function readCachedOAuthMetadata(host: string): OAuthMetadata | null {
  const oauth = readHostCacheEntry(host)?.oauth;
  if (
    !oauth?.issuer ||
    !oauth.authorizationEndpoint ||
    !oauth.tokenEndpoint ||
    // An entry written before the field existed: refetch rather than assume.
    typeof oauth.issParameterSupported !== 'boolean'
  ) {
    return null;
  }
  return { ...oauth, resourceScopes: oauth.resourceScopes ?? [] };
}

/**
 * Store discovered OAuth endpoints for a host, sharing the 24 h TTL and
 * --reset-cache of its control-plane record.
 *
 * A self-hosted host has no record to hang them on, so the entry is created
 * holding only the endpoints. Without this, discovery re-ran on every single
 * invocation there: the write was dropped, so the read could never hit.
 */
export function writeCachedOAuthMetadata(
  host: string,
  oauth: OAuthMetadata,
): void {
  const entry = readHostCacheEntry(host);
  // Keep fetched_at: caching endpoints must not extend the record's TTL.
  // Without an entry there is no record whose TTL could be extended, so the
  // endpoints start their own 24 h window here.
  //
  // readHostCacheEntry reports an absent, expired and unreadable file alike,
  // so a file that cannot be read is replaced rather than preserved. On a
  // cloud host that discards a record which was expired or corrupt anyway:
  // the next invocation refetches it (one request) and rewrites the entry.
  writeHostCacheEntry(
    host,
    entry
      ? { ...entry, oauth }
      : { fetched_at: new Date().toISOString(), oauth },
  );
}

/**
 * The cached platform slot for a host: the config, the `{absent:true}` marker,
 * or null when nothing usable is cached (never written, expired, or written by
 * a version before the shape below).
 *
 * The marker is checked first and returned as-is. Testing the shape guard
 * against it would report it as malformed, and an un-upgraded deployment would
 * then refetch on every single invocation — which is the one thing the
 * negative cache exists to prevent.
 */
export function readCachedPlatformConfig(host: string): CachedPlatform | null {
  const platform = readHostCacheEntry(host)?.platform;
  if (!platform) return null;
  if ('absent' in platform) return platform.absent === true ? platform : null;
  if (
    typeof platform.docVersion !== 'number' ||
    !platform.docUrl ||
    !platform.idpWellKnown ||
    !platform.clientId
  ) {
    // Written before a field existed: refetch rather than assume.
    debug(`Cached platform config for ${host} has an old shape; refetching`);
    return null;
  }
  return {
    ...platform,
    redirects: platform.redirects ?? [],
    scope: platform.scope ?? '',
  };
}

/**
 * Store the platform config — or the absence marker — for a host, sharing the
 * 24 h TTL and --reset-cache of everything else in the entry. Mirrors
 * writeCachedOAuthMetadata, including preserving fetched_at so caching this
 * cannot extend a control-plane record's TTL.
 */
export function writeCachedPlatformConfig(
  host: string,
  platform: CachedPlatform,
): void {
  const entry = readHostCacheEntry(host);
  if (!entry) {
    writeHostCacheEntry(host, {
      fetched_at: new Date().toISOString(),
      platform,
    });
    return;
  }
  // Which chain discovered the cached endpoints is decided by this config, so
  // a config that changes the answer invalidates them. Without this, a host
  // that starts — or stops — serving the document keeps up to 24 h of
  // endpoints found by the other chain, and pairs them with this one's client
  // id and audience.
  const next = { ...entry, platform };
  if (platformSignature(entry.platform) !== platformSignature(platform)) {
    debug(
      `Platform configuration for ${host} changed; rediscovering endpoints`,
    );
    next.oauth = undefined;
  }
  writeHostCacheEntry(host, next);
}

/** What about a cached platform slot decides where the endpoints come from. */
function platformSignature(value: CachedPlatform | undefined): string {
  if (!value) return '(none)';
  if ('absent' in value) return '(absent)';
  return `${value.idpWellKnown}\u0000${value.clientId}`;
}

function readHostCache(host: string): ControlPlaneRecord | null {
  const path = getHostCachePath(host);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as HostCacheEntry;
    const fetchedAt = Date.parse(entry.fetched_at);
    const { record } = entry;
    // An entry written for its `oauth` alone carries no record. Only cloud
    // hosts reach this function, and theirs is always written record-first,
    // so treat it as a miss rather than as corruption.
    if (!record) return null;
    if (
      Number.isNaN(fetchedAt) ||
      typeof record.id !== 'string' ||
      typeof record.postgrest_url !== 'string'
    ) {
      debug(`Host cache has an invalid shape: ${path}`);
      return null;
    }
    if (Date.now() - fetchedAt >= HOST_CACHE_TTL_MS) {
      debug(`Host cache expired: ${path}`);
      return null;
    }
    return {
      id: record.id,
      postgrest_url: record.postgrest_url,
      client_id_cli: record.client_id_cli ?? null,
    };
  } catch (error) {
    debug(`Host cache read failed (${path}): ${(error as Error).message}`);
    return null;
  }
}

function writeHostCache(host: string, record: ControlPlaneRecord): void {
  writeHostCacheEntry(host, {
    fetched_at: new Date().toISOString(),
    record,
  });
}

/** Atomic write (temp file + rename), mode 0600. Failures only cost a refetch. */
function writeHostCacheEntry(host: string, entry: HostCacheEntry): void {
  const path = getHostCachePath(host);
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmpPath, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch (error) {
    debug(`Host cache write failed (${path}): ${(error as Error).message}`);
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp file may not exist
    }
  }
}

/** Delete the cached control-plane record for a host; returns its path. */
export function deleteHostCache(host: string): string {
  const path = getHostCachePath(host);
  try {
    unlinkSync(path);
  } catch {
    // not present
  }
  _resolved.delete(host);
  return path;
}
