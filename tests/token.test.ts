/**
 * Tests for the local crud layer's token source (src/auth/token.ts):
 * precedence, the API-key exchange in its cloud (POST) and self-hosted (GET)
 * shapes, the shared encrypted JWT cache, forceRefresh, and NoCredentialsError.
 *
 * fetch is stubbed. Every test uses its own random API key, so its JWT cache
 * file (in the OS temp dir) and in-process dedupe entry are private to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  ApiKeyRejectedError,
  NoCredentialsError,
  getAccessToken,
  getCredentialSource,
  isCredentialError,
} from '../src/auth/token';
import { setEnvPrefix, setHostFlag } from '../src/config';
import { isAuthErrorMessage } from '../src/errors';
import type { HostFacts } from '../src/host';
import {
  deleteCachedToken,
  readCachedToken,
  setJwtCacheDisabled,
  writeCachedToken,
} from '../src/jwt-cache';

const CLOUD: HostFacts = {
  mode: 'cloud',
  host: 'acme.semantius.cloud',
  org: 'acme',
  tenantId: 'tenant-1',
  postgrestUrl: 'https://pg.example.com/rest/v1',
  discoveryUrl: 'https://acme.semantius.cloud/.well-known/openid-configuration',
  tokenExchange: { method: 'POST', url: 'https://acme.semantius.cloud/token' },
  clientId: 'cli-client',
  apiBaseUrl: 'https://acme.semantius.ai',
  uiBaseUrl: 'https://acme.semantius.app',
};

const SELF_HOSTED: HostFacts = {
  mode: 'selfhosted',
  host: 'x.example.com',
  org: null,
  tenantId: null,
  postgrestUrl: 'https://x.example.com/rest',
  discoveryUrl: 'https://x.example.com/.well-known/openid-configuration',
  tokenExchange: { method: 'GET', url: 'https://x.example.com/api/auth/token' },
  clientId: null,
  apiBaseUrl: 'https://x.example.com/api',
  uiBaseUrl: 'https://x.example.com',
};

/** An unsigned JWT with the given exp (seconds since epoch). */
function makeJwt(exp: number, marker = 'x'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp, marker })}.sig`;
}

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

describe('getAccessToken', () => {
  const VARS = ['SEMANTIUS_JWT', 'SEMANTIUS_API_KEY', 'SEMANTIUS_DISABLE_JWT_CACHE'];
  let saved: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  let apiKey: string;
  let calls: Captured[];

  function stubFetch(reply: () => Response): void {
    globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body,
      });
      return reply();
    }) as typeof fetch;
  }

  const tokenReply = (jwt: string) => () =>
    new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    setEnvPrefix('SEMANTIUS');
    setJwtCacheDisabled(false);
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    apiKey = `sk-tokentest${randomBytes(4).toString('hex')}-${randomBytes(16).toString('hex')}`;
    calls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    deleteCachedToken(apiKey, CLOUD.host);
    deleteCachedToken(apiKey, SELF_HOSTED.host);
    setJwtCacheDisabled(false);
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
  });

  test('a static SEMANTIUS_JWT wins over the API key', async () => {
    process.env.SEMANTIUS_JWT = 'static.jwt.token';
    process.env.SEMANTIUS_API_KEY = apiKey;
    stubFetch(tokenReply(makeJwt(inOneHour())));

    expect(await getAccessToken(CLOUD)).toBe('static.jwt.token');
    expect(getCredentialSource()).toBe('jwt');
    expect(calls).toEqual([]);
  });

  test('forceRefresh with a static JWT is a no-op', async () => {
    process.env.SEMANTIUS_JWT = 'org:static.jwt.token';
    stubFetch(tokenReply(makeJwt(inOneHour())));
    expect(await getAccessToken(CLOUD, { forceRefresh: true })).toBe(
      'static.jwt.token',
    );
    expect(calls).toEqual([]);
  });

  test('cache hit → no fetch', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    const cachedJwt = makeJwt(inOneHour(), 'cached');
    await writeCachedToken(
      apiKey,
      { jwt: cachedJwt, expires: new Date(Date.now() + 3_000_000).toISOString() },
      CLOUD.host,
    );
    stubFetch(tokenReply(makeJwt(inOneHour(), 'fresh')));

    expect(await getAccessToken(CLOUD)).toBe(cachedJwt);
    expect(getCredentialSource()).toBe('apikey');
    expect(calls).toEqual([]);
  });

  test('cache miss → one cloud POST exchange, then cached', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    const exp = inOneHour();
    const jwt = makeJwt(exp);
    stubFetch(tokenReply(jwt));

    expect(await getAccessToken(CLOUD)).toBe(jwt);
    expect(calls).toEqual([
      {
        url: 'https://acme.semantius.cloud/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-api-key': apiKey,
        },
        body: 'grant_type=client_credentials',
      },
    ]);

    // Persisted with expires = exp − 10 s, and reused without another fetch.
    const cached = await readCachedToken(apiKey, CLOUD.host);
    expect(cached).toEqual({
      jwt,
      expires: new Date((exp - 10) * 1000).toISOString(),
    });
    expect(await getAccessToken(CLOUD)).toBe(jwt);
    expect(calls.length).toBe(1);
  });

  test('parallel callers share one exchange', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    stubFetch(tokenReply(makeJwt(inOneHour())));
    await Promise.all([
      getAccessToken(CLOUD),
      getAccessToken(CLOUD),
      getAccessToken(CLOUD),
    ]);
    expect(calls.length).toBe(1);
  });

  test('forceRefresh deletes the cached token and exchanges again', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    const first = makeJwt(inOneHour(), 'first');
    stubFetch(tokenReply(first));
    expect(await getAccessToken(CLOUD)).toBe(first);

    const second = makeJwt(inOneHour(), 'second');
    stubFetch(tokenReply(second));
    expect(await getAccessToken(CLOUD, { forceRefresh: true })).toBe(second);
    expect(calls.length).toBe(2);
    expect((await readCachedToken(apiKey, CLOUD.host))?.jwt).toBe(second);
  });

  test('self-hosted: GET <host>/api/auth/token with x-api-key', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    const jwt = makeJwt(inOneHour());
    stubFetch(tokenReply(jwt));

    expect(await getAccessToken(SELF_HOSTED)).toBe(jwt);
    expect(calls).toEqual([
      {
        url: 'https://x.example.com/api/auth/token',
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        body: undefined,
      },
    ]);
  });

  test('expires_in is the fallback when the token has no exp claim', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    stubFetch(tokenReply('opaque-token'));
    const before = Date.now();
    expect(await getAccessToken(CLOUD)).toBe('opaque-token');
    const expires = Date.parse((await readCachedToken(apiKey, CLOUD.host))?.expires ?? '');
    expect(expires).toBeGreaterThan(before + 3_500_000);
  });

  test('--disable-jwt-cache: exchanges without reading or writing the cache', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    await writeCachedToken(
      apiKey,
      { jwt: 'cached.jwt.token', expires: new Date(Date.now() + 3_000_000).toISOString() },
      CLOUD.host,
    );
    setJwtCacheDisabled(true);
    const jwt = makeJwt(inOneHour());
    stubFetch(tokenReply(jwt));

    expect(await getAccessToken(CLOUD)).toBe(jwt);
    expect(calls.length).toBe(1);
    setJwtCacheDisabled(false);
    expect((await readCachedToken(apiKey, CLOUD.host))?.jwt).toBe('cached.jwt.token');
  });

  test('a rejected API key → ApiKeyRejectedError naming host and key (exit 5)', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    stubFetch(
      () => new Response('{"error":"invalid_client"}', { status: 401 }),
    );
    const error = await getAccessToken(CLOUD).catch((e: Error) => e);
    expect(error).toBeInstanceOf(ApiKeyRejectedError);
    // "SEMANTIUS_API_KEY (from <file>)" when another test loaded a .env with it.
    expect((error as Error).message).toMatch(
      /^Error \[API_KEY_REJECTED\]: acme\.semantius\.cloud rejected the API key in SEMANTIUS_API_KEY( \(from [^)]+\))? \(401: invalid_client\)\n {2}Suggestion: The key belongs to another organization or was revoked\. Use an API key of acme\.$/,
    );
    expect(isCredentialError(error)).toBe(true);
    expect(isAuthErrorMessage((error as Error).message)).toBe(true);
    expect((error as Error).message).not.toContain(apiKey);
  });

  test('a token cached for one host is never sent to another', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    await writeCachedToken(
      apiKey,
      { jwt: 'cloud.tenant.token', expires: new Date(Date.now() + 3_000_000).toISOString() },
      CLOUD.host,
    );
    const selfHostedJwt = makeJwt(inOneHour(), 'self-hosted');
    stubFetch(tokenReply(selfHostedJwt));

    expect(await getAccessToken(SELF_HOSTED)).toBe(selfHostedJwt);
    expect(calls.map((c) => c.url)).toEqual(['https://x.example.com/api/auth/token']);
    // ...and each host keeps its own entry.
    expect((await readCachedToken(apiKey, CLOUD.host))?.jwt).toBe('cloud.tenant.token');
    expect((await readCachedToken(apiKey, SELF_HOSTED.host))?.jwt).toBe(selfHostedJwt);
  });

  test('a non-JSON answer from the token endpoint names the status and the host', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    stubFetch(() => new Response('<html>Not here</html>', { status: 404 }));
    await expect(getAccessToken(SELF_HOSTED)).rejects.toThrow(
      'Token exchange failed (404): Not Found from GET https://x.example.com/api/auth/token — is x.example.com a Semantius instance?',
    );
  });

  test('with --host the API key and JWT of the environment are never used', async () => {
    process.env.SEMANTIUS_API_KEY = apiKey;
    process.env.SEMANTIUS_JWT = 'env.jwt.token';
    stubFetch(tokenReply(makeJwt(inOneHour())));
    setHostFlag('acme.semantius.cloud');
    try {
      expect(getCredentialSource()).toBeNull();
      const error = await getAccessToken(CLOUD).catch((e: Error) => e);
      expect(error).toBeInstanceOf(NoCredentialsError);
      expect((error as Error).message).toBe(
        'Authentication required: no credentials stored for acme.semantius.cloud. Run "semantius login --host acme.semantius.cloud" (with --host, SEMANTIUS_API_KEY and SEMANTIUS_JWT are not used).',
      );
      expect(calls).toEqual([]);
    } finally {
      setHostFlag(undefined);
    }
  });

  test('no credentials → NoCredentialsError (exit 5 via isAuthErrorMessage)', async () => {
    stubFetch(tokenReply(makeJwt(inOneHour())));
    const error = await getAccessToken(CLOUD).catch((e: Error) => e);
    expect(error).toBeInstanceOf(NoCredentialsError);
    expect((error as Error).message).toBe(
      'Authentication required: no credentials for acme.semantius.cloud. Set SEMANTIUS_API_KEY or run "semantius login".',
    );
    expect(isAuthErrorMessage((error as Error).message)).toBe(true);
    expect(getCredentialSource()).toBeNull();
    expect(calls).toEqual([]);
  });

  test('an empty API key counts as no credentials', async () => {
    process.env.SEMANTIUS_API_KEY = '';
    await expect(getAccessToken(SELF_HOSTED)).rejects.toBeInstanceOf(
      NoCredentialsError,
    );
  });
});
