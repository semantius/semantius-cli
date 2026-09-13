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
  type HostFacts,
  type OAuthMetadata,
  deleteHostCache,
  resolveHost,
} from '../host.js';
import { hasHost, recordHost } from '../hosts-index.js';
import { logTokenEvent } from '../logger.js';
import { buildScope, getOAuthMetadata } from './provider.js';
import {
  createSecretStorage,
  expireStoredAccessTokens,
  sessionName,
} from './storage.js';

/** Redirect ports registered for the CLI's OAuth client, in order. */
const CALLBACK_PORTS = [53682, 53683, 53684];

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
  constructor(message: string, suggestion?: string) {
    super(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'NOT_AVAILABLE',
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

  if (opts.forceRefresh) {
    await expireStoredAccessTokens(storage);
  } else {
    const cached = freshAccessToken(host, stored);
    if (cached) {
      debug(`Using the cached access token stored for ${host.host}`);
      return cached;
    }
  }

  const auth = await createAuth(host, storage);
  debug(`Using the OAuth session stored for ${host.host}`);
  return auth.getToken(tokenOptions(host));
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
 */
function freshAccessToken(host: HostFacts, stored: TokenSet): string | null {
  const cached = stored.tokens?.[cacheKey(host)];
  if (!cached?.access_token || typeof cached.expires_at !== 'number') {
    return null;
  }
  const refreshDueAt = cached.expires_at - TOKEN_REFRESH_THRESHOLD_S * 1000;
  return Date.now() >= refreshDueAt ? null : cached.access_token;
}

/**
 * How cli-auth keys a cached access token within the token set: the request
 * options rendered as "resource=<uri>", empty when there is no resource
 * indicator (every self-hosted host, which has no tenant id). The CLI never
 * passes extraParams, the key's other ingredient.
 */
function cacheKey(host: HostFacts): string {
  const { resource } = tokenOptions(host);
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
  // Rediscover: a login is rare, and starting it from a cached issuer would
  // fail the callback check below against endpoints the host may have changed.
  const metadata = await getOAuthMetadata(facts, { rediscover: true });
  const open = opts.openUrl ?? openBrowser;

  // The callback is checked as it arrives (so the browser sees the outcome),
  // but cli-auth decides success on its own and has exchanged the code by the
  // time login() resolves — hence the second look, and the clear, below.
  let issuerError: string | undefined;
  const auth = await createAuth(facts, storage, {
    callbackPort: pickCallbackPort(),
    check: (callbackUrl) => {
      issuerError = issuerMismatch(metadata, callbackUrl);
      return issuerError;
    },
  });

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

  // logout() revokes through the provider; without reachable endpoints the
  // local session must still go away.
  try {
    const auth = await createAuth(host, storage);
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

/** The loopback leg of a login: which port, and how its callback is verified. */
interface LoginFlow {
  callbackPort: number;
  /** Returns what is wrong with the callback, or undefined when it is sound. */
  check: (callbackUrl: URL) => string | undefined;
}

async function createAuth(
  host: HostFacts,
  storage: ReturnType<typeof storageFor>,
  flow?: LoginFlow,
): Promise<Auth> {
  const metadata = await getOAuthMetadata(host);
  return createCliAuth({
    ...(flow
      ? {
          callbackPort: flow.callbackPort,
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
    clientId: host.clientId as string,
    scope: buildScope(metadata),
    storage,
    tokenRefreshThreshold: TOKEN_REFRESH_THRESHOLD_S,
    fetch: tokenLoggingFetch(metadata.tokenEndpoint),
    ...(resourceIndicator(host) ? { resource: resourceIndicator(host) } : {}),
  });
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
 * RFC 8707 resource indicator, sent on the authorize and token requests.
 *
 * Without it the tenant's auth server issues a token for the MCP server
 * (`aud: [<host>/mcp, …/userinfo]`) and PostgREST rejects it with "required
 * audience not found". `tenant://<tenant id>` is the audience the API-key
 * tokens carry as well, and the only resource the server accepts.
 */
function resourceIndicator(host: HostFacts): string | undefined {
  return host.tenantId ? `tenant://${host.tenantId}` : undefined;
}

/**
 * Every getToken() passes the indicator explicitly: cli-auth keys its token
 * cache by the per-call options, not by the config's default, so without it a
 * token cached for another audience (or from an older version) would be
 * served unchanged until it expires.
 */
function tokenOptions(host: HostFacts): { resource?: string } {
  const resource = resourceIndicator(host);
  return resource ? { resource } : {};
}

// ============================================================================
// Loopback callback
// ============================================================================

/** The first free registered redirect port — they are fixed at the provider. */
function pickCallbackPort(): number {
  for (const port of CALLBACK_PORTS) {
    try {
      const probe = Bun.listen({
        hostname: '127.0.0.1',
        port,
        socket: { data() {} },
      });
      probe.stop(true);
      return port;
    } catch {
      debug(`Callback port ${port} is in use`);
    }
  }
  throw new LoginFailedError(
    `ports ${CALLBACK_PORTS[0]}-${CALLBACK_PORTS[CALLBACK_PORTS.length - 1]} are in use`,
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
