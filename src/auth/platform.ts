/**
 * Self-hosted platform discovery: <host>/.well-known/semantius.json.
 *
 * An instance publishes there what no standard discovery document can carry:
 * the CLI's client id (a GUID where the IdP is not the bundled one), the
 * audience its API expects, the loopback redirect URIs it registered, and the
 * OIDC discovery URL of whichever IdP it is actually backed by. The CLI reads
 * that document; it never learns which IdP product is behind it. `idp_type` is
 * advisory — logged and quoted in errors, never branched on.
 *
 * Two things this module is careful about:
 *
 *  - **Clean absence is not failure.** A deployment that predates the document
 *    serves no document: 404, or its SPA catching the path and answering 200
 *    text/html. That is an answer — fall back to the legacy RFC 9728 chain and
 *    remember it, so the fallback costs one request per 24 h. A network error,
 *    a timeout or a 5xx is *not* an answer: it raises, because silently
 *    falling back would mean silently logging in with the wrong client id, or
 *    minting a token for the wrong audience.
 *  - **A document that parses but is empty is a failure.** A front door
 *    restarted rather than recreated answers valid JSON with every field
 *    empty. That is worse than a 404, because it parses.
 *
 * Results are cached in the host's cache file, in their own slot beside the
 * OAuth endpoints, sharing its 24 h TTL and --reset-cache.
 */

import { debug, getConnectTimeoutMs } from '../config.js';
import {
  type CachedPlatform,
  type HostFacts,
  HostResolutionError,
  type PlatformConfig,
  hostBaseUrl,
  isCloudHost,
  isLoopback,
  readCachedPlatformConfig,
  writeCachedPlatformConfig,
} from '../host.js';
import { LoginUnavailableError } from './session.js';

export type { PlatformConfig } from '../host.js';

/** The version of the document this CLI knows how to read. */
const SUPPORTED_VERSION = 1;

/** In-process memo of an in-flight or completed fetch, per host name. */
const _pending = new Map<string, Promise<PlatformConfig | null>>();

/**
 * Where this host's platform document would be, or null when the question does
 * not apply — the managed cloud, which the control plane configures.
 *
 * Deliberately a function of HostFacts rather than a field on it: the value is
 * derivable, and a field would leak through the object spreads that build
 * cloud fixtures from self-hosted ones.
 */
export function platformDocUrl(host: HostFacts): string | null {
  if (host.mode === 'cloud' || isCloudHost(host.host)) return null;
  // Taken from the origin discovery already starts at, not rebuilt from the
  // host name: the two .well-known documents of a host then cannot be looked
  // for on different origins. For a host resolved the normal way the two are
  // the same string — selfHostedFacts builds both from hostBaseUrl().
  let origin: string;
  try {
    origin = new URL(host.discoveryUrl).origin;
  } catch {
    origin = hostBaseUrl(host.host);
  }
  return `${origin}/.well-known/semantius.json`;
}

/**
 * The instance's platform configuration, or null when it serves no document
 * (and the legacy discovery chain applies). Throws when the document cannot be
 * fetched, or is served but unusable.
 *
 * Disk cache → in-process memo → fetch. `refetch` skips both, for `login`,
 * which re-establishes trust in the host from scratch.
 */
export function getPlatformConfig(
  host: HostFacts,
  opts: { refetch?: boolean } = {},
): Promise<PlatformConfig | null> {
  const docUrl = platformDocUrl(host);
  if (!docUrl) return Promise.resolve(null);

  if (opts.refetch) {
    _pending.delete(host.host);
  } else {
    const cached = readCachedPlatformConfig(host.host);
    if (cached) return Promise.resolve(configOrNull(cached));
    const pending = _pending.get(host.host);
    if (pending) return pending;
  }

  const pending = resolvePlatformConfig(host, docUrl);
  _pending.set(host.host, pending);
  pending.catch(() => _pending.delete(host.host));
  return pending;
}

/** Forget the in-process memo, so a test can prove the on-disk cache. */
export function clearPlatformMemoForTests(): void {
  _pending.clear();
}

/** The config in a cached slot, or null for the "serves no document" marker. */
export function configOrNull(cached: CachedPlatform): PlatformConfig | null {
  return 'absent' in cached ? null : cached;
}

async function resolvePlatformConfig(
  host: HostFacts,
  docUrl: string,
): Promise<PlatformConfig | null> {
  const result = await fetchDocument(docUrl);
  if (result.kind === 'absent') {
    debug(
      `No platform document at ${docUrl} (${result.why}); using the legacy discovery chain`,
    );
    writeCachedPlatformConfig(host.host, { absent: true });
    return null;
  }

  const config = parseDocument(result.json, docUrl, host);
  writeCachedPlatformConfig(host.host, config);
  return config;
}

type DocumentResult =
  | { kind: 'doc'; json: Record<string, unknown> }
  | { kind: 'absent'; why: string };

/**
 * GET the document, telling absence from failure.
 *
 * This cannot reuse provider.ts's fetchJson, which raises on both: here the
 * difference decides between a legitimate fallback and a hard error.
 */
async function fetchDocument(url: string): Promise<DocumentResult> {
  debug(`Platform discovery: GET ${url}`);
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

  if (response.status === 404) return { kind: 'absent', why: 'HTTP 404' };
  if (!response.ok) {
    throw new HostResolutionError(`${url} returned ${response.status}`);
  }

  // The un-upgraded deployment: the path falls through to the SPA, which
  // answers 200 with an HTML page.
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/([\w.-]+\+)?json\b/i.test(contentType.trim())) {
    return {
      kind: 'absent',
      why: `content-type ${contentType || '(none)'}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: 'absent', why: 'body is not JSON' };
  }
  // A JSON body that is not an object is not this document — a catch-all route
  // answering `[]` for every path is a deployment that serves no document, not
  // a deployment whose document is broken.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { kind: 'absent', why: `body is ${describe(json)}, not an object` };
  }
  return { kind: 'doc', json: json as Record<string, unknown> };
}

function describe(json: unknown): string {
  if (json === null) return 'null';
  return Array.isArray(json) ? 'an array' : `a ${typeof json}`;
}

/**
 * Validate and normalize the document.
 *
 * Shape is checked before version, so a front door serving empty fields is
 * reported as what it is rather than as a document from the future.
 */
function parseDocument(
  json: Record<string, unknown>,
  docUrl: string,
  host: HostFacts,
): PlatformConfig {
  const idpWellKnown = asString(json.idp_well_known);
  const clientId = asString(json.client_id_cli);
  if (!idpWellKnown || !clientId) {
    const missing = [
      idpWellKnown ? null : 'idp_well_known',
      clientId ? null : 'client_id_cli',
    ].filter((field): field is string => field !== null);
    throw new HostResolutionError(
      `${docUrl} is served, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty. A front door that was restarted rather than recreated serves the document with its variables unsubstituted; recreate it.`,
    );
  }

  // A version that is not a number at all is a malformed document, not a
  // document from the future: telling the operator to upgrade the CLI would
  // point at the wrong side of the wire. A front door that templates this file
  // and leaves {$VERSION} unsubstituted lands here.
  const { version } = json;
  if (typeof version !== 'number') {
    throw new HostResolutionError(
      `${docUrl} has no usable version (got ${JSON.stringify(version) ?? 'nothing'}); the document is malformed.`,
    );
  }
  if (version !== SUPPORTED_VERSION) {
    throw new LoginUnavailableError(
      `${docUrl} is version ${version}, which this CLI cannot read (it reads version ${SUPPORTED_VERSION})`,
      'Upgrade semantius-cli.',
      'UNSUPPORTED_VERSION',
    );
  }

  // Relative URLs resolve against the document's own URL. redirect_uris are
  // the exception: they are absolute loopback URLs on this machine.
  const wellKnown = resolveUrl(idpWellKnown, docUrl, 'idp_well_known');
  if (wellKnown.protocol !== 'https:' && !isLoopback(wellKnown.hostname)) {
    throw new HostResolutionError(
      `${docUrl} names a non-HTTPS idp_well_known: ${wellKnown.toString()}`,
    );
  }

  const config: PlatformConfig = {
    docUrl,
    docVersion: SUPPORTED_VERSION,
    idpType: asString(json.idp_type) ?? '(unspecified)',
    idpWellKnown: wellKnown.toString(),
    clientId,
    redirects: parseRedirects(json.redirect_uris, docUrl),
    scope: asString(json.scope) ?? '',
    ...optional('audience', asString(json.audience)),
    ...optional('gatewayUrl', absolutize(json.gateway_url, docUrl)),
    ...optional('apiUrl', absolutize(json.api_url, docUrl)),
  };

  debug(
    `Platform config for ${host.host}: idp_type ${config.idpType} (advisory), client ${config.clientId}, audience ${config.audience ?? '(none)'}, discovery ${config.idpWellKnown}`,
  );
  // Not consumed: postgrestUrl is derived without the network, deliberately.
  // A disagreement means that derivation has gone stale — say so once.
  if (config.apiUrl && config.apiUrl !== host.postgrestUrl) {
    debug(
      `Platform document says api_url ${config.apiUrl}, but the CLI derives ${host.postgrestUrl}; using the derived one`,
    );
  }
  return config;
}

/**
 * The loopback callbacks the CLI can actually serve, in the document's order,
 * deduped by port.
 *
 * cli-auth binds 127.0.0.1 and builds its redirect_uri from that same address,
 * with no option to change the host. A "localhost" URI is therefore not
 * skippable but unhonourable: dropping it and falling back to the default
 * ports produces a redirect_uri the instance never registered, and an error
 * from the IdP that blames the wrong thing.
 */
function parseRedirects(
  value: unknown,
  docUrl: string,
): ReadonlyArray<{ port: number; path: string }> {
  const uris = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : [];
  if (uris.length === 0) return [];

  const kept: Array<{ port: number; path: string }> = [];
  const rejected: string[] = [];
  const seen = new Set<number>();
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      rejected.push(uri);
      continue;
    }
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.search ||
      url.hash
    ) {
      rejected.push(uri);
      continue;
    }
    const port = Number(url.port);
    if (seen.has(port)) continue;
    seen.add(port);
    kept.push({ port, path: url.pathname });
  }

  if (kept.length === 0) {
    throw new LoginUnavailableError(
      `${docUrl} lists no redirect URI this CLI can use: ${rejected.join(', ')}`,
      'The CLI receives the login callback on 127.0.0.1, so a "localhost" redirect URI cannot be honoured. Register http://127.0.0.1:<port>/callback instead.',
    );
  }
  return kept;
}

function resolveUrl(value: string, base: string, field: string): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new HostResolutionError(
      `${base} names an invalid ${field}: "${value}"`,
    );
  }
}

/** A recorded-but-unconsumed URL field, resolved against the document. */
function absolutize(value: unknown, base: string): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

/** Spread-in helper: omit the key entirely rather than storing undefined. */
function optional<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
