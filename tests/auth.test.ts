/**
 * Tests for the OAuth login (src/auth/): the session storage adapter and its
 * file fallback, endpoint discovery (the platform document, and the legacy
 * RFC 9728 → RFC 8414 chain), the PKCE login / refresh / logout cycle against
 * a mock provider, credential precedence including --auth, and the MCP route's
 * bearer for a session-only login.
 *
 * Hermetic: a local Bun.serve is the provider, the keyring is a fake object
 * (never Bun.secrets), and the user config dir is redirected to a temp dir.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TokenSet } from 'cli-auth';
import {
  clearPlatformMemoForTests,
  getPlatformConfig,
} from '../src/auth/platform';
import { buildScope, getOAuthMetadata } from '../src/auth/provider';
import {
  LoginUnavailableError,
  getSessionExpiry,
  getSessionExpiryFor,
  getSessionToken,
  hasStoredSession,
  hasStoredSessionFor,
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
import { loginCommand, logoutCommand } from '../src/commands/auth';
import {
  getUserConfigDir,
  getUserSecretsDir,
  setAuthFlag,
  setEnvPrefix,
  setHostFlag,
} from '../src/config';
import {
  type HostFacts,
  SELF_HOSTED_CLIENT_ID,
  getHostCachePath,
  readCachedOAuthMetadata,
  readCachedPlatformConfig,
  resolveHost,
  setHostCacheDirForTests,
} from '../src/host';
import {
  getCurrentHost,
  hasHost,
  listHosts,
  recordHost,
  setCurrentHost,
  setHostsIndexDirForTests,
} from '../src/hosts-index';

// ============================================================================
// Mock provider
// ============================================================================

interface ProviderState {
  origin: string;
  paths: string[];
  tokenGrants: string[];
  /** What each /device/code request carried. */
  deviceRequests: { clientId: string; resource: string; scope: string }[];
  /** The `resource` seen on each authorize / token request ('' when absent). */
  resources: string[];
  /** The `redirect_uri`, `client_id` and `scope` of each authorize request. */
  redirectUris: string[];
  clientIds: string[];
  scopes: string[];
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
  /**
   * What /.well-known/semantius.json answers. `null` — the default — is 404,
   * the un-upgraded deployment, so every test that predates the platform
   * document keeps exercising the legacy chain unchanged.
   */
  platformDoc: 'html' | 'broken' | Record<string, unknown> | null;
  /** Serve the Entra-shaped metadata with an authorize endpoint elsewhere. */
  entraCrossOrigin: boolean;
  /**
   * Advertise device_authorization_endpoint (RFC 8628). Off by default: a
   * server that does not offer the grant is the normal case, and the CLI must
   * refuse a headless login rather than invent an endpoint.
   * 'cross-origin' advertises one on another origin, which discovery refuses.
   */
  deviceGrant: boolean | 'cross-origin';
}

/** A tenant-shaped OAuth provider: discovery, authorize, token, revoke. */
function startProvider(): ProviderState {
  const cfg: ProviderConfig = {
    callbackIss: undefined,
    metadataIssuer: undefined,
    advertiseIss: true,
    platformDoc: null,
    entraCrossOrigin: false,
    deviceGrant: false,
  };
  const paths: string[] = [];
  const tokenGrants: string[] = [];
  const deviceRequests: {
    clientId: string;
    resource: string;
    scope: string;
  }[] = [];
  const resources: string[] = [];
  const redirectUris: string[] = [];
  const clientIds: string[] = [];
  const scopes: string[] = [];
  const revoked: string[] = [];
  let issued = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const { origin } = url;
      paths.push(url.pathname);

      if (url.pathname === '/.well-known/semantius.json') {
        const doc = cfg.platformDoc;
        if (doc === null) return new Response('not found', { status: 404 });
        // The front door is up but broken: not an answer, so not an absence.
        if (doc === 'broken') return new Response('boom', { status: 502 });
        // The un-upgraded deployment: the SPA catches the path.
        if (doc === 'html') {
          return new Response('<!doctype html><title>app</title>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return Response.json(doc);
      }

      // The bundled idp's shape: the document sits at the origin root while
      // the issuer has a path, which is why no OIDC §4.3 check is possible.
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: `${origin}/api/auth`,
          authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
          token_endpoint: `${origin}/token`,
          revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
          authorization_response_iss_parameter_supported: cfg.advertiseIss,
          ...(cfg.deviceGrant
            ? {
                device_authorization_endpoint:
                  cfg.deviceGrant === 'cross-origin'
                    ? 'https://elsewhere.example/device/code'
                    : `${origin}/api/auth/device/code`,
              }
            : {}),
        });
      }

      // The Entra shape: an issuer on a path of its own, no iss-parameter
      // promise and no revocation endpoint at all.
      if (url.pathname === '/entra/tid/v2.0/.well-known/openid-configuration') {
        return Response.json({
          issuer: `${origin}/entra/tid/v2.0`,
          authorization_endpoint: cfg.entraCrossOrigin
            ? 'http://127.0.0.1:1/api/auth/oauth2/authorize'
            : `${origin}/api/auth/oauth2/authorize`,
          token_endpoint: `${origin}/token`,
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        });
      }

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
          ...(cfg.deviceGrant
            ? {
                device_authorization_endpoint:
                  cfg.deviceGrant === 'cross-origin'
                    ? 'https://elsewhere.example/device/code'
                    : `${origin}/api/auth/device/code`,
                grant_types_supported: [
                  'authorization_code',
                  'refresh_token',
                  'urn:ietf:params:oauth:grant-type:device_code',
                ],
              }
            : {}),
        });
      }

      if (url.pathname === '/api/auth/device/code') {
        const form = new URLSearchParams(await req.text());
        deviceRequests.push({
          clientId: form.get('client_id') ?? '',
          resource: form.get('resource') ?? '',
          scope: form.get('scope') ?? '',
        });
        return Response.json({
          device_code: 'device-code-1',
          user_code: 'WDJB-MJHT',
          verification_uri: `${origin}/device`,
          verification_uri_complete: `${origin}/device?user_code=WDJB-MJHT`,
          expires_in: 1800,
          interval: 1,
        });
      }

      if (url.pathname === '/api/auth/oauth2/authorize') {
        resources.push(url.searchParams.get('resource') ?? '');
        redirectUris.push(url.searchParams.get('redirect_uri') ?? '');
        clientIds.push(url.searchParams.get('client_id') ?? '');
        scopes.push(url.searchParams.get('scope') ?? '');
        const redirectUri = url.searchParams.get('redirect_uri') as string;
        const back = new URL(redirectUri);
        back.searchParams.set('code', 'auth-code-1');
        back.searchParams.set('state', url.searchParams.get('state') as string);
        const iss =
          cfg.callbackIss === undefined
            ? `${origin}/api/auth`
            : cfg.callbackIss;
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
    deviceRequests,
    resources,
    redirectUris,
    clientIds,
    scopes,
    revoked,
    cfg,
    // One server for the file, but each test starts from access-1.
    reset: () => {
      cfg.callbackIss = undefined;
      cfg.metadataIssuer = undefined;
      cfg.advertiseIss = true;
      cfg.platformDoc = null;
      cfg.entraCrossOrigin = false;
      cfg.deviceGrant = false;
      deviceRequests.length = 0;
      issued = 0;
      paths.length = 0;
      tokenGrants.length = 0;
      resources.length = 0;
      redirectUris.length = 0;
      clientIds.length = 0;
      scopes.length = 0;
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

/**
 * The session stored for a host name, as the CLI itself would load it.
 *
 * Tests used to reach into the fake keyring for this, back when the token set
 * lived there. It is now sealed in a file under a key the keyring holds, and
 * bound to the name it was written for, so the storage API is the only way in
 * or out — which is the point of the binding.
 */
async function storedSession(host: string): Promise<TokenSet | undefined> {
  return createSecretStorage(`SEMANTIUS:${host}`).load();
}

/** Store a session for a host name, sealed to it as a real save would be. */
async function storeSession(host: string, session: TokenSet): Promise<void> {
  await createSecretStorage(`SEMANTIUS:${host}`).save(session);
}

/** Give a host name this process has not resolved a copy of another's session. */
async function copySessionTo(from: string, to: string): Promise<void> {
  const session = await storedSession(from);
  if (!session) throw new Error(`no session stored for ${from}`);
  await storeSession(to, session);
}

// ============================================================================

const VARS = [
  'SEMANTIUS_HOST',
  'SEMANTIUS_ORG',
  'SEMANTIUS_API_KEY',
  'SEMANTIUS_JWT',
  'SEMANTIUS_LOGIN_FLOW',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
];

describe('oauth login', () => {
  let provider: ProviderState;
  let saved: Record<string, string | undefined>;
  let configDir: string;
  let secretsDir: string;
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
    // Force the loopback grant. Every login below drives the mock provider
    // through a stubbed opener, so the browser flow is what is under test —
    // but CI is set on a runner, where the grant chooser refuses an
    // interactive login outright (nobody is there to complete one).
    process.env.SEMANTIUS_LOGIN_FLOW = 'browser';
    configDir = await mkdtemp(join(tmpdir(), 'semantius-auth-cfg-'));
    secretsDir = await mkdtemp(join(tmpdir(), 'semantius-auth-sec-'));
    cacheDir = await mkdtemp(join(tmpdir(), 'semantius-auth-cache-'));
    // getUserConfigDir() and getUserSecretsDir() derive from these, so the
    // stored session, its lock file and the .env stay inside the temp dirs.
    // The two are kept distinct on purpose: on Windows they really are
    // different directories (%APPDATA% vs %LOCALAPPDATA%), and a test that
    // conflated them could not tell a session that moved from one that never
    // had to.
    process.env.APPDATA = configDir;
    process.env.LOCALAPPDATA = secretsDir;
    process.env.HOME = configDir;
    setEnvPrefix('SEMANTIUS');
    setHostFlag(undefined);
    setAuthFlag(undefined);
    setHostCacheDirForTests(cacheDir);
    // hosts-index.ts caches its file in a module variable; APPDATA/HOME just
    // changed, so force it to forget whatever the previous test's dir held.
    setHostsIndexDirForTests(undefined);
    secrets = fakeSecrets();
    setSecretsForTests(secrets);

    // A loopback host: self-hosted by the cloud-host rule, so resolveHost()
    // needs no control plane, and the provider serves its .well-known.
    const hostname = provider.origin.replace('http://', '');
    process.env.SEMANTIUS_HOST = hostname;
    host = await resolveHost();
    // For the cloud-specific cases. A session is keyed by host name, but its
    // access token is keyed by the audience the login asked for, so a test
    // that logs in as cloud must read as cloud too — the resolved (self-hosted)
    // facts name no audience and would rightly refuse the token.
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
    setHostsIndexDirForTests(undefined);
    setHostFlag(undefined);
    setAuthFlag(undefined);
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
    await rm(configDir, { recursive: true, force: true });
    await rm(secretsDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** Drive the browser step: follow the authorize redirect to the callback. */
  const openUrl = (url: string) => {
    void fetch(url, { redirect: 'follow' }).catch(() => {});
  };

  // --------------------------------------------------------------------
  describe('storage', () => {
    /** Where the session stored under a name actually lands. */
    const credentialsPath = (name: string): string =>
      join(
        getUserSecretsDir(),
        'sessions',
        name.replace(/[:/\\]/g, '_'),
        'credentials.json',
      );

    /** A keyring that refuses anything larger than `limit`, as Windows does. */
    function cappedSecrets(limit: number): SecretsApi {
      const inner = fakeSecrets();
      return {
        ...inner,
        async set(options) {
          if (options.value.length > limit) {
            throw new Error('The stub received bad data. (code: 1783)');
          }
          return inner.set(options);
        },
      };
    }

    test('seals the session into the file; the keyring holds only the key', async () => {
      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toBeUndefined();

      await storage.save({ refresh_token: 'refresh-secret', tokens: {} });

      const entry = secrets.store.get('semantius:SEMANTIUS:example.test') ?? '';
      expect(entry).not.toContain('refresh-secret');
      expect(typeof JSON.parse(entry).k).toBe('string');

      const onDisk = readFileSync(
        credentialsPath('SEMANTIUS:example.test'),
        'utf8',
      );
      expect(onDisk).not.toContain('refresh-secret');
      expect(JSON.parse(onDisk).alg).toBe('A256GCM');

      expect(await storage.load()).toEqual({
        refresh_token: 'refresh-secret',
        tokens: {},
      });
    });

    test('clearing removes the file and the key', async () => {
      const storage = createSecretStorage('SEMANTIUS:example.test');
      await storage.save({ refresh_token: 'r', tokens: {} });

      await storage.clear();

      expect(await storage.load()).toBeUndefined();
      expect(existsSync(credentialsPath('SEMANTIUS:example.test'))).toBe(false);
      // Deleting the key is what reaches a copy of the file that already
      // escaped — into a backup, or a roaming profile.
      expect(secrets.store.has('semantius:SEMANTIUS:example.test')).toBe(false);
    });

    test('a session too large for the keyring is stored, and still encrypted', async () => {
      // Windows Credential Manager refuses a blob over 2560 bytes and an Entra
      // session is ~3.4 KB. Keeping the payload there is what used to put the
      // whole token set in a plaintext file — silently, and only on Windows.
      const storage = createSecretStorage(
        'SEMANTIUS:big.test',
        cappedSecrets(2560),
      );
      const big = {
        refresh_token: `refresh-secret-${'r'.repeat(1800)}`,
        tokens: {
          'resource=api://x': {
            access_token: 'a'.repeat(1600),
            expires_at: Date.now() + 3_600_000,
          },
        },
      };

      await storage.save(big);

      const onDisk = readFileSync(
        credentialsPath('SEMANTIUS:big.test'),
        'utf8',
      );
      expect(onDisk.length).toBeGreaterThan(2560);
      expect(onDisk).not.toContain('refresh-secret');
      expect(await storage.load()).toEqual(big);
    });

    test('a keyring entry from the old layout is honoured, then replaced by a key', async () => {
      // Sessions used to live in the keyring itself. One left there must not
      // outlive the next save: a stale entry shadowing a newer file session is
      // what sent a long-dead refresh token to the IdP on every command.
      secrets.store.set(
        'semantius:SEMANTIUS:example.test',
        JSON.stringify({ refresh_token: 'old', tokens: {} }),
      );

      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toEqual({
        refresh_token: 'old',
        tokens: {},
      });

      await storage.save({ refresh_token: 'new', tokens: {} });

      const entry = secrets.store.get('semantius:SEMANTIUS:example.test') ?? '';
      expect(entry).not.toContain('old');
      expect(entry).not.toContain('new');
      expect(
        await createSecretStorage('SEMANTIUS:example.test').load(),
      ).toEqual({ refresh_token: 'new', tokens: {} });
    });

    test('a sealed session whose key is gone reads as no session', async () => {
      await createSecretStorage('SEMANTIUS:example.test').save({
        refresh_token: 'r',
        tokens: {},
      });

      secrets.store.delete('semantius:SEMANTIUS:example.test');

      expect(
        await createSecretStorage('SEMANTIUS:example.test').load(),
      ).toBeUndefined();
    });

    test('a sealed session does not open in another slot', async () => {
      const source = 'SEMANTIUS:a.test';
      const target = 'SEMANTIUS:b.test';
      await createSecretStorage(source).save({
        refresh_token: 'r',
        tokens: {},
      });

      // Both halves copied under another host's name. The envelope is bound to
      // the name it was written for, so it still does not open.
      mkdirSync(dirname(credentialsPath(target)), { recursive: true });
      writeFileSync(
        credentialsPath(target),
        readFileSync(credentialsPath(source), 'utf8'),
      );
      secrets.store.set(
        `semantius:${target}`,
        secrets.store.get(`semantius:${source}`) ?? '',
      );

      expect(await createSecretStorage(target).load()).toBeUndefined();
      expect(await createSecretStorage(source).load()).toEqual({
        refresh_token: 'r',
        tokens: {},
      });
    });

    test('a corrupt entry reads as "no session", not as a keyring failure', async () => {
      secrets.store.set('semantius:SEMANTIUS:example.test', 'not json');
      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toBeUndefined();
    });

    test('writes the file in the clear when there is no keyring at all', async () => {
      // Headless Linux: nowhere to keep a key, so nothing to encrypt with. The
      // file is the whole store, as it always was.
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
      const path = credentialsPath('SEMANTIUS:example.test');
      expect(path.startsWith(secretsDir) || path.startsWith(configDir)).toBe(
        true,
      );
      expect(JSON.parse(readFileSync(path, 'utf8')).refresh_token).toBe('r');
    });

    /** Seed a plaintext session in a directory an older version used. */
    function seedLegacySession(vendorDir: string, marker: string): string {
      const dir = join(vendorDir, 'sessions', 'SEMANTIUS_example.test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'credentials.json'),
        JSON.stringify({ refresh_token: marker, tokens: {} }),
      );
      return dir;
    }

    /** What a migrated session must look like once it has landed. */
    async function expectMigrated(from: string, marker: string): Promise<void> {
      const storage = createSecretStorage('SEMANTIUS:example.test');
      expect(await storage.load()).toEqual({
        refresh_token: marker,
        tokens: {},
      });

      // Nothing left behind: the file it superseded is a plaintext credential,
      // and an empty session directory in the old layout is what makes someone
      // wonder which copy is live (and what the hosts scan still indexes).
      expect(existsSync(join(from, 'credentials.json'))).toBe(false);
      expect(existsSync(from)).toBe(false);
      expect(existsSync(dirname(from))).toBe(false);

      const moved = readFileSync(
        credentialsPath('SEMANTIUS:example.test'),
        'utf8',
      );
      expect(moved).not.toContain(marker);
      expect(JSON.parse(moved).alg).toBe('A256GCM');
    }

    test('moves a session out of the vendor directory into the product one', async () => {
      // dirname(config dir) is the vendor directory — where everything sat
      // before the CLI had one of its own.
      const from = seedLegacySession(dirname(getUserConfigDir()), 'vendor-dir');

      await expectMigrated(from, 'vendor-dir');
    });

    // Windows only: elsewhere the secrets root is the config root, so the case
    // above is already this one.
    const windowsOnly = process.platform === 'win32' ? test : test.skip;
    windowsOnly(
      'moves a session out of the vendor secrets directory too',
      async () => {
        const from = seedLegacySession(
          dirname(getUserSecretsDir()),
          'vendor-secrets',
        );

        await expectMigrated(from, 'vendor-secrets');
      },
    );
  });

  // --------------------------------------------------------------------
  describe('discovery: the device authorization endpoint', () => {
    // Discovery is memoized per host name, so each case needs its own.
    const named = (name: string): HostFacts => ({ ...host, host: name });

    test('absent unless advertised, on both chains', async () => {
      // Absence is the normal case and must not be guessed at: it is what
      // tells a headless login to report that the grant is unavailable.
      expect(
        (await getOAuthMetadata(named('no-device.example')))
          .deviceAuthorizationEndpoint,
      ).toBeUndefined();
    });

    test('read from the RFC 8414 document (the legacy chain)', async () => {
      provider.cfg.deviceGrant = true;
      const metadata = await getOAuthMetadata(named('legacy-device.example'));
      expect(metadata.deviceAuthorizationEndpoint).toBe(
        `${provider.origin}/api/auth/device/code`,
      );
    });

    test('read from the OIDC document the platform chain names', async () => {
      // An Entra-backed deployment reaches it this way: the platform document
      // names an OIDC discovery URL that is read verbatim.
      provider.cfg.deviceGrant = true;
      provider.cfg.platformDoc = {
        version: 2,
        host_type: 'selfhost',
        idp_type: 'entra',
        idp_well_known: `${provider.origin}/.well-known/openid-configuration`,
        client_id_cli: 'cli-client-id',
        scope: 'openid profile email offline_access',
        audience: '',
      };
      const metadata = await getOAuthMetadata(named('platform-device.example'));
      expect(metadata.deviceAuthorizationEndpoint).toBe(
        `${provider.origin}/api/auth/device/code`,
      );
    });

    test('refused when it is on another origin than the issuer', async () => {
      // The device leg has no callback, so issuerMismatch() never sees it.
      // This origin check is the only thing in its place.
      provider.cfg.deviceGrant = 'cross-origin';
      expect(getOAuthMetadata(named('cross-device.example'))).rejects.toThrow(
        /device_authorization_endpoint on a different origin/,
      );
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
  describe('headless login: the device code grant', () => {
    // Every test here forces the grant rather than simulating a machine with
    // no browser: hasLocalBrowser() is unconditionally true on Windows and
    // macOS, so DISPLAY cannot express "headless" on two of the three
    // platforms this ships to. The chooser's own wiring is unit-tested in
    // environment.test.ts; what needs a provider is the flow itself.
    const device = () => {
      process.env.SEMANTIUS_LOGIN_FLOW = 'device';
    };

    test('stores a session without opening anything', async () => {
      provider.cfg.deviceGrant = true;
      device();

      // No openUrl stub, deliberately: the device flow must never reach a
      // browser. On a headless runner the real opener would hang to the
      // timeout, which is the bug this grant exists to remove.
      await login(host);

      expect(await hasStoredSession(host)).toBe(true);
      expect(provider.tokenGrants).toContain(
        'urn:ietf:params:oauth:grant-type:device_code',
      );
      expect(provider.tokenGrants).not.toContain('authorization_code');
      expect(await getSessionToken(host)).toBe('access-1');
      // Nothing was bound: no authorize request, so no loopback server.
      expect(provider.redirectUris).toEqual([]);
    });

    test('the code request carries the client id and the tenant audience', async () => {
      provider.cfg.deviceGrant = true;
      device();

      await login(loginHost);

      expect(provider.deviceRequests).toHaveLength(1);
      expect(provider.deviceRequests[0]).toMatchObject({
        clientId: 'cli-client-id',
        resource: 'tenant://t-1',
        scope: 'openid profile email offline_access tenant:t-1:user',
      });
      // One host, one audience: the poll must ask for the same one.
      expect(provider.resources).toContain('tenant://t-1');
    });

    test('the session it stores refreshes like any other', async () => {
      provider.cfg.deviceGrant = true;
      device();
      await login(host);
      const before = provider.tokenGrants.length;

      const token = await getSessionToken(host, { forceRefresh: true });

      expect(provider.tokenGrants.slice(before)).toEqual(['refresh_token']);
      expect(token).toBe('access-2');
    });

    test('refused when the server advertises no device endpoint', async () => {
      provider.cfg.deviceGrant = false;
      device();

      expect(login(host)).rejects.toThrow(/Authentication required/);
      expect(await hasStoredSession(host)).toBe(false);
    });

    test('discovery refuses a device endpoint on another origin', async () => {
      // A device flow has no callback, so issuerMismatch() never runs on this
      // leg — the origin check at discovery is the only thing standing between
      // a tampered document and a code sent to an attacker.
      provider.cfg.deviceGrant = 'cross-origin';
      device();

      expect(login(host)).rejects.toThrow(/different origin/);
    });

    test('auto refuses in CI even when the grant is on offer', async () => {
      provider.cfg.deviceGrant = true;
      process.env.SEMANTIUS_LOGIN_FLOW = 'auto';
      const savedCi = process.env.CI;
      process.env.CI = 'true';
      try {
        expect(login(host)).rejects.toThrow(/CI environment/);
      } finally {
        if (savedCi === undefined) delete process.env.CI;
        else process.env.CI = savedCi;
      }
    });
  });

  // --------------------------------------------------------------------
  describe('login, refresh, logout', () => {
    test('stores a session that getSessionToken serves', async () => {
      expect(await hasStoredSession(host)).toBe(false);

      await login(host, { openUrl });

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
      await login(host, { openUrl });
      const before = provider.tokenGrants.length;

      const token = await getSessionToken(host, { forceRefresh: true });

      expect(token).not.toBe('access-1');
      expect(provider.tokenGrants.slice(before)).toEqual(['refresh_token']);
    });

    test('a fresh token is served without contacting the provider', async () => {
      await login(host, { openUrl });
      const before = provider.tokenGrants.length;

      await getSessionToken(host);

      expect(provider.tokenGrants.length).toBe(before);
    });

    test('a fresh token is served without the .well-known documents', async () => {
      await login(host, { openUrl });

      // A host name this process has not discovered for: discovery is memoized
      // per host, so asking under the logged-in name would hide the fetch that
      // a real (one-command-per-process) invocation pays for. Copy the session
      // across, so only the cached-token path can answer.
      const probe: HostFacts = { ...host, host: 'fresh-probe.example' };
      await copySessionTo(host.host, probe.host);
      provider.paths.length = 0;

      expect(await getSessionToken(probe)).toBe('access-1');

      // The endpoints are only needed to spend the refresh token. Fetching
      // them to hand back a cached one cost two round trips per invocation.
      expect(provider.paths.filter((p) => p.includes('.well-known'))).toEqual(
        [],
      );
    });

    test('a cloud host serves its token under the resource key', async () => {
      await login(loginHost, { openUrl });
      // No refresh needed to get there: a login now stores its token under the
      // key for the audience it asked for (see labelStoredTokens).
      await getSessionToken(loginHost);

      // Its own host name, so a miss has to rediscover (see the test above).
      const probe: HostFacts = { ...loginHost, host: 'cloud-probe.example' };
      await copySessionTo(loginHost.host, probe.host);
      provider.paths.length = 0;

      expect(await getSessionToken(probe)).toBeTruthy();

      // A cache key that did not match cli-auth's own "resource=<uri>" form
      // would miss here and rediscover — reintroducing, for cloud users only
      // and with the suite still green, the cost this change exists to remove.
      expect(provider.paths.filter((p) => p.includes('.well-known'))).toEqual(
        [],
      );
    });

    test('a token inside the refresh threshold is refreshed', async () => {
      await login(host, { openUrl });
      const before = provider.tokenGrants.length;

      // 60 s of life left: still valid, but inside the 300 s threshold, so a
      // refresh is due. The cache read must decline it rather than serve a
      // token that could expire in flight.
      const stored = await storedSession(host.host);
      for (const token of Object.values(stored?.tokens ?? {})) {
        token.expires_at = Date.now() + 60_000;
      }
      await storeSession(host.host, stored as TokenSet);

      const token = await getSessionToken(host);

      expect(provider.tokenGrants.slice(before)).toEqual(['refresh_token']);
      expect(token).not.toBe('access-1');
    });

    test('endpoints are cached for a host with no control-plane record', async () => {
      // A self-hosted host has no record, and the endpoints used to be written
      // only alongside one — so the write was dropped and every invocation
      // rediscovered. Its own host name: discovery is memoized per host, and
      // only a discovery that actually runs can write the cache.
      const probe: HostFacts = { ...loginHost, host: 'cache-probe.example' };
      expect(readCachedOAuthMetadata(probe.host)).toBeNull();

      await login(probe, { openUrl });

      const cached = readCachedOAuthMetadata(probe.host);
      expect(cached?.tokenEndpoint).toBe(`${provider.origin}/token`);
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
  describe('platform document', () => {
    /** What the bundled deployment serves today, field for field. */
    const bundledDoc = (over: Record<string, unknown> = {}) => ({
      version: 1,
      host_type: 'selfhost',
      idp_type: 'semantius',
      idp_well_known: '/.well-known/openid-configuration',
      client_id_cli: 'semantius-cli',
      redirect_uris: [
        'http://127.0.0.1:53682/callback',
        'http://127.0.0.1:53683/callback',
        'http://127.0.0.1:53684/callback',
        'http://127.0.0.1:18682/callback',
        'http://127.0.0.1:28682/callback',
      ],
      scope: '',
      audience: 'semantius://api',
      gateway_url: '/gateway/rest',
      api_url: '/rest',
      ...over,
    });

    /** The Entra shape: an absolute discovery URL, a GUID, an explicit scope. */
    const GUID = '11111111-2222-3333-4444-555555555555';
    const entraDoc = (over: Record<string, unknown> = {}) => ({
      version: 1,
      host_type: 'selfhost',
      idp_type: 'entra',
      idp_well_known: `${provider.origin}/entra/tid/v2.0/.well-known/openid-configuration`,
      client_id_cli: GUID,
      redirect_uris: [
        'http://127.0.0.1:53682/callback',
        'http://127.0.0.1:53683/callback',
        'http://127.0.0.1:53684/callback',
        'http://127.0.0.1:18682/callback',
        'http://127.0.0.1:28682/callback',
      ],
      scope: 'openid profile email offline_access api://app-id/access_as_user',
      audience: 'api://app-id',
      ...over,
    });

    /** A host name no other case uses: discovery is memoized per host. */
    const named = (name: string): HostFacts => ({ ...host, host: name });

    /** Move a stored session to a host name this process has not resolved. */
    const copySession = (from: HostFacts, to: HostFacts) =>
      copySessionTo(from.host, to.host);

    test('a document configures the login in one OIDC discovery hop', async () => {
      provider.cfg.platformDoc = bundledDoc();
      const target = named('platform-bundled.example');

      await login(target, { openUrl });

      expect(provider.paths).toContain('/.well-known/semantius.json');
      expect(provider.paths).toContain('/.well-known/openid-configuration');
      // The legacy chain is not walked at all: no RFC 9728 hop, and no
      // RFC 8414 path-suffix transform of the issuer.
      expect(
        provider.paths.filter((p) => p.includes('oauth-protected-resource')),
      ).toEqual([]);
      expect(
        provider.paths.filter((p) => p.includes('oauth-authorization-server')),
      ).toEqual([]);
      expect(provider.clientIds).toEqual(['semantius-cli']);
      // An empty scope means "whatever discovery advertises" — the base scopes.
      expect(provider.scopes).toEqual(['openid profile email offline_access']);
      // cli-auth sends the resource on the token request, never on authorize.
      expect(provider.resources).toEqual(['', 'semantius://api']);
    });

    test('the first read after a login costs nothing', async () => {
      // cli-auth's login() saves its token under the *empty* cache key whatever
      // resource it asked for, which would leave this host with two entries for
      // its one audience — and make the very next read miss and spend the
      // refresh token to mint a duplicate. labelStoredTokens files it under the
      // audience it was actually minted for, so the first read finds it.
      provider.cfg.platformDoc = bundledDoc();
      const target = named('platform-firstread.example');

      await login(target, { openUrl });

      expect(await getSessionToken(target)).toBe('access-1');
      expect(provider.tokenGrants).toEqual(['authorization_code']);
      expect(provider.resources).toEqual(['', 'semantius://api']);
    });

    test('a login leaves exactly one access token, keyed by the audience', async () => {
      provider.cfg.platformDoc = bundledDoc();
      const target = named('platform-onekey.example');

      await login(target, { openUrl });

      const stored = await storedSession(target.host);
      expect(Object.keys(stored?.tokens ?? {})).toEqual([
        'resource=semantius://api',
      ]);
    });

    test('an absolute discovery URL is taken as given, with the document scope verbatim', async () => {
      provider.cfg.platformDoc = entraDoc();
      // No iss on the callback, and metadata that promises none: sound.
      provider.cfg.callbackIss = null;
      const target = named('platform-entra.example');

      await login(target, { openUrl });

      expect(provider.paths).toContain(
        '/entra/tid/v2.0/.well-known/openid-configuration',
      );
      expect(
        provider.paths.filter((p) => p.includes('oauth-authorization-server')),
      ).toEqual([]);
      expect(provider.clientIds).toEqual([GUID]);
      expect(provider.scopes).toEqual([
        'openid profile email offline_access api://app-id/access_as_user',
      ]);
      expect(provider.resources).toEqual(['', 'api://app-id']);
    });

    test('logout succeeds against metadata with no revocation endpoint', async () => {
      provider.cfg.platformDoc = entraDoc();
      provider.cfg.callbackIss = null;
      const target = named('platform-entra-logout.example');
      await login(target, { openUrl });
      provider.paths.length = 0;

      expect(await logout(target)).toBe(true);

      expect(provider.revoked).toEqual([]);
      expect(await hasStoredSession(target)).toBe(false);
      // Nothing to revoke is known from the cached metadata, so the logout
      // makes no request at all — not even to rediscover endpoints it would
      // then have no use for.
      expect(provider.paths).toEqual([]);
    });

    test('an authorization endpoint on another origin than the issuer is refused', async () => {
      provider.cfg.platformDoc = entraDoc();
      provider.cfg.entraCrossOrigin = true;
      const target = named('platform-crossorigin.example');

      await expect(login(target, { openUrl })).rejects.toThrow(
        /different origin/,
      );
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a 404 falls back to the legacy chain', async () => {
      const target = named('platform-404.example');

      await login(target, { openUrl });

      expect(provider.paths).toContain('/.well-known/semantius.json');
      expect(provider.paths).toContain('/.well-known/oauth-protected-resource');
      expect(provider.clientIds).toEqual([SELF_HOSTED_CLIENT_ID as string]);
      expect(provider.resources).toEqual(['', '']);
    });

    test('an un-upgraded deployment answering 200 text/html falls back too', async () => {
      provider.cfg.platformDoc = 'html';
      const target = named('platform-html.example');

      await login(target, { openUrl });

      expect(provider.paths).toContain('/.well-known/oauth-protected-resource');
      expect(provider.clientIds).toEqual([SELF_HOSTED_CLIENT_ID as string]);
      expect(provider.resources).toEqual(['', '']);
    });

    test('a catch-all route answering JSON that is not an object is an absence', async () => {
      // A PostgREST-shaped deployment answers `[]` for every unknown path with
      // Content-Type: application/json. That is a host with no document, not a
      // host whose document is broken.
      provider.cfg.platformDoc = [] as unknown as Record<string, unknown>;
      const target = named('platform-array.example');

      await login(target, { openUrl });

      expect(provider.paths).toContain('/.well-known/oauth-protected-resource');
      expect(provider.clientIds).toEqual([SELF_HOSTED_CLIENT_ID as string]);
    });

    test('a front door that fails is not an absent document', async () => {
      provider.cfg.platformDoc = 'broken';
      const target = named('platform-broken.example');

      await expect(login(target, { openUrl })).rejects.toThrow(
        /semantius\.json returned 502/,
      );
      // Not a silent fallback: the legacy chain is never reached, so a login
      // cannot quietly proceed with the wrong client id.
      expect(
        provider.paths.filter((p) => p.includes('oauth-protected-resource')),
      ).toEqual([]);
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a document whose fields are empty names them, and does not blame the version', async () => {
      // Shape before version: this document is *both* empty and from the
      // future, and a front door that serves it with its variables
      // unsubstituted is the likely cause of both. Reporting the version would
      // send the operator to upgrade a CLI that is not the problem.
      provider.cfg.platformDoc = {
        version: 2,
        host_type: 'selfhost',
        idp_type: '',
        idp_well_known: '',
        client_id_cli: '',
        scope: '',
        audience: '',
      };
      const target = named('platform-empty.example');

      const error = await login(target, { openUrl }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /idp_well_known and client_id_cli are empty/,
      );
      expect((error as Error).message).not.toMatch(/version/i);
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a document from the future refuses rather than guesses', async () => {
      provider.cfg.platformDoc = bundledDoc({ version: 2 });
      const target = named('platform-v2.example');

      const error = await login(target, { openUrl }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(LoginUnavailableError);
      expect((error as Error).message).toMatch(/UNSUPPORTED_VERSION/);
      expect((error as Error).message).toMatch(/Upgrade semantius-cli/);
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('the callback is the first free URI the document lists, port and path together', async () => {
      // No hardcoded ports: one listener held open is busy, one bound and
      // stopped is known free.
      const busy = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data() {} },
      });
      const free = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data() {} },
      });
      const freePort = free.port;
      free.stop(true);
      try {
        provider.cfg.platformDoc = bundledDoc({
          redirect_uris: [
            `http://127.0.0.1:${busy.port}/callback`,
            `http://127.0.0.1:${freePort}/cb`,
          ],
        });
        const target = named('platform-ports.example');

        await login(target, { openUrl });

        // Both halves of the second entry: its port *and* its path.
        expect(provider.redirectUris).toEqual([
          `http://127.0.0.1:${freePort}/cb`,
        ]);
      } finally {
        busy.stop(true);
      }
    });

    test('a document listing no redirect URIs falls back to the registered ports', async () => {
      provider.cfg.platformDoc = bundledDoc({ redirect_uris: [] });
      const target = named('platform-noredirects.example');

      await login(target, { openUrl });

      expect(provider.redirectUris[0]).toMatch(
        /^http:\/\/127\.0\.0\.1:(5368[234]|18682|28682)\/callback$/,
      );
    });

    test('a localhost redirect URI is refused, not silently replaced', async () => {
      // cli-auth binds 127.0.0.1 and builds its redirect_uri from it, so a
      // "localhost" registration cannot be honoured. Falling back to the
      // default ports would send an unregistered redirect_uri and earn an
      // error from the IdP that blames the wrong thing.
      provider.cfg.platformDoc = bundledDoc({
        redirect_uris: ['http://localhost:53682/callback'],
      });
      const target = named('platform-localhost.example');

      const error = await login(target, { openUrl }).catch((e: Error) => e);

      expect(error).toBeInstanceOf(LoginUnavailableError);
      expect((error as Error).message).toMatch(/semantius\.json/);
      expect((error as Error).message).toMatch(/http:\/\/localhost:53682/);
      expect(provider.redirectUris).toEqual([]);
    });

    test('a non-loopback http discovery URL is refused before it is fetched', async () => {
      // .invalid is reserved and never resolves (RFC 2606), so if this check
      // ever regresses the suite fails instead of reaching out of the sandbox.
      provider.cfg.platformDoc = bundledDoc({
        idp_well_known: 'http://idp.invalid/.well-known/openid-configuration',
      });
      const target = named('platform-insecure.example');

      // "Before it is fetched" is the claim, so watch every request the login
      // makes: provider.paths only records what reaches the mock, and would be
      // empty whether or not the CLI called out to idp.invalid.
      const realFetch = globalThis.fetch;
      const requested: string[] = [];
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        requested.push(String(input instanceof Request ? input.url : input));
        return realFetch(input, init);
      }) as typeof fetch;

      try {
        // The specific refusal, not merely "it failed": a DNS error would
        // carry a different message, and would mean the fetch was attempted.
        await expect(login(target, { openUrl })).rejects.toThrow(
          /names a non-HTTPS idp_well_known/,
        );
      } finally {
        globalThis.fetch = realFetch;
      }

      expect(requested).toContain(
        `${provider.origin}/.well-known/semantius.json`,
      );
      expect(requested.filter((u) => u.includes('idp.invalid'))).toEqual([]);
      expect(await hasStoredSession(target)).toBe(false);
    });

    test('a platform slot written before docVersion existed is refetched', async () => {
      const target = named('platform-shape.example');
      writeFileSync(
        getHostCachePath(target.host),
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          platform: {
            docUrl: 'http://x.example/.well-known/semantius.json',
            idpWellKnown: 'http://x.example/.well-known/openid-configuration',
            clientId: 'semantius-cli',
          },
        }),
      );

      expect(readCachedPlatformConfig(target.host)).toBeNull();
    });

    test('an absent document is remembered, so the fallback costs one request', async () => {
      const target = named('platform-negative.example');

      expect(await getPlatformConfig(target)).toBeNull();
      expect(readCachedPlatformConfig(target.host)).toEqual({ absent: true });

      // Forget the in-process memo, so what answers the second call is the
      // marker on disk — which is the thing that saves a later invocation a
      // request, and the thing the shape guard could wrongly reject.
      clearPlatformMemoForTests();

      const before = provider.paths.filter((p) =>
        p.includes('semantius.json'),
      ).length;
      expect(await getPlatformConfig(target)).toBeNull();
      expect(
        provider.paths.filter((p) => p.includes('semantius.json')).length,
      ).toBe(before);
      expect(before).toBe(1);
    });

    test('a rolled-over platform cache is refetched, and the refresh still carries the resource', async () => {
      // The 24 h TTL drops the whole cache entry, so the sync read in
      // getSessionToken misses while the document is perfectly healthy. If the
      // resource were taken from that miss rather than re-derived from the
      // fetch below, cli-auth would refresh with no resource at all and store
      // the result under the empty key.
      provider.cfg.platformDoc = bundledDoc();
      const source = named('platform-rollover.example');
      await login(source, { openUrl });
      await getSessionToken(source);

      // A later process, with no memo and no cache entry for this name.
      const probe = named('platform-rolled.example');
      await copySession(source, probe);
      provider.paths.length = 0;
      provider.resources.length = 0;

      const token = await getSessionToken(probe, { forceRefresh: true });

      expect(provider.paths).toContain('/.well-known/semantius.json');
      expect(provider.resources.at(-1)).toBe('semantius://api');
      expect(token).toBe('access-2');
    });

    test('a document that goes absent does not send an audience-bearing session back to the empty key', async () => {
      provider.cfg.platformDoc = bundledDoc();
      const source = named('platform-audience.example');
      await login(source, { openUrl });
      await getSessionToken(source);

      // The dangerous shape: the document stops being served *cleanly*, which
      // is an absence the fetch layer cannot tell from an un-upgraded host.
      provider.cfg.platformDoc = null;
      const probe = named('platform-audience-gone.example');
      await copySession(source, probe);
      const before = provider.tokenGrants.length;

      // No forceRefresh: this is the path every ordinary command takes, and
      // the one where the stored empty-key token is still fresh and would be
      // served if the cache-only read guessed "no resource".
      await expect(getSessionToken(probe)).rejects.toThrow(
        /no longer serves .*semantius\.json/,
      );
      // And the same on the refreshing path.
      await expect(
        getSessionToken(probe, { forceRefresh: true }),
      ).rejects.toThrow(/no longer serves .*semantius\.json/);
      expect(provider.tokenGrants.length).toBe(before);
    });

    test('logging in again clears a token keyed for an audience that is gone', async () => {
      // Without this the refusal above would be unrecoverable: cli-auth merges
      // into the stored token set, so the old "resource=" entry would survive a
      // fresh login and keep tripping the check.
      provider.cfg.platformDoc = bundledDoc();
      const target = named('platform-relogin.example');
      await login(target, { openUrl });
      await getSessionToken(target);

      provider.cfg.platformDoc = null;
      await login(target, { openUrl });

      expect(await getSessionToken(target, { forceRefresh: true })).toBe(
        'access-3',
      );
    });

    test('a session with no audience still works when the document is absent', async () => {
      // The other half of the rule above: a host that never had a document
      // keeps its tokens under the empty key, and must keep working.
      const source = named('platform-legacy.example');
      await login(source, { openUrl });

      const probe = named('platform-legacy-probe.example');
      await copySession(source, probe);

      // Cached: served without resolving anything at all.
      expect(await getSessionToken(probe)).toBe('access-1');
      // And refreshed: still under the empty key, which is correct here.
      expect(await getSessionToken(probe, { forceRefresh: true })).toBe(
        'access-2',
      );
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
      await login(host, { openUrl });
      process.env.SEMANTIUS_JWT = 'static-jwt';
      setAuthFlag('oauth');

      expect(await getAccessToken(host)).toBe('access-1');
      expect(getUsedCredentialSource()).toBe('oauth');
    });

    test('the session is used when the environment has no credential', async () => {
      await login(host, { openUrl });

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
    const spawnLogin = (env: Record<string, string>) => {
      const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
      return Bun.spawn(['bun', 'run', cliPath, '--login', 'whoami'], {
        env: {
          ...process.env,
          SEMANTIUS_HOST: host.host,
          SEMANTIUS_API_KEY: '',
          SEMANTIUS_JWT: '',
          SEMANTIUS_NO_DAEMON: '1',
          // The suite sets this for the in-process logins; these two cases are
          // about the guard that runs before any of that, so each states it.
          SEMANTIUS_LOGIN_FLOW: '',
          ...env,
        },
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    };

    test('needs an interactive terminal', async () => {
      const proc = spawnLogin({});
      const stderr = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(1);
      expect(stderr).toContain(
        'Error [LOGIN_FAILED]: --login needs an interactive terminal',
      );
    });

    test('an explicit --login-flow gets past it: the device grant needs no stdin', async () => {
      // Without this the stdin proxy would refuse the one grant that works on
      // a headless box, where stdin is routinely not a TTY.
      const proc = spawnLogin({ SEMANTIUS_LOGIN_FLOW: 'device' });
      const stderr = await new Response(proc.stderr).text();

      expect(stderr).not.toContain('needs an interactive terminal');
      // It gets as far as the grant chooser, which refuses for its own reason:
      // this provider advertises no device endpoint.
      expect(stderr).toContain('does not offer the device code grant');
      expect(await proc.exited).toBe(5);
    });
  });

  // --------------------------------------------------------------------
  describe('host index self-heal (getSessionToken)', () => {
    test('records the host once a session is found, never before', async () => {
      expect(hasHost(host.host)).toBe(false);

      // No session yet: the null path must not record a host with no session.
      expect(await getSessionToken(host)).toBeNull();
      expect(hasHost(host.host)).toBe(false);

      await login(host, { openUrl });
      expect(await getSessionToken(host)).toBe('access-1');

      expect(hasHost(host.host)).toBe(true);
      const entry = listHosts().find((h) => h.host === host.host);
      expect(entry).toMatchObject({ mode: 'selfhosted', org: null });
      // Self-healed, not an explicit login record: no loggedInAt.
      expect(entry?.loggedInAt).toBeUndefined();
    });

    test('does not touch an already-indexed host', async () => {
      await login(host, { openUrl });
      recordHost(
        host.host,
        { mode: 'selfhosted', org: null },
        { loggedInAt: '2020-01-01T00:00:00.000Z' },
      );

      await getSessionToken(host);

      expect(listHosts().find((h) => h.host === host.host)?.loggedInAt).toBe(
        '2020-01-01T00:00:00.000Z',
      );
    });
  });

  // --------------------------------------------------------------------
  describe('hasStoredSessionFor / getSessionExpiryFor', () => {
    test('false / undefined before login, true / a timestamp after', async () => {
      expect(await hasStoredSessionFor(host.host)).toBe(false);
      expect(await getSessionExpiryFor(host.host)).toBeUndefined();

      await login(host, { openUrl });

      expect(await hasStoredSessionFor(host.host)).toBe(true);
      expect(await getSessionExpiryFor(host.host)).toMatch(/^\d{4}-/);
    });

    test('never print the keyring-fallback announcement (quiet)', async () => {
      const broken: SecretsApi = {
        async get() {
          throw new Error('no keyring');
        },
        async set() {
          throw new Error('no keyring');
        },
        async delete() {
          throw new Error('no keyring');
        },
      };
      setSecretsForTests(broken);
      const stderrLines: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        stderrLines.push(args.join(' '));
      };
      try {
        await hasStoredSessionFor('never-logged-in.example.com');
      } finally {
        console.error = origError;
        setSecretsForTests(secrets);
      }
      expect(
        stderrLines.some((l) => l.includes('no OS keyring available')),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  describe('loginCommand: recording, no current-host side effect', () => {
    /** Capture console.log lines for the duration of `fn`. */
    async function captureLog(fn: () => Promise<void>): Promise<string[]> {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.join(' '));
      };
      try {
        await fn();
      } finally {
        console.log = orig;
      }
      return lines;
    }

    test('records the host with loggedInAt', async () => {
      await loginCommand({ openUrl });
      const entry = listHosts().find((h) => h.host === host.host);
      expect(entry).toMatchObject({ mode: 'selfhosted', org: null });
      expect(entry?.loggedInAt).toMatch(/^\d{4}-/);
    });

    test('prints the login confirmation', async () => {
      const lines = await captureLog(() => loginCommand({ openUrl }));
      expect(lines.some((l) => l.includes(`Logged in to ${host.host}`))).toBe(
        true,
      );
    });

    // The core invariant this redesign relies on: login only stores a
    // session, never picks a current host — "semantius use" is the one
    // command that does that (see commands/hosts.ts's useCommand). Setting
    // the current host to some OTHER host would itself change what
    // resolveHost() resolves to (the current host now outranks
    // SEMANTIUS_HOST — that is the whole point of the redesign), so this
    // uses host.host itself for the "already set" case to isolate the one
    // thing being tested: whether loginCommand leaves it alone.
    test('never sets or changes the current host', async () => {
      expect(getCurrentHost()).toBeNull();
      await loginCommand({ openUrl });
      expect(getCurrentHost()).toBeNull();

      setCurrentHost(host.host);
      await loginCommand({ openUrl });
      expect(getCurrentHost()).toBe(host.host);
    });
  });

  // --------------------------------------------------------------------
  describe('logoutCommand: host index', () => {
    async function captureError(fn: () => Promise<void>): Promise<string[]> {
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.join(' '));
      };
      try {
        await fn();
      } finally {
        console.error = orig;
      }
      return lines;
    }

    test('removes the entry and hints when it was the current host', async () => {
      await login(host, { openUrl });
      recordHost(host.host, { mode: 'selfhosted', org: null });
      setCurrentHost(host.host);

      const lines = await captureError(logoutCommand);

      expect(hasHost(host.host)).toBe(false);
      expect(getCurrentHost()).toBeNull();
      expect(lines.some((l) => l.includes('was the current host'))).toBe(true);
    });

    test('removes the entry with no hint when it was not the current host', async () => {
      await login(host, { openUrl });
      recordHost(host.host, { mode: 'selfhosted', org: null });
      setCurrentHost('other.example.com');
      // The current host now outranks SEMANTIUS_HOST, so resolveHost() would
      // otherwise resolve to 'other.example.com' instead of host.host — force
      // it back to host.host with --host, isolating the one thing under test.
      setHostFlag(host.host);

      const lines = await captureError(logoutCommand);

      expect(hasHost(host.host)).toBe(false);
      expect(getCurrentHost()).toBe('other.example.com');
      expect(lines.length).toBe(0);
    });

    test('removes a recorded host even with no stored session', async () => {
      recordHost(host.host, { mode: 'selfhosted', org: null });
      await logoutCommand();
      expect(hasHost(host.host)).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  describe('MCP route', () => {
    const config = {
      url: 'https://acme.semantius.ai/mcp',
      headers: { 'x-api-key': '' },
    };

    test('an empty x-api-key becomes the session bearer', async () => {
      await login(host, { openUrl });

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
