/**
 * The OAuth session for a host: authorization code + PKCE via cli-auth, one
 * stored session per (env prefix, host).
 *
 * Nothing here opens a browser on its own. `semantius login` runs the flow;
 * every other command only reads an existing session, and its absence is a
 * NoCredentialsError (exit 5), never an implicit login.
 */

import { type TokenSet, createCliAuth } from 'cli-auth';
import { debug, prefixedEnvName } from '../config.js';
import { ErrorCode, formatCliError } from '../errors.js';
import {
  type CachedPlatform,
  type HostFacts,
  HostResolutionError,
  type OAuthMetadata,
  deleteHostCache,
  readCachedOAuthMetadata,
  readCachedPlatformConfig,
  resolveHost,
} from '../host.js';
import { hasHost, recordHost } from '../hosts-index.js';
import { logTokenEvent } from '../logger.js';
import {
  type PlatformConfig,
  configOrNull,
  getPlatformConfig,
  platformDocUrl,
} from './platform.js';
import { buildScope, getOAuthMetadata } from './provider.js';
import {
  createSecretStorage,
  expireStoredAccessTokens,
  sessionName,
} from './storage.js';

/** Where the browser sends the authorization code back to. */
interface Callback {
  port: number;
  path: string;
}

/**
 * The loopback callbacks a host that publishes none is assumed to have
 * registered — the ports every instance registered before the platform
 * document existed, in order.
 */
const DEFAULT_CALLBACKS: ReadonlyArray<Callback> = [53682, 53683, 53684].map(
  (port) => ({ port, path: '/callback' }),
);

/** How long the browser flow may take before the CLI gives up. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Seconds of remaining lifetime below which a cached access token counts as
 * expired. This is cli-auth's own default, named here because two code paths
 * must agree on it: the cache-only read in getSessionToken and the full Auth
 * it falls back to. If they disagreed, the cache-only read could serve a
 * token the refreshing path considers stale, or skip a refresh that is due.
 */
const TOKEN_REFRESH_THRESHOLD_S = 300;

type Auth = ReturnType<typeof createCliAuth<'authorization-code'>>;

/**
 * A login is not possible for this host at all (no CLI client registered for
 * it). Exit 1 — it is a configuration fact, not a credential that could be
 * supplied.
 */
export class LoginUnavailableError extends Error {
  readonly exitCode = ErrorCode.CLIENT_ERROR;
  /**
   * `type` names which fact makes the login impossible. It defaults to the
   * host-configuration one; UNSUPPORTED_VERSION is a fact about this CLI
   * being too old, which is a different thing for the reader to act on.
   */
  constructor(message: string, suggestion?: string, type = 'NOT_AVAILABLE') {
    super(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type,
        message,
        suggestion,
      }),
    );
    this.name = 'LoginUnavailableError';
  }
}

/** The browser flow itself failed (ports, timeout, provider error). Exit 1. */
export class LoginFailedError extends Error {
  readonly exitCode = ErrorCode.CLIENT_ERROR;
  constructor(detail: string) {
    super(`Error [LOGIN_FAILED]: ${detail}`);
    this.name = 'LoginFailedError';
  }
}

// ============================================================================
// Stored session
// ============================================================================

function storageFor(host: string, opts: { quiet?: boolean } = {}) {
  return createSecretStorage(sessionName(host), undefined, opts);
}

/** The stored token set for this host name, or undefined when never logged in. */
async function loadSessionFor(
  host: string,
  opts: { quiet?: boolean } = {},
): Promise<TokenSet | undefined> {
  const stored = await storageFor(host, opts).load();
  return stored && Object.keys(stored.tokens ?? {}).length > 0
    ? stored
    : undefined;
}

/**
 * Whether a session is stored for this host name (no network, no resolution
 * — unlike hasStoredSession, it needs no HostFacts). Used by "semantius
 * hosts", which probes every indexed host and must not print the keyring
 * fallback announcement once per host (see createSecretStorage's `quiet`).
 */
export async function hasStoredSessionFor(host: string): Promise<boolean> {
  return (await loadSessionFor(host, { quiet: true })) !== undefined;
}

/** getSessionExpiry, in terms of a host name rather than resolved HostFacts. */
export async function getSessionExpiryFor(
  host: string,
): Promise<string | undefined> {
  const stored = await loadSessionFor(host, { quiet: true });
  const expiries = Object.values(stored?.tokens ?? {})
    .map((t) => t.expires_at)
    .filter((e): e is number => typeof e === 'number' && e > 0);
  return expiries.length
    ? new Date(Math.min(...expiries)).toISOString()
    : undefined;
}

/** Whether a session is stored for this host (no network, no validation). */
export async function hasStoredSession(host: HostFacts): Promise<boolean> {
  return (await loadSessionFor(host.host)) !== undefined;
}

/**
 * When the stored access token expires, as an ISO string — what `whoami`
 * shows. The refresh token typically outlives it.
 */
export async function getSessionExpiry(
  host: HostFacts,
): Promise<string | undefined> {
  const stored = await loadSessionFor(host.host);
  const expiries = Object.values(stored?.tokens ?? {})
    .map((t) => t.expires_at)
    .filter((e): e is number => typeof e === 'number' && e > 0);
  return expiries.length
    ? new Date(Math.min(...expiries)).toISOString()
    : undefined;
}

/**
 * A bearer token from the stored session, or null when no session is stored.
 *
 * A cached access token that is still fresh is served without the
 * authorization server's metadata: only a refresh needs the token endpoint,
 * so only a refresh should pay for discovering it. Before this, every
 * invocation built an Auth — and therefore ran discovery — one line before
 * asking whether a refresh was needed at all. On a cloud host that was a read
 * of the on-disk host cache; on a self-hosted host, which has no such cache
 * entry, it was two HTTP round trips per command whose result was discarded.
 *
 * cli-auth refreshes on its own TOKEN_REFRESH_THRESHOLD_S before expiry;
 * `forceRefresh` expires the cached access token first so the refresh token is
 * spent immediately.
 */
export async function getSessionToken(
  host: HostFacts,
  opts: { forceRefresh?: boolean } = {},
): Promise<string | null> {
  const storage = storageFor(host.host);
  const stored = await storage.load();
  if (!stored || Object.keys(stored.tokens ?? {}).length === 0) return null;

  // Self-heal the host index: a session found here was stored by a login
  // this machine's index may predate (an older CLI version, or a keyring
  // entry from before hosts.json existed). hasHost() is a cheap, synchronous,
  // cached read, so this costs nothing once the index already knows the host.
  if (!hasHost(host.host)) {
    recordHost(host.host, { mode: host.mode, org: host.org });
  }

  const docUrl = platformDocUrl(host);
  if (opts.forceRefresh) {
    await expireStoredAccessTokens(storage);
  } else {
    // Cache only, so a fresh token still costs no network.
    const cached = docUrl ? readCachedPlatformConfig(host.host) : null;
    if (resourceIsKnown(host, docUrl, cached, stored)) {
      const token = freshAccessToken(
        resourceIndicator(host, cached ? configOrNull(cached) : null),
        stored,
      );
      if (token) {
        debug(`Using the cached access token stored for ${host.host}`);
        return token;
      }
    }
  }

  // Re-derived from the config this call resolved, never from the sync read
  // above: on a miss the two differ, and cli-auth would then refresh with no
  // resource at all and store the result under the empty key.
  const platform = await getPlatformConfig(host);
  requireHonestResource(host, platform, stored, docUrl);
  const resource = resourceIndicator(host, platform);
  const metadata = await getOAuthMetadata(host, { platform });
  const auth = createAuth(host, storage, { metadata, platform });
  debug(`Using the OAuth session stored for ${host.host}`);
  return auth.getToken(tokenOptions(resource));
}

/**
 * Whether the cache-only read above knows which resource this host's tokens
 * are keyed by, and may therefore trust what it finds.
 *
 * The danger is one specific gap: the platform state is unknown — never
 * fetched, or the 24 h TTL rolled over — so the indicator comes out undefined
 * and the lookup lands on the empty cache key, where cli-auth puts the first
 * token of every session whatever resource it asked for. On a host with an
 * audience that entry is a token minted for it, and serving it while the
 * document says otherwise is exactly the mix-up this design exists to avoid.
 *
 * The stored keys settle it without a network call: a session that has ever
 * been keyed by a resource belongs to a host that has an audience. When that
 * is so and the platform state is unknown, this returns false and the slow
 * path resolves the document properly — one fetch, once per TTL.
 */
function resourceIsKnown(
  host: HostFacts,
  docUrl: string | null,
  cached: CachedPlatform | null,
  stored: TokenSet,
): boolean {
  // Cloud takes its indicator from HostFacts, and a host with no document has
  // nothing to be unsure about.
  if (docUrl === null || host.tenantId !== null) return true;
  if (cached !== null) return true;
  return !hasResourceKey(stored);
}

/** Whether any stored token is keyed by a resource indicator. */
function hasResourceKey(stored: TokenSet): boolean {
  return Object.keys(stored.tokens ?? {}).some((key) =>
    key.startsWith('resource='),
  );
}

/**
 * Refuse to serve — or mint — a token under the empty cache key on a host that
 * is known to have an audience.
 *
 * cli-auth stores the first token of a session under the empty key whatever
 * resource was requested, so that entry holds a token minted for whatever the
 * platform document said at login. If the instance later stops serving the
 * document *cleanly* — a 404, or a front door restarted into serving its web
 * app — the resource indicator becomes undefined, and both the cache read and
 * the refresh would quietly go back to that key: serving a token minted for
 * one audience to a server that wants another, and then minting more of them
 * with no resource at all.
 *
 * Reached only when the document resolved to a clean absence, which is why the
 * message blames the document not being served rather than its contents.
 * Cloud hosts are excluded: theirs comes from the control plane, which fails
 * loudly on its own.
 */
function requireHonestResource(
  host: HostFacts,
  platform: PlatformConfig | null,
  stored: TokenSet,
  docUrl: string | null,
): void {
  if (platform !== null || host.tenantId !== null || docUrl === null) return;
  if (!hasResourceKey(stored)) return;
  throw new HostResolutionError(
    `${host.host} no longer serves ${docUrl}, but the stored session was issued for the audience it named. Refusing to reuse it: the instance would be sent a token minted for a different audience. Run "semantius login --host ${host.host}" to sign in against the configuration it serves now.`,
  );
}

/**
 * The stored access token while it is still fresh, or null when a refresh is
 * due (or nothing usable is cached). Pure and synchronous: the token set is
 * already in hand, so this costs no storage read, no lock and no network.
 *
 * This reads the cache itself rather than asking cli-auth for the token with
 * its refresh hook withheld. That alternative makes cli-auth throw
 * `token.refresh_failed` to mean "a refresh is due" — and although the throw
 * is awaited and caught, Bun reports the momentarily-unhandled rejection and
 * aborts the CLI before the catch resumes. A control-flow signal must not
 * depend on an exception the runtime may treat as fatal.
 *
 * Both halves of the rule belong to cli-auth and must track it: the cache key
 * (see cacheKey) and the freshness test — expired once within
 * TOKEN_REFRESH_THRESHOLD_S of expiry, the same constant the Auth is built
 * with, so the two paths cannot disagree.
 *
 * cacheKey must stay derived from tokenOptions(): that is what makes it the
 * key the fallback would ask cli-auth for. Do not assume a mismatch is merely
 * a slow cache miss — a lookup under a key missing a component can *find* an
 * entry written for different parameters and serve a token minted for another
 * audience. Change tokenOptions and cacheKey together.
 *
 * Both take the already-resolved resource indicator rather than HostFacts, so
 * this stays pure and synchronous even though the indicator may come from a
 * document that had to be fetched. Resolve it once per invocation and thread
 * it through: a second derivation is a second chance to disagree.
 */
function freshAccessToken(
  resource: string | undefined,
  stored: TokenSet,
): string | null {
  const cached = stored.tokens?.[cacheKey(resource)];
  if (!cached?.access_token || typeof cached.expires_at !== 'number') {
    return null;
  }
  const refreshDueAt = cached.expires_at - TOKEN_REFRESH_THRESHOLD_S * 1000;
  return Date.now() >= refreshDueAt ? null : cached.access_token;
}

/**
 * How cli-auth keys a cached access token within the token set: the request
 * options rendered as "resource=<uri>", empty when there is no resource
 * indicator. The CLI never passes extraParams, the key's other ingredient.
 *
 * The empty key is not "self-hosted": a cloud host is keyed by its tenant, a
 * self-hosted instance by the audience in its platform document, and only an
 * instance that publishes no document (or publishes one with no audience) ends
 * up here. It is also where cli-auth's own `login()` puts the first token of
 * every session, which is why an unexplained hit on it is a warning sign —
 * see requireHonestResource.
 */
function cacheKey(resource: string | undefined): string {
  return resource ? `resource=${resource}` : '';
}

// ============================================================================
// Login / logout
// ============================================================================

/**
 * Run the browser login for this host and store the resulting session.
 * `openUrl` exists so tests can drive the flow without a real browser.
 */
export async function login(
  host: HostFacts,
  opts: { openUrl?: (url: string) => void } = {},
): Promise<void> {
  const facts = await requireLoginableHost(host);
  const storage = storageFor(facts.host);
  // Refetch both: a login is rare, and starting it from a cached client id or
  // issuer would fail the callback check below against configuration the host
  // may have changed. The platform document is resolved first — it decides
  // which discovery chain runs, and which client id the browser is sent with.
  const platform = await getPlatformConfig(facts, { refetch: true });
  const metadata = await getOAuthMetadata(facts, {
    rediscover: true,
    platform,
  });
  const open = opts.openUrl ?? openBrowser;

  // The callback is checked as it arrives (so the browser sees the outcome),
  // but cli-auth decides success on its own and has exchanged the code by the
  // time login() resolves — hence the second look, and the clear, below.
  let issuerError: string | undefined;
  // An empty list is "the document named none", not "no callbacks": a
  // document may omit redirect_uris entirely, and then the registered default
  // ports are what the instance expects.
  const callback = pickCallback(
    platform?.redirects.length ? platform.redirects : DEFAULT_CALLBACKS,
  );
  const auth = createAuth(
    facts,
    storage,
    { metadata, platform },
    {
      ...callback,
      check: (callbackUrl) => {
        issuerError = issuerMismatch(metadata, callbackUrl);
        return issuerError;
      },
    },
  );

  const flow = auth.login({
    onAuthorization: (url) => {
      console.error(`Opening the browser to sign in:\n${url}`);
      open(url);
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new LoginFailedError(
            `no response from the browser within ${LOGIN_TIMEOUT_MS / 60_000} minutes`,
          ),
        ),
      LOGIN_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([flow, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (issuerError) {
    // The response may come from an authorization server other than the one
    // this login was started against: keep nothing it produced.
    await storage.clear();
    throw new LoginFailedError(issuerError);
  }

  await labelStoredTokens(storage, resourceIndicator(facts, platform));
}

/**
 * Make the stored token set say what it actually holds: one host, one
 * audience, one access token.
 *
 * cli-auth's `login()` saves the token it has just obtained *without* the
 * options it obtained it with (`save(O)`, one argument — dist/index.js:349),
 * so a token minted for this host's audience is filed under the cache key that
 * means "no audience was requested". Left alone, one host ends up with two
 * entries for its single audience: the mislabelled login token, and the
 * correctly labelled one the first refresh produces. Every later lookup goes
 * by the label, so the mislabelled entry is a token waiting to be served to a
 * server that never asked for it.
 *
 * So put the login's token under the key for the audience it was really minted
 * for. Two things follow: the next command finds it instead of spending the
 * refresh token to mint a duplicate, and nothing is left behind for an
 * unlabelled lookup to find.
 *
 * Entries keyed for some *other* audience are dropped in the same pass: the
 * host's audience may have changed (or been withdrawn) since the last login,
 * and cli-auth merges into whatever is already stored rather than replacing
 * it, so they would otherwise outlive the session they belong to.
 */
async function labelStoredTokens(
  storage: ReturnType<typeof storageFor>,
  resource: string | undefined,
): Promise<void> {
  const stored = await storage.load();
  if (!stored?.tokens) return;
  const key = cacheKey(resource);

  // The token cli-auth just wrote under the empty key is this login's own, and
  // it supersedes everything already in the set: the refresh token it belongs
  // to has been replaced, so any older access token is an orphan whichever
  // audience it was for.
  const login = stored.tokens[''];
  const tokens = login
    ? { [key]: login }
    : Object.fromEntries(
        Object.entries(stored.tokens).filter(
          ([name]) => name === key || !name.startsWith('resource='),
        ),
      );

  if (
    Object.keys(tokens).length === Object.keys(stored.tokens).length &&
    Object.keys(tokens).every((name) => name in stored.tokens)
  ) {
    return;
  }
  debug(
    `Stored session holds one access token, keyed ${key || '(no audience)'}`,
  );
  await storage.save({ ...stored, tokens });
}

/**
 * RFC 9207: the `iss` on an authorization response must be the issuer of the
 * authorization server the request was sent to, compared as a plain string.
 * Returns what is wrong with it, or undefined when it is sound.
 *
 * The check is what stops a mix-up: a host whose metadata sends the browser to
 * one authorization server and the code to another token endpoint. PKCE does
 * not cover that, because the verifier goes to the same wrong endpoint.
 */
export function issuerMismatch(
  metadata: OAuthMetadata,
  callbackUrl: URL,
): string | undefined {
  const iss = callbackUrl.searchParams.get('iss');
  if (iss === null) {
    return metadata.issParameterSupported
      ? `the login callback carried no "iss", but ${metadata.issuer} promises one (authorization_response_iss_parameter_supported)`
      : undefined;
  }
  return iss === metadata.issuer
    ? undefined
    : `the login callback names issuer "${iss}", expected "${metadata.issuer}"`;
}

/** Revoke (best effort) and delete the stored session for this host. */
export async function logout(host: HostFacts): Promise<boolean> {
  const storage = storageFor(host.host);
  const stored = await storage.load();
  if (!stored) return false;

  // Discovery is worth a round trip only if there is something to revoke.
  // Where the login already cached the endpoints and they name no
  // revocation_endpoint — the common case on an IdP that publishes none —
  // there is nothing to ask for, and cli-auth would only clear the storage
  // this does.
  const cached = readCachedOAuthMetadata(host.host);
  if (cached && !cached.revocationEndpoint) {
    debug(`${host.host} publishes no revocation endpoint; clearing locally`);
    await storage.clear();
    return true;
  }

  // logout() revokes through the provider; without reachable endpoints the
  // local session must still go away. The client id may come from the platform
  // document, so read it — but only from the cache: a logout must not depend
  // on the instance still serving anything.
  try {
    const slot = readCachedPlatformConfig(host.host);
    const platform = slot ? configOrNull(slot) : null;
    const metadata = cached ?? (await getOAuthMetadata(host, { platform }));
    const auth = createAuth(host, storage, { metadata, platform });
    await auth.logout();
  } catch (error) {
    debug(`Revocation skipped: ${(error as Error).message}`);
    await storage.clear();
  }
  return true;
}

/**
 * The host a login can actually run against: any host with a CLI client id.
 * Self-hosted instances carry the fixed SELF_HOSTED_CLIENT_ID; cloud orgs get
 * theirs from the control plane, and a cached record from before the control
 * plane published client_id_cli is refetched once.
 *
 * This is the pre-discovery gate, so it knows nothing about the platform
 * document: on a self-hosted host it is vacuous, and the id it approved is
 * replaced by the document's own a moment later (see effectiveClientId).
 */
async function requireLoginableHost(host: HostFacts): Promise<HostFacts> {
  if (host.clientId) return host;

  // Self-hosted client ids are fixed, so there is nothing to refetch: only a
  // build without one lands here.
  if (host.mode === 'selfhosted') {
    throw new LoginUnavailableError(
      `OAuth login is not configured for ${host.host} (no CLI client id)`,
      `Use ${prefixedEnvName('API_KEY')} or ${prefixedEnvName('JWT')} for ${host.host}.`,
    );
  }

  debug('No client_id_cli on the cached record; refetching the control plane');
  deleteHostCache(host.host);
  const fresh = await resolveHost();
  if (fresh.clientId) return fresh;

  throw new LoginUnavailableError(
    `OAuth login is not enabled for ${host.org ?? host.host} (no CLI client on the control plane)`,
    `Use ${prefixedEnvName('API_KEY')} for this organization, or ask Semantius support to enable CLI login.`,
  );
}

/** The loopback leg of a login: where it listens, and how it is verified. */
interface LoginFlow extends Callback {
  /** Returns what is wrong with the callback, or undefined when it is sound. */
  check: (callbackUrl: URL) => string | undefined;
}

/**
 * Everything about the host that had to be resolved before an Auth can exist.
 *
 * Passed in rather than resolved here so that one invocation cannot build an
 * Auth from a different snapshot than the one it checked: `login` used to
 * discover once for its callback check and again inside this function, and the
 * two agreed only because discovery happens to write a disk cache. On a
 * read-only filesystem they would not have.
 */
interface ResolvedHost {
  metadata: OAuthMetadata;
  platform: PlatformConfig | null;
}

function createAuth(
  host: HostFacts,
  storage: ReturnType<typeof storageFor>,
  resolved: ResolvedHost,
  flow?: LoginFlow,
): Auth {
  const { metadata, platform } = resolved;
  const resource = resourceIndicator(host, platform);
  return createCliAuth({
    ...(flow
      ? {
          callbackPort: flow.port,
          callbackPath: flow.path,
          callbackSource: (res, result) => {
            const issuerError = flow.check(result.callbackUrl);
            const ok = result.success && !issuerError;
            debug(
              `Login callback: success=${result.success}${result.verifyError ? `, ${result.verifyError}` : ''}, iss=${result.callbackUrl.searchParams.get('iss') ?? '(none)'}${issuerError ? ` — rejected: ${issuerError}` : ''}`,
            );
            res.writeHead(ok ? 200 : 400, {
              'Content-Type': 'text/html; charset=utf-8',
            });
            res.end(
              ok
                ? `<h1>Signed in to ${host.host}</h1><p>You can close this tab and return to your terminal.</p>`
                : '<h1>Login failed</h1><p>You can close this tab; your terminal has the details.</p>',
            );
          },
        }
      : {}),
    strategy: 'authorization-code',
    provider: {
      metadata: {
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        revocationEndpoint: metadata.revocationEndpoint,
      },
    },
    clientId: effectiveClientId(host, platform),
    scope: buildScope(metadata, platform),
    storage,
    tokenRefreshThreshold: TOKEN_REFRESH_THRESHOLD_S,
    fetch: tokenLoggingFetch(metadata.tokenEndpoint),
    ...(resource ? { resource } : {}),
  });
}

/**
 * The client id to sign in with: the platform document's, or the one host
 * resolution supplied (the control plane's on cloud, the fixed legacy id on a
 * self-hosted instance that publishes no document).
 *
 * Throwing here is what keeps a missing id from being posted as the literal
 * string "null" and coming back as an opaque `unauthorized_client`.
 */
function effectiveClientId(
  host: HostFacts,
  platform: PlatformConfig | null,
): string {
  const clientId = platform?.clientId ?? host.clientId;
  if (!clientId) {
    throw new LoginUnavailableError(
      `OAuth login is not configured for ${host.host} (no CLI client id)`,
      `Use ${prefixedEnvName('API_KEY')} or ${prefixedEnvName('JWT')} for ${host.host}.`,
    );
  }
  return clientId;
}

/**
 * A `fetch` that records each request to the token endpoint. cli-auth performs
 * the refresh and the code exchange inside `getToken()`, so wrapping its fetch
 * is the only place the CLI can observe that a credential was actually spent —
 * and telling "served from cache" apart from "minted a new token" is exactly
 * what the log was missing.
 *
 * Only the token endpoint is logged, and only its grant type: the request body
 * carries the refresh token or the authorization code, and is never recorded.
 */
function tokenLoggingFetch(tokenEndpoint: string): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url !== tokenEndpoint) return globalThis.fetch(input, init);

    const grant = grantType(init?.body);
    const started = Date.now();
    debug(`Token request: POST ${url} (grant_type=${grant})`);
    try {
      const response = await globalThis.fetch(input, init);
      const durationMs = Date.now() - started;
      logTokenEvent({
        grant,
        url,
        outcome: response.ok ? 'success' : 'failure',
        status: response.status,
        durationMs,
      });
      debug(`Token request: ${response.status} in ${durationMs} ms`);
      return response;
    } catch (error) {
      logTokenEvent({
        grant,
        url,
        outcome: 'failure',
        durationMs: Date.now() - started,
        error: (error as Error).message,
      });
      throw error;
    }
  }) as typeof fetch;
}

/** The grant_type of a token request, read without retaining the body. */
function grantType(
  body: unknown,
): 'refresh_token' | 'authorization_code' | 'other' {
  const text =
    typeof body === 'string'
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : '';
  const grant = new URLSearchParams(text).get('grant_type');
  return grant === 'refresh_token' || grant === 'authorization_code'
    ? grant
    : 'other';
}

/**
 * RFC 8707 resource indicator, sent on the token requests (cli-auth never puts
 * it on the authorize URL).
 *
 * Without it the tenant's auth server issues a token for the MCP server
 * (`aud: [<host>/mcp, …/userinfo]`) and PostgREST rejects it with "required
 * audience not found". `tenant://<tenant id>` is the audience the API-key
 * tokens carry as well, and the only resource a cloud tenant accepts. A
 * self-hosted instance names its own in its platform document; an instance
 * that publishes none has no audience to ask for.
 */
function resourceIndicator(
  host: HostFacts,
  platform: PlatformConfig | null,
): string | undefined {
  return host.tenantId ? `tenant://${host.tenantId}` : platform?.audience;
}

/**
 * Every getToken() passes the indicator explicitly: cli-auth keys its token
 * cache by the per-call options, not by the config's default, so without it a
 * token cached for another audience (or from an older version) would be
 * served unchanged until it expires.
 */
function tokenOptions(resource: string | undefined): { resource?: string } {
  return resource ? { resource } : {};
}

// ============================================================================
// Loopback callback
// ============================================================================

/**
 * The first candidate whose port is free. The candidates are the redirect URIs
 * the instance registered, so this cannot invent one: an unregistered
 * redirect_uri is rejected by the authorization server.
 */
function pickCallback(candidates: ReadonlyArray<Callback>): Callback {
  for (const candidate of candidates) {
    try {
      const probe = Bun.listen({
        hostname: '127.0.0.1',
        port: candidate.port,
        socket: { data() {} },
      });
      probe.stop(true);
      return candidate;
    } catch {
      debug(`Callback port ${candidate.port} is in use`);
    }
  }
  throw new LoginFailedError(
    `every registered callback port is in use (${candidates.map((c) => c.port).join(', ')})`,
  );
}

/**
 * Best effort: the URL is printed too, so a failure here is not fatal.
 *
 * Windows goes through rundll32, not `cmd /c start`: cmd splits its command
 * line at the unquoted "&" of the query string, so `start` would open the
 * authorize URL truncated after the first parameter.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  } catch (error) {
    debug(`Could not open a browser: ${(error as Error).message}`);
  }
}
