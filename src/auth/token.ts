/**
 * Bearer token for the local crud layer, without the MCP server.
 *
 * Sources, first match wins: ${PREFIX}_JWT (static, sent as-is) →
 * ${PREFIX}_API_KEY (exchanged at the host's token endpoint, cached in the
 * encrypted JWT cache shared with the MCP path) → NoCredentialsError.
 * The MCP path (client.ts transformConfigWithJwt / resolveJwt) is separate.
 */

import {
  debug,
  getEnvJwt,
  getPrefixedEnv,
  prefixedEnvName,
} from '../config.js';
import type { HostFacts } from '../host.js';
import {
  type CachedToken,
  deleteCachedToken,
  isJwtCacheDisabled,
  readCachedToken,
  writeCachedToken,
} from '../jwt-cache.js';

/**
 * No credential source is configured for the host. The message starts with
 * "Authentication required", which isAuthErrorMessage() maps to exit 5.
 */
export class NoCredentialsError extends Error {
  constructor(host: string) {
    super(
      `Authentication required: no credentials for ${host}. Set ${prefixedEnvName('API_KEY')} or run "semantius login".`,
    );
    this.name = 'NoCredentialsError';
  }
}

export type CredentialSource = 'jwt' | 'apikey';

/** The credential source getAccessToken would use, or null if none is set. */
export function getCredentialSource(): CredentialSource | null {
  if (getEnvJwt()) return 'jwt';
  if (getPrefixedEnv('API_KEY')) return 'apikey';
  return null;
}

/**
 * A bearer token for the host. `forceRefresh` discards the cached exchange
 * result and exchanges again; with a static ${PREFIX}_JWT there is nothing to
 * refresh, so it is a no-op and callers must not retry on JWT errors.
 */
export async function getAccessToken(
  host: HostFacts,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  const envJwt = getEnvJwt();
  if (envJwt) return envJwt;

  const apiKey = getPrefixedEnv('API_KEY');
  if (apiKey) {
    const token = await tokenFromApiKey(host, apiKey, !!opts.forceRefresh);
    return token.jwt;
  }

  throw new NoCredentialsError(host.host);
}

// In-process dedupe: parallel connections (list, -md) share one exchange.
const _exchanges = new Map<string, Promise<CachedToken>>();

function tokenFromApiKey(
  host: HostFacts,
  apiKey: string,
  forceRefresh: boolean,
): Promise<CachedToken> {
  const key = `${host.tokenExchange.url}\n${apiKey}`;
  if (forceRefresh) {
    deleteCachedToken(apiKey);
    _exchanges.delete(key);
  }

  let pending = _exchanges.get(key);
  if (!pending) {
    pending = (async () => {
      const useCache = !isJwtCacheDisabled();
      if (useCache) {
        const cached = await readCachedToken(apiKey);
        if (cached) return cached;
      }
      const token = await exchangeApiKey(host, apiKey);
      if (useCache) await writeCachedToken(apiKey, token);
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
    throw new Error(
      `Token exchange failed: could not reach ${url}: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(
      `Token exchange failed (${response.status}): ${body || response.statusText}`,
    );
  }

  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error(`Token exchange failed: ${url} did not return JSON`);
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }
  return {
    jwt: data.access_token,
    expires: tokenExpiry(data.access_token, data.expires_in),
  };
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
