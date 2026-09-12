/**
 * Tests for the OAuth login (src/auth/): the session storage adapter and its
 * file fallback, endpoint discovery (RFC 9728 → RFC 8414), the PKCE login /
 * refresh / logout cycle against a mock provider, credential precedence
 * including --auth, and the MCP route's bearer for a session-only login.
 *
 * Hermetic: a local Bun.serve is the provider, the keyring is a fake object
 * (never Bun.secrets), and the user config dir is redirected to a temp dir.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScope, getOAuthMetadata } from '../src/auth/provider';
import {
  LoginUnavailableError,
  getSessionExpiry,
  getSessionToken,
  hasStoredSession,
  login,
  logout,
} from '../src/auth/session';
import {
  type SecretsApi,
  createSecretStorage,
  setSecretsForTests,
} from '../src/auth/storage';
import {
  NoCredentialsError,
  getAccessToken,
  getUsedCredentialSource,
} from '../src/auth/token';
import { transformConfigWithJwt } from '../src/client';
import { setAuthFlag, setEnvPrefix, setHostFlag } from '../src/config';
import {
  type HostFacts,
  SELF_HOSTED_CLIENT_ID,
  resolveHost,
  setHostCacheDirForTests,
} from '../src/host';

// ============================================================================
// Mock provider
// ============================================================================

interface ProviderState {
  origin: string;
  paths: string[];
  tokenGrants: string[];
  /** The `resource` seen on each authorize / token request ('' when absent). */
  resources: string[];
  revoked: string[];
  /** Mutable knobs for the issuer cases; reset() restores the sound values. */
  cfg: ProviderConfig;
  reset: () => void;
  stop: () => void;
}

interface ProviderConfig {
  /** undefined = the issuer of this server; null = omit iss; string = verbatim. */
  callbackIss: string | null | undefined;
  /** Issuer the authorization-server metadata declares (undefined = its own). */
  metadataIssuer: string | undefined;
  /** Whether the metadata promises an iss on every authorization response. */
  advertiseIss: boolean;
}

/** A tenant-shaped OAuth provider: discovery, authorize, token, revoke. */
function startProvider(): ProviderState {
  const cfg: ProviderConfig = {
    callbackIss: undefined,
    metadataIssuer: undefined,
    advertiseIss: true,
  };
  const paths: string[] = [];
  const tokenGrants: string[] = [];
  const resources: string[] = [];
  const revoked: string[] = [];
  let issued = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const { origin } = url;
      paths.push(url.pathname);

      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/api/auth`],
          scopes_supported: ['tenant:t-1:user'],
        });
      }

      if (url.pathname === '/.well-known/oauth-authorization-server/api/auth') {
        return Response.json({
          issuer: cfg.metadataIssuer ?? `${origin}/api/auth`,
          authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
          token_endpoint: `${origin}/token`,
          revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: cfg.advertiseIss,
        });
      }

      if (url.pathname === '/api/auth/oauth2/authorize') {
        resources.push(url.searchParams.get('resource') ?? '');
        const redirectUri = url.searchParams.get('redirect_uri') as string;
        const back = new URL(redirectUri);
        back.searchParams.set('code', 'auth-code-1');
        back.searchParams.set('state', url.searchParams.get('state') as string);
        const iss = cfg.callbackIss === undefined ? `${origin}/api/auth` : cfg.callbackIss;
        if (iss !== null) back.searchParams.set('iss', iss);
        return Response.redirect(back.toString(), 302);
      }

      if (url.pathname === '/token') {
        const form = new URLSearchParams(await req.text());
        tokenGrants.push(form.get('grant_type') ?? '');
        resources.push(form.get('resource') ?? '');
        issued += 1;
        return Response.json({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }

      if (url.pathname === '/api/auth/oauth2/revoke') {
        const form = new URLSearchParams(await req.text());
        revoked.push(form.get('token') ?? '');
        return new Response('', { status: 200 });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    paths,
    tokenGrants,
    resources,
    revoked,
    cfg,
    // One server for the file, but each test starts from access-1.
    reset: () => {
      cfg.callbackIss = undefined;
      cfg.metadataIssuer = undefined;
      cfg.advertiseIss = true;
      issued = 0;
      paths.length = 0;
      tokenGrants.length = 0;
      resources.length = 0;
      revoked.length = 0;
    },
    stop: () => server.stop(true),
  };
}

/** An in-memory stand-in for Bun.secrets. */
function fakeSecrets(): SecretsApi & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get({ service, name }) {
      return store.get(`${service}:${name}`) ?? null;
    },
    async set({ service, name, value }) {
      store.set(`${service}:${name}`, value);
    },
    async delete({ service, name }) {
      return store.delete(`${service}:${name}`);
    },
  };
}

// ============================================================================

const VARS = [
  'SEMANTIUS_HOST',
  'SEMANTIUS_ORG',
  'SEMANTIUS_API_KEY',
  'SEMANTIUS_JWT',
  'APPDATA',
  'HOME',
];

describe('oauth login', () => {
  let provider: ProviderState;
  let saved: Record<string, string | undefined>;
  let configDir: string;
  let cacheDir: string;
  let secrets: ReturnType<typeof fakeSecrets>;
  /** What the CLI resolves for the loopback host: self-hosted facts. */
  let host: HostFacts;
  /** The same host presented as cloud, which is what A2 lets log in. */
  let loginHost: HostFacts;

  beforeAll(() => {
    provider = startProvider();
  });

  afterAll(() => {
    provider.stop();
  });

  beforeEach(async () => {
    provider.reset();
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    configDir = await mkdtemp(join(tmpdir(), 'semantius-auth-cfg-'));
    cacheDir = await mkdtemp(join(tmpdir(), 'semantius-auth-cache-'));
    // getUserConfigDir() derives from these, so the lock file and any file
    // fallback stay inside the temp dir.
    process.env.APPDATA = configDir;
    process.env.HOME = configDir;
    setEnvPrefix('SEMANTIUS');
    setHostFlag(undefined);
    setAuthFlag(undefined);
    setHostCacheDirForTests(cacheDir);
    secrets = fakeSecrets();
    setSecretsForTests(secrets);

    // A loopback host: self-hosted by the cloud-host rule, so resolveHost()
    // needs no control plane, and the provider serves its .well-known.
    const hostname = provider.origin.replace('http://', '');
    process.env.SEMANTIUS_HOST = hostname;
    host = await resolveHost();
    // Cloud is the only mode A2 logs in to; the session is keyed by host name,
    // so the resolved facts still find what this login stores.
    loginHost = {
      ...host,
      mode: 'cloud',
      org: 'acme',
      tenantId: 't-1',
      clientId: 'cli-client-id',
    };
  });

  afterEach(async () => {
    setSecretsForTests(undefined);
    setHostCacheDirForTests(undefined);
    setHostFlag(undefined);
    setAuthFlag(undefined);
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
    await rm(configDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** Drive the browser step: follow the authorize redirect to the callback. */
  const openUrl = (url: string) => {
    void fetch(url, { redirect: 'follow' }).catch(() => {});
  };

  // --------------------------------------------------------------------
  describe('storage', () => {
    test('saves, loads and clears through the keyring', async () => {
      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toBeUndefined();

      await storage.save({ refresh_token: 'r', tokens: {} });
      expect(secrets.store.get('semantius:SEMANTIUS:example.test')).toContain(
        'refresh_token',
      );
      expect(await storage.load()).toEqual({ refresh_token: 'r', tokens: {} });

      await storage.clear();
      expect(await storage.load()).toBeUndefined();
    });

    test('a corrupt entry reads as "no session", not as a keyring failure', async () => {
      secrets.store.set('semantius:SEMANTIUS:example.test', 'not json');
      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toBeUndefined();
    });

    test('falls back to a file when there is no keyring', async () => {
      const broken: SecretsApi = {
        async get() {
          throw new Error('libsecret not available');
        },
        async set() {
          throw new Error('libsecret not available');
        },
        async delete() {
          throw new Error('libsecret not available');
        },
      };
      const storage = createSecretStorage('SEMANTIUS:example.test', broken);
      await storage.save({ refresh_token: 'r', tokens: {} });

      expect(await storage.load()).toEqual({ refresh_token: 'r', tokens: {} });
      expect(
        existsSync(
          join(
            configDir,
            'semantius',
            'sessions',
            'SEMANTIUS_example.test',
            'credentials.json',
          ),
        ) ||
          existsSync(
            join(
              configDir,
              '.config',
              'semantius',
              'sessions',
              'SEMANTIUS_example.test',
              'credentials.json',
            ),
          ),
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------
  describe('discovery', () => {
    test('resource metadata names the issuer, RFC 8414 the endpoints', async () => {
      const metadata = await getOAuthMetadata(host);

      expect(metadata.issuer).toBe(`${provider.origin}/api/auth`);
      expect(metadata.authorizationEndpoint).toBe(
        `${provider.origin}/api/auth/oauth2/authorize`,
      );
      expect(metadata.tokenEndpoint).toBe(`${provider.origin}/token`);
      expect(metadata.revocationEndpoint).toBe(
        `${provider.origin}/api/auth/oauth2/revoke`,
      );
      expect(metadata.resourceScopes).toEqual(['tenant:t-1:user']);

      // The issuer has a path, so its metadata lives under the path-suffix URL.
      expect(provider.paths).toContain(
        '/.well-known/oauth-authorization-server/api/auth',
      );
    });

    test('the scope is the base scopes plus the resource scopes', async () => {
      expect(buildScope(await getOAuthMetadata(host))).toBe(
        'openid profile email offline_access tenant:t-1:user',
      );
    });

    test('metadata that declares a different issuer is refused', async () => {
      provider.cfg.metadataIssuer = 'https://elsewhere.example/api/auth';
      const other = { ...host, host: 'metadata-mismatch.example' };

      expect(getOAuthMetadata(other)).rejects.toThrow(
        /declares issuer "https:\/\/elsewhere\.example\/api\/auth" but .* names /,
      );
    });

    test('a host without resource metadata fails with the URL', async () => {
      // A host of its own: discovery is memoized per host name.
      const broken = {
        ...host,
        host: 'unknown.example',
        discoveryUrl: `${provider.origin}/nope`,
      };
      expect(getOAuthMetadata(broken)).rejects.toThrow(/\/nope returned 404/);
    });
  });

  // --------------------------------------------------------------------
  describe('login, refresh, logout', () => {
    test('stores a session that getSessionToken serves', async () => {
      expect(await hasStoredSession(host)).toBe(false);

      await login(loginHost, { openUrl });

      expect(await hasStoredSession(host)).toBe(true);
      expect(provider.tokenGrants).toContain('authorization_code');
      expect(await getSessionToken(host)).toBe('access-1');
      expect(await getSessionExpiry(host)).toMatch(/^\d{4}-/);
    });

    test('asks for the tenant audience on authorize and token', async () => {
      await login(loginHost, { openUrl });

      // Without the resource indicator the token's aud is the MCP server and
      // PostgREST answers "required audience not found". cli-auth sends it on
      // the token request only (not on the authorize URL), which is what binds
      // the audience — verified against a real tenant.
      expect(provider.resources).toEqual(['', 'tenant://t-1']);
    });

    test('forceRefresh spends the refresh token', async () => {
      await login(loginHost, { openUrl });
      const before = provider.tokenGrants.length;

      const token = await getSessionToken(host, { forceRefresh: true });

      expect(token).not.toBe('access-1');
      expect(provider.tokenGrants.slice(before)).toEqual(['refresh_token']);
    });

    test('a fresh token is served without contacting the provider', async () => {
      await login(loginHost, { openUrl });
      const before = provider.tokenGrants.length;

      await getSessionToken(host);

      expect(provider.tokenGrants.length).toBe(before);
    });

    test('logout revokes and clears', async () => {
      await login(loginHost, { openUrl });

      expect(await logout(host)).toBe(true);
      expect(provider.revoked.length).toBe(1);
      expect(await hasStoredSession(host)).toBe(false);
      expect(await getSessionToken(host)).toBeNull();
      // Nothing stored: logout says so instead of failing.
      expect(await logout(host)).toBe(false);
    });

    test('a cloud org without a CLI client refuses, naming the org', async () => {
      // The refetch re-resolves the configured host, so the invocation has to
      // be on the cloud host; only the control plane is stubbed.
      process.env.SEMANTIUS_HOST = 'acme.semantius.cloud';
      const realFetch = globalThis.fetch;
      const controlPlaneCalls: string[] = [];
      globalThis.fetch = (async (
        input: URL | Request | string,
        init?: RequestInit,
      ) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('https://api.semantius.cloud/')) {
          controlPlaneCalls.push(url);
          return Response.json({
            id: 't-1',
            postgrest_url: 'https://acme.example/rest',
          });
        }
        return realFetch(input as Parameters<typeof fetch>[0], init);
      }) as typeof fetch;

      const noClient = {
        ...loginHost,
        host: 'acme.semantius.cloud',
        clientId: null,
      };
      try {
        // Refetches the control-plane record once (the cached one may predate
        // client_id_cli) before giving up.
        await expect(login(noClient, { openUrl })).rejects.toThrow(
          /NOT_AVAILABLE.*not enabled for acme.*no CLI client/s,
        );
        expect(controlPlaneCalls).toEqual([
          'https://api.semantius.cloud/organization/acme',
        ]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    // Each case needs its own host name: discovery is memoized per host for
    // the life of the process, and these cases change what it would return.
    test('a callback naming another issuer is rejected, storing nothing', async () => {
      provider.cfg.callbackIss = 'https://app.semantius.com/api/auth';
      const target = { ...loginHost, host: 'iss-wrong.example' };

      expect(login(target, { openUrl })).rejects.toThrow(
        /LOGIN_FAILED.*names issuer "https:\/\/app\.semantius\.com\/api\/auth", expected/s,
      );
      // The response may come from another authorization server: keep nothing.
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a missing iss is rejected when the server promises one', async () => {
      provider.cfg.callbackIss = null;
      const target = { ...loginHost, host: 'iss-missing.example' };

      expect(login(target, { openUrl })).rejects.toThrow(
        /LOGIN_FAILED.*carried no "iss"/s,
      );
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a missing iss is accepted when the server promises none', async () => {
      provider.cfg.callbackIss = null;
      provider.cfg.advertiseIss = false;
      const target = { ...loginHost, host: 'iss-unadvertised.example' };

      await login(target, { openUrl });

      expect(await hasStoredSession(target)).toBe(true);
    });

    test('a self-hosted host logs in with the fixed client id', async () => {
      // resolveHost() gives a self-hosted host the CLI's fixed client id, and
      // nothing else in the flow depends on the mode.
      expect(host.mode).toBe('selfhosted');
      expect(host.clientId).toBe(SELF_HOSTED_CLIENT_ID);

      await login(host, { openUrl });

      expect(await hasStoredSession(host)).toBe(true);
      expect(provider.tokenGrants).toContain('authorization_code');
      expect(await getSessionToken(host)).toBe('access-1');
      // No tenant id, so no RFC 8707 resource indicator on either request —
      // self-hosted instances advertise none.
      expect(provider.resources).toEqual(['', '']);
    });

    test('the issuer checks apply to self-hosted hosts too', async () => {
      // The case they exist for: an arbitrary host serves its own metadata.
      provider.cfg.callbackIss = 'https://acme.semantius.cloud/api/auth';
      const target = { ...host, host: 'selfhosted-iss.example' };

      expect(login(target, { openUrl })).rejects.toThrow(
        /LOGIN_FAILED.*names issuer "https:\/\/acme\.semantius\.cloud\/api\/auth", expected/s,
      );
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a self-hosted host without a client id refuses, without a refetch', async () => {
      // Cloud-only recovery: there is no control plane to ask here, so this
      // must not fall through to the "no CLI client on the control plane" path.
      const noClient = {
        ...host,
        host: 'selfhosted-no-client.example',
        clientId: null,
      };

      expect(login(noClient, { openUrl })).rejects.toBeInstanceOf(
        LoginUnavailableError,
      );
      expect(login(noClient, { openUrl })).rejects.toThrow(
        /NOT_AVAILABLE.*not configured for selfhosted-no-client\.example \(no CLI client id\)/s,
      );
      expect(await hasStoredSession(noClient)).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  describe('credential precedence', () => {
    test('the environment JWT wins over a stored session', async () => {
      await login(loginHost, { openUrl });
      process.env.SEMANTIUS_JWT = 'static-jwt';

      expect(await getAccessToken(host)).toBe('static-jwt');
      expect(getUsedCredentialSource()).toBe('jwt');
    });

    test('--auth oauth uses the session even with a JWT set', async () => {
      await login(loginHost, { openUrl });
      process.env.SEMANTIUS_JWT = 'static-jwt';
      setAuthFlag('oauth');

      expect(await getAccessToken(host)).toBe('access-1');
      expect(getUsedCredentialSource()).toBe('oauth');
    });

    test('the session is used when the environment has no credential', async () => {
      await login(loginHost, { openUrl });

      expect(await getAccessToken(host)).toBe('access-1');
      expect(getUsedCredentialSource()).toBe('oauth');
    });

    test('--auth jwt without a JWT names the variable', async () => {
      setAuthFlag('jwt');
      expect(getAccessToken(host)).rejects.toThrow(
        /--auth jwt was given but SEMANTIUS_JWT is not set/,
      );
    });

    test('no credential at all points at login', async () => {
      expect(getAccessToken(host)).rejects.toBeInstanceOf(NoCredentialsError);
      expect(getAccessToken(host)).rejects.toThrow(
        /Authentication required: no credentials for .*semantius login/s,
      );
    });
  });

  // --------------------------------------------------------------------
  describe('--login', () => {
    test('needs an interactive terminal', async () => {
      const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
      const proc = Bun.spawn(['bun', 'run', cliPath, '--login', 'whoami'], {
        env: {
          ...process.env,
          SEMANTIUS_HOST: host.host,
          SEMANTIUS_API_KEY: '',
          SEMANTIUS_JWT: '',
          SEMANTIUS_NO_DAEMON: '1',
        },
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(1);
      expect(stderr).toContain(
        'Error [LOGIN_FAILED]: --login needs an interactive terminal',
      );
    });
  });

  // --------------------------------------------------------------------
  describe('MCP route', () => {
    const config = {
      url: 'https://acme.semantius.ai/mcp',
      headers: { 'x-api-key': '' },
    };

    test('an empty x-api-key becomes the session bearer', async () => {
      await login(loginHost, { openUrl });

      const resolved = await transformConfigWithJwt('cube', config);

      expect(resolved).toMatchObject({
        headers: { Authorization: 'Bearer access-1' },
      });
      expect((resolved as typeof config).headers['x-api-key']).toBeUndefined();
    });

    test('without a session the config is left untouched', async () => {
      expect(await transformConfigWithJwt('cube', config)).toEqual(config);
    });
  });
});
