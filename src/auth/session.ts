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

function storageFor(host: HostFacts) {
  return createSecretStorage(sessionName(host.host));
}

/** The stored token set for this host, or undefined when never logged in. */
async function loadSession(host: HostFacts): Promise<TokenSet | undefined> {
  const stored = await storageFor(host).load();
  return stored && Object.keys(stored.tokens ?? {}).length > 0
    ? stored
    : undefined;
}

/** Whether a session is stored for this host (no network, no validation). */
export async function hasStoredSession(host: HostFacts): Promise<boolean> {
  return (await loadSession(host)) !== undefined;
}

/**
 * When the stored access token expires, as an ISO string — what `whoami`
 * shows. The refresh token typically outlives it.
 */
export async function getSessionExpiry(
  host: HostFacts,
): Promise<string | undefined> {
  const stored = await loadSession(host);
  const expiries = Object.values(stored?.tokens ?? {})
    .map((t) => t.expires_at)
    .filter((e): e is number => typeof e === 'number' && e > 0);
  return expiries.length
    ? new Date(Math.min(...expiries)).toISOString()
    : undefined;
}

/**
 * A bearer token from the stored session, or null when no session is stored.
 * cli-auth refreshes on its own 300 s before expiry; `forceRefresh` expires
 * the cached access token first so the refresh token is spent immediately.
 */
export async function getSessionToken(
  host: HostFacts,
  opts: { forceRefresh?: boolean } = {},
): Promise<string | null> {
  const storage = storageFor(host);
  const stored = await storage.load();
  if (!stored || Object.keys(stored.tokens ?? {}).length === 0) return null;

  if (opts.forceRefresh) await expireStoredAccessTokens(storage);

  const auth = await createAuth(host, storage);
  debug(`Using the OAuth session stored for ${host.host}`);
  return auth.getToken(tokenOptions(host));
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
  const storage = storageFor(facts);
  const metadata = await getOAuthMetadata(facts);
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
  const storage = storageFor(host);
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
    ...(resourceIndicator(host) ? { resource: resourceIndicator(host) } : {}),
  });
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
