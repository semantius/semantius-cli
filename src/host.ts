/**
 * Host / server resolution.
 *
 * One host value decides where the CLI talks to. Precedence: --host →
 * ${PREFIX}_HOST (shell env, then project .env, then the global .env —
 * loadDotEnv never overrides a set variable) → <${PREFIX}_ORG>.semantius.cloud.
 *
 * A host is a bare hostname[:port]; the CLI picks the protocol (hostBaseUrl).
 * A host matching *.semantius.cloud is the managed cloud: the org is its first
 * label and the control plane supplies the tenant's PostgREST URL, tenant id
 * and CLI OAuth client id (cached on disk for 24 h). Any other host is
 * self-hosted and resolves from fixed paths without network I/O.
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
  debug,
  getConnectTimeoutMs,
  getHostFlag,
  getPrefixedEnv,
  getUserConfigDir,
  prefixedEnvName,
} from './config.js';
import { ErrorCode, formatCliError } from './errors.js';

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
 * OAuth client id of the CLI on self-hosted instances. Unlike the cloud, where
 * the control plane publishes a per-org client id, every instance registers the
 * CLI under this same fixed id (a public native client with the loopback
 * redirect URIs). A host that has not registered it cannot be logged in to.
 */
export const SELF_HOSTED_CLIENT_ID: string | null = 'semantius-cli';

/**
 * The OAuth endpoints of a host, discovered from its .well-known documents:
 * the issuer and resource scopes come from the RFC 9728 protected-resource
 * document, the endpoints from that issuer's RFC 8414 metadata.
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

/** Hostnames reached over plain HTTP: local dev and test servers. */
function isLoopback(hostname: string): boolean {
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
 * The configured host (normalized), or null when none is configured:
 * --host, then ${PREFIX}_HOST, then the managed-cloud default for ${PREFIX}_ORG.
 */
export function getHost(): string | null {
  const flag = getHostFlag();
  if (flag) return normalizeHost(flag);
  const env = getPrefixedEnv('HOST');
  if (env) return normalizeHost(env);
  const org = getPrefixedEnv('ORG');
  if (org) return `${org}${CLOUD_SUFFIX}`;
  return null;
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
  record: ControlPlaneRecord;
  /** Discovered OAuth endpoints; absent until a login or a session refresh. */
  oauth?: OAuthMetadata;
}

/** The cache entry if it exists and is still within the TTL. */
function readHostCacheEntry(host: string): HostCacheEntry | null {
  const path = getHostCachePath(host);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as HostCacheEntry;
    if (Date.now() - Date.parse(entry.fetched_at) >= HOST_CACHE_TTL_MS) {
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
 * Store discovered OAuth endpoints alongside the host's control-plane record,
 * sharing its 24 h TTL and --reset-cache. Never called for a host without a
 * cache entry (self-hosted), where discovery simply runs per invocation.
 */
export function writeCachedOAuthMetadata(
  host: string,
  oauth: OAuthMetadata,
): void {
  const entry = readHostCacheEntry(host);
  if (!entry) return;
  // Keep fetched_at: caching endpoints must not extend the record's TTL.
  writeHostCacheEntry(host, { ...entry, oauth });
}

function readHostCache(host: string): ControlPlaneRecord | null {
  const path = getHostCachePath(host);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as HostCacheEntry;
    const fetchedAt = Date.parse(entry.fetched_at);
    const { record } = entry;
    if (
      Number.isNaN(fetchedAt) ||
      typeof record?.id !== 'string' ||
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
