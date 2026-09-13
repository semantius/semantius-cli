/**
 * Bearer token for the local crud layer, without the MCP server.
 *
 * Without --host, the environment is the profile; sources, first match wins:
 * ${PREFIX}_JWT (static, sent as-is) → ${PREFIX}_API_KEY (exchanged at the
 * host's token endpoint, cached per host) → the OAuth session stored for the
 * host → NoCredentialsError.
 * With --host, only credentials stored for that host apply (the OAuth
 * session); the environment's API key and JWT are never used.
 * --auth jwt|apikey|oauth forces one source for the invocation.
 * The MCP path (client.ts transformConfigWithJwt / resolveJwt) is separate.
 */

import { STATUS_CODES } from 'node:http';
import {
  debug,
  describeEnvVar,
  getAuthFlag,
  getEnvJwt,
  getHostFlag,
  getPrefixedEnv,
  prefixedEnvName,
} from '../config.js';
import { ErrorCode, formatCliError } from '../errors.js';
import type { HostFacts } from '../host.js';
import {
  type CachedToken,
  deleteCachedToken,
  isJwtCacheDisabled,
  readCachedToken,
  writeCachedToken,
} from '../jwt-cache.js';
import { logTokenEvent } from '../logger.js';

/**
 * No credential source is configured for the host. The message starts with
 * "Authentication required", which isAuthErrorMessage() maps to exit 5.
 */
export class NoCredentialsError extends Error {
  constructor(host: string, forced?: CredentialSource) {
    super(
      forced
        ? `Authentication required: --auth ${forced} was given but ${forcedSourceHint(forced, host)}`
        : getHostFlag()
          ? `Authentication required: no credentials stored for ${host}. Run "semantius login --host ${host}" (with --host, ${prefixedEnvName('API_KEY')} and ${prefixedEnvName('JWT')} are not used).`
          : `Authentication required: no credentials for ${host}. Set ${prefixedEnvName('API_KEY')} or run "semantius login".`,
    );
    this.name = 'NoCredentialsError';
  }
}

/** What --auth <source> asked for and did not find. */
function forcedSourceHint(forced: CredentialSource, host: string): string {
  if (forced === 'oauth') {
    return `no session is stored for ${host}. Run "semantius login${getHostFlag() ? ` --host ${host}` : ''}".`;
  }
  return `${prefixedEnvName(forced === 'jwt' ? 'JWT' : 'API_KEY')} is not set.`;
}

/**
 * The stored session could not be turned into a token: the refresh token is
 * expired or was revoked. Exit 5 like any other credential problem; a retry
 * with the same session cannot help, only a new login.
 */
export class SessionExpiredError extends Error {
  constructor(host: string, detail: string) {
    super(
      `Authentication required: the session stored for ${host} could not be refreshed (${detail}). Run "semantius login${getHostFlag() ? ` --host ${host}` : ''}" again.`,
    );
    this.name = 'SessionExpiredError';
  }
}

/**
 * The host refused the API key (401/403 at the token exchange): the key
 * belongs to another organization or was revoked. Names the host and where
 * the key came from; exit 5, and retrying cannot help.
 */
export class ApiKeyRejectedError extends Error {
  constructor(host: HostFacts, status: number, reason: string) {
    super(
      formatCliError({
        code: ErrorCode.AUTH_ERROR,
        type: 'API_KEY_REJECTED',
        message: `${host.host} rejected the API key in ${describeEnvVar(prefixedEnvName('API_KEY'))} (${status}${reason ? `: ${reason}` : ''})`,
        suggestion: `The key belongs to another organization or was revoked. Use an API key of ${host.org ?? host.host}.`,
      }),
    );
    this.name = 'ApiKeyRejectedError';
  }
}

/** Credential problems: reported as-is (no connection-failed wrapper), exit 5. */
export function isCredentialError(error: unknown): boolean {
  return (
    error instanceof NoCredentialsError ||
    error instanceof ApiKeyRejectedError ||
    error instanceof SessionExpiredError
  );
}

export type CredentialSource = 'jwt' | 'apikey' | 'oauth';

/**
 * The environment's credential source, or null when it has none (then the
 * stored session applies). With --host the environment's credentials never
 * apply: they belong to the environment's host.
 */
export function getCredentialSource(): CredentialSource | null {
  if (getHostFlag()) return null;
  if (getEnvJwt()) return 'jwt';
  if (getPrefixedEnv('API_KEY')) return 'apikey';
  return null;
}

let _usedSource: CredentialSource | undefined;

/** Which source produced the bearer of this invocation (for whoami). */
export function getUsedCredentialSource(): CredentialSource | undefined {
  return _usedSource;
}

/**
 * A bearer token for the host. `forceRefresh` discards the cached exchange
 * result and gets a new token; with a static ${PREFIX}_JWT there is nothing
 * to refresh, so it is a no-op and callers must not retry on JWT errors.
 */
export async function getAccessToken(
  host: HostFacts,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  const forced = getAuthFlag();
  // No environment credential (or --host) means the stored session is next.
  const source = forced ?? getCredentialSource() ?? 'oauth';

  if (source === 'jwt') {
    const jwt = getEnvJwt();
    if (!jwt) throw new NoCredentialsError(host.host, forced);
    _usedSource = 'jwt';
    return jwt;
  }

  if (source === 'apikey') {
    const apiKey = getPrefixedEnv('API_KEY');
    if (!apiKey) throw new NoCredentialsError(host.host, forced);
    const token = await tokenFromApiKey(host, apiKey, !!opts.forceRefresh);
    _usedSource = 'apikey';
    return token.jwt;
  }

  // Imported lazily: API-key and JWT invocations never load the OAuth client.
  const { getSessionToken } = await import('./session.js');
  let token: string | null;
  try {
    token = await getSessionToken(host, opts);
  } catch (error) {
    // cli-auth could not refresh: the session is spent, not merely stale.
    if ((error as Error).name === 'CliAuthError') {
      throw new SessionExpiredError(host.host, (error as Error).message);
    }
    throw error;
  }
  if (!token) throw new NoCredentialsError(host.host, forced);
  _usedSource = 'oauth';
  return token;
}

// In-process dedupe: parallel connections (list, -md) share one exchange.
const _exchanges = new Map<string, Promise<CachedToken>>();

function tokenFromApiKey(
  host: HostFacts,
  apiKey: string,
  forceRefresh: boolean,
): Promise<CachedToken> {
  const key = `${host.tokenExchange.url}\n${apiKey}`;
  // Cached per host: a token issued by one host is never sent to another.
  if (forceRefresh) {
    deleteCachedToken(apiKey, host.host);
    _exchanges.delete(key);
  }

  let pending = _exchanges.get(key);
  if (!pending) {
    pending = (async () => {
      const useCache = !isJwtCacheDisabled();
      if (useCache) {
        const cached = await readCachedToken(apiKey, host.host);
        if (cached) return cached;
      }
      const token = await exchangeApiKey(host, apiKey);
      if (useCache) await writeCachedToken(apiKey, token, host.host);
      return token;
    })();
    _exchanges.set(key, pending);
    pending.catch(() => _exchanges.delete(key));
  }
  return pending;
}

/**
 * Exchange an API key for an access token. Cloud: POST <org>.semantius.cloud/token
 * with a client_credentials form body (the request postgrest-mcp's
 * apiKeyAuth.ts makes); self-hosted: GET <host>/api/auth/token. Both send the
 * key as x-api-key and answer { access_token, expires_in }.
 */
async function exchangeApiKey(
  host: HostFacts,
  apiKey: string,
): Promise<CachedToken> {
  const { method, url } = host.tokenExchange;
  debug(`Exchanging the API key for a token: ${method} ${url}`);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(
      url,
      method === 'POST'
        ? {
            method,
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-api-key': apiKey,
            },
            body: 'grant_type=client_credentials',
          }
        : { method, headers: { 'x-api-key': apiKey } },
    );
  } catch (error) {
    logTokenEvent({
      grant: 'api_key',
      url,
      outcome: 'failure',
      durationMs: Date.now() - started,
      error: (error as Error).message,
    });
    throw new Error(
      `Token exchange failed: could not reach ${url}: ${(error as Error).message}${notSemantiusHint(host)}`,
    );
  }
  logTokenEvent({
    grant: 'api_key',
    url,
    outcome: response.ok ? 'success' : 'failure',
    status: response.status,
    durationMs: Date.now() - started,
  });

  if (!response.ok) {
    // A JSON body is the auth server's own error; anything else (empty, an
    // HTML page) says nothing, so name the status and the URL instead.
    const body = (await response.text().catch(() => '')).slice(0, 500);
    if ((response.status === 401 || response.status === 403) && isJson(body)) {
      throw new ApiKeyRejectedError(host, response.status, errorReason(body));
    }
    const detail = isJson(body)
      ? body
      : `${response.statusText || STATUS_CODES[response.status] || 'error'} from ${method} ${url}${notSemantiusHint(host)}`;
    throw new Error(`Token exchange failed (${response.status}): ${detail}`);
  }

  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error(
      `Token exchange failed: ${url} did not return JSON${notSemantiusHint(host)}`,
    );
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }
  return {
    jwt: data.access_token,
    expires: tokenExpiry(data.access_token, data.expires_in),
  };
}

/** The human part of an auth server's JSON error body. */
function errorReason(body: string): string {
  const json = JSON.parse(body) as Record<string, unknown>;
  const reason = json.error_description ?? json.message ?? json.error;
  return typeof reason === 'string' ? reason : body;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** On self-hosted, a wrong host is the likely cause of a non-answer. */
function notSemantiusHint(host: HostFacts): string {
  return host.mode === 'selfhosted'
    ? ` — is ${host.host} a Semantius instance?`
    : '';
}

/** JWT exp − 10 s (as upstream get_cli_token); expires_in if there is no exp claim. */
function tokenExpiry(jwt: string, expiresIn: unknown): string {
  const exp =
    decodeJwtExp(jwt) ??
    (typeof expiresIn === 'number'
      ? Math.floor(Date.now() / 1000) + expiresIn
      : undefined);
  if (exp === undefined) {
    throw new Error(
      'Token exchange response has no expiry (no exp claim, no expires_in)',
    );
  }
  return new Date((exp - 10) * 1000).toISOString();
}

function decodeJwtExp(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}
