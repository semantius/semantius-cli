/**
 * Tests for the host index CLI surface (src/commands/hosts.ts): the "hosts"
 * table / --json output, per-host session probing, the one-time sessions-dir
 * migration scan, and "use". The keyring is a fake object (never Bun.secrets)
 * and the user config dir is redirected to a temp dir, so nothing here
 * touches the real OS keyring or a developer's own hosts.json.
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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasStoredSessionFor } from '../src/auth/session';
import { hostsCommand, useCommand } from '../src/commands/hosts';
import {
  type SecretsApi,
  createSecretStorage,
  sessionName,
  setSecretsForTests,
} from '../src/auth/storage';
import { getUserConfigDir, setEnvPrefix, setHostFlag } from '../src/config';
import { getHostCachePath, setHostCacheDirForTests } from '../src/host';
import {
  getCurrentHost,
  hasHost,
  recordHost,
  sessionsScannedAt,
  setCurrentHost,
  setHostsIndexDirForTests,
} from '../src/hosts-index';

/** An in-memory stand-in for Bun.secrets, same shape as auth.test.ts's. */
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

/** Capture console.log for the duration of `fn`, returning the printed lines. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

/**
 * Run `fn` with console.error captured, returning its lines and whatever `fn`
 * threw (undefined when it resolved) — the useCommand cases below assert on
 * both what was printed and how it failed.
 */
async function captureError(
  fn: () => Promise<void>,
): Promise<{ lines: string[]; error: Error | undefined }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
    return { lines, error: undefined };
  } catch (error) {
    return { lines, error: error as Error };
  } finally {
    console.error = orig;
  }
}

/** The exit code an error names for main() to exit with, if any. */
function exitCodeOf(error: unknown): number | undefined {
  return (error as { exitCode?: number } | undefined)?.exitCode;
}

/** The tenant every seeded cloud host resolves to. */
const TENANT_ID = 'fake-tenant';

/**
 * Seed a cloud host's control-plane record in the (redirected) host cache, so
 * resolving it — which `use` now does to verify the session — needs no
 * network.
 */
async function seedCloudHost(host: string): Promise<void> {
  await writeFile(
    getHostCachePath(host),
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      record: {
        id: TENANT_ID,
        postgrest_url: 'https://pg.example.test/rest/v1/',
        client_id_cli: null,
      },
    }),
  );
}

/**
 * Store a session for `host` through the storage API, sealed to its name as a
 * real login leaves it (AGENTS.md: never reach into the fake keyring).
 * `resource` is the key its access token is filed under: a cloud host's is
 * its tenant (resourceIndicator in src/auth/session.ts); a self-hosted host
 * with no audience has none. `fresh: false` stores one already due for
 * refresh, so reading it means a round trip to the token endpoint: a minute
 * left, inside the CLI's 5-minute refresh margin. Not one already expired —
 * the storage drops those on save, and a session with no access token left
 * reads as no session at all.
 */
async function storeSession(
  host: string,
  opts: { resource?: string; fresh?: boolean } = {},
): Promise<void> {
  const key = opts.resource ? `resource=${opts.resource}` : '';
  const expiresAt =
    opts.fresh === false ? Date.now() + 60_000 : Date.now() + 3_600_000;
  await createSecretStorage(sessionName(host)).save({
    refresh_token: 'r',
    tokens: { [key]: { access_token: 'a', expires_at: expiresAt } },
  });
}

/** A usable session on a cloud host, as `use` finds it after a login. */
async function storeCloudSession(host: string): Promise<void> {
  await seedCloudHost(host);
  await storeSession(host, { resource: `tenant://${TENANT_ID}` });
}

describe('commands/hosts (in-process)', () => {
  let configDir: string;
  let secrets: ReturnType<typeof fakeSecrets>;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'semantius-hosts-cmd-'));
    process.env.APPDATA = configDir;
    process.env.LOCALAPPDATA = configDir;
    process.env.HOME = configDir;
    setEnvPrefix('SEMANTIUS');
    setHostFlag(undefined);
    delete process.env.SEMANTIUS_ORG;
    delete process.env.SEMANTIUS_HOST;
    // hosts-index.ts caches its file in a module variable; APPDATA/HOME just
    // changed, so force it to forget whatever the previous test's dir held.
    setHostsIndexDirForTests(undefined);
    setHostCacheDirForTests(configDir);
    secrets = fakeSecrets();
    setSecretsForTests(secrets);
  });

  afterEach(async () => {
    setSecretsForTests(undefined);
    setHostsIndexDirForTests(undefined);
    setHostCacheDirForTests(undefined);
    setHostFlag(undefined);
    delete process.env.SEMANTIUS_ORG;
    delete process.env.SEMANTIUS_HOST;
    await rm(configDir, { recursive: true, force: true });
  });

  describe('hostsCommand', () => {
    test('an empty index hints at "use"', async () => {
      const lines = await captureLog(() => hostsCommand({}));
      expect(lines).toEqual([
        'No hosts yet. Run "semantius use <host>" to sign in to one and make it current.',
        'No instance yet? Sign up at https://app.semantius.com to get yours and the steps to connect.',
      ]);
    });

    test('table: mode, org, session, current-host marker, and a drift row (no session)', async () => {
      recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
      recordHost('x.example.com', { mode: 'selfhosted', org: null });
      setCurrentHost('acme.semantius.cloud');
      await storeSession('acme.semantius.cloud');
      // x.example.com is recorded but has no session: the index and the
      // credential store have drifted apart.

      const lines = await captureLog(() => hostsCommand({}));
      const out = lines.join('\n');

      expect(out).toContain('HOST');
      expect(out).toContain('MODE');
      expect(out).toMatch(/\*\s+acme\.semantius\.cloud\s+cloud\s+acme\s+yes/);
      expect(out).toMatch(/x\.example\.com\s+selfhosted\s+\(none\)\s+no\s+-/);
      // The current host IS what resolves here: nothing else names one.
      expect(lines.at(-1)).toBe('current: acme.semantius.cloud (current)');
    });

    test('"current" reflects getHost() / getHostSource() for this directory', async () => {
      recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
      setCurrentHost('acme.semantius.cloud');
      setHostFlag('other.example.com');

      const lines = await captureLog(() => hostsCommand({}));
      expect(lines.at(-1)).toBe('current: other.example.com (flag)');
    });

    test('--json: currentHost, current, and the full row shape', async () => {
      recordHost(
        'acme.semantius.cloud',
        { mode: 'cloud', org: 'acme' },
        { loggedInAt: '2026-01-01T00:00:00.000Z' },
      );
      setCurrentHost('acme.semantius.cloud');
      await storeSession('acme.semantius.cloud');
      // The current host beats SEMANTIUS_ORG now, unlike under the old
      // last-rung design — set it here to prove that, not just to give
      // getHost() something to resolve.
      process.env.SEMANTIUS_ORG = 'acme';

      const lines = await captureLog(() => hostsCommand({ json: true }));
      const parsed = JSON.parse(lines.join('\n'));

      expect(parsed.currentHost).toBe('acme.semantius.cloud');
      expect(parsed.current).toEqual({
        host: 'acme.semantius.cloud',
        source: 'current',
      });
      expect(parsed.hosts).toHaveLength(1);
      expect(parsed.hosts[0]).toMatchObject({
        host: 'acme.semantius.cloud',
        mode: 'cloud',
        org: 'acme',
        loggedInAt: '2026-01-01T00:00:00.000Z',
        isCurrent: true,
        session: true,
      });
      expect(typeof parsed.hosts[0].sessionExpires).toBe('string');
    });

    test('--json with an empty index: still valid JSON, not the plain-text hint', async () => {
      const lines = await captureLog(() => hostsCommand({ json: true }));
      const parsed = JSON.parse(lines.join('\n'));
      expect(parsed).toEqual({ currentHost: null, current: null, hosts: [] });
    });

    test('one-time sessions scan indexes an unindexed host and reverses a mangled port', async () => {
      const sessDir = join(
        getUserConfigDir(),
        'sessions',
        'SEMANTIUS_x.example.com_8443',
      );
      await mkdir(sessDir, { recursive: true });

      expect(sessionsScannedAt()).toBeNull();
      await captureLog(() => hostsCommand({}));

      expect(hasHost('x.example.com:8443')).toBe(true);
      expect(sessionsScannedAt()).not.toBeNull();
    });

    test('does not re-scan on a later call', async () => {
      await captureLog(() => hostsCommand({})); // marks the scan done
      const scannedAt = sessionsScannedAt();

      const lateDir = join(
        getUserConfigDir(),
        'sessions',
        'SEMANTIUS_late.example.com',
      );
      await mkdir(lateDir, { recursive: true });
      await captureLog(() => hostsCommand({}));

      expect(sessionsScannedAt()).toBe(scannedAt);
      expect(hasHost('late.example.com')).toBe(false);
    });

    test('probing many hosts never prints the keyring-fallback announcement', async () => {
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
      recordHost('a.semantius.cloud', { mode: 'cloud', org: 'a' });
      recordHost('b.semantius.cloud', { mode: 'cloud', org: 'b' });

      const errLines: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errLines.push(args.join(' '));
      };
      try {
        await hostsCommand({});
      } finally {
        console.error = origError;
        setSecretsForTests(secrets);
      }
      expect(
        errLines.some((l) => l.includes('no OS keyring available')),
      ).toBe(false);
    });
  });

  describe('useCommand: success path (a session is already stored)', () => {
    test('sets the current host and records a not-yet-indexed host, "none before"', async () => {
      await storeCloudSession('acme.semantius.cloud');
      expect(hasHost('acme.semantius.cloud')).toBe(false);

      const lines = await captureLog(() =>
        useCommand({ host: 'acme.semantius.cloud' }),
      );

      expect(getCurrentHost()).toBe('acme.semantius.cloud');
      expect(hasHost('acme.semantius.cloud')).toBe(true);
      expect(lines).toEqual(['Current host: acme.semantius.cloud (none before)']);
    });

    test('reports the previous current host', async () => {
      await storeCloudSession('b.semantius.cloud');
      setCurrentHost('a.semantius.cloud');

      const lines = await captureLog(() => useCommand({ host: 'b.semantius.cloud' }));

      expect(lines).toEqual([
        'Current host: b.semantius.cloud (was a.semantius.cloud)',
      ]);
    });

    test('normalizes the host argument', async () => {
      await storeCloudSession('acme.semantius.cloud');
      await useCommand({ host: 'https://acme.semantius.app/' });
      expect(getCurrentHost()).toBe('acme.semantius.cloud');
    });

    test('does not overwrite an already-indexed host entry', async () => {
      await storeCloudSession('acme.semantius.cloud');
      recordHost(
        'acme.semantius.cloud',
        { mode: 'cloud', org: 'acme' },
        { loggedInAt: '2020-01-01T00:00:00.000Z' },
      );
      await useCommand({ host: 'acme.semantius.cloud' });
      // Still there — useCommand only recordHost()s when the entry is missing.
      expect(hasHost('acme.semantius.cloud')).toBe(true);
    });
  });

  describe('useCommand: a stored session must still work', () => {
    // A self-hosted loopback host: resolving it needs no control plane, and
    // this stub is its legacy discovery chain and token endpoint. Each test
    // stores a session for it and picks how the token endpoint answers a
    // refresh.
    let tokenReply: () => Response;
    let requests: string[];
    let server: ReturnType<typeof Bun.serve>;
    let host: string;

    beforeAll(() => {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const { origin, pathname } = new URL(req.url);
          requests.push(pathname);
          if (pathname === '/.well-known/oauth-protected-resource') {
            return Response.json({
              resource: `${origin}/mcp`,
              authorization_servers: [`${origin}/api/auth`],
            });
          }
          if (pathname === '/.well-known/oauth-authorization-server/api/auth') {
            return Response.json({
              issuer: `${origin}/api/auth`,
              authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
              token_endpoint: `${origin}/token`,
              code_challenge_methods_supported: ['S256'],
              authorization_response_iss_parameter_supported: true,
            });
          }
          if (pathname === '/token') return tokenReply();
          // Including /.well-known/semantius.json: no platform document, so
          // discovery takes the legacy chain above.
          return new Response('not found', { status: 404 });
        },
      });
      host = `127.0.0.1:${server.port}`;
    });

    afterAll(() => server.stop(true));

    // CI is what makes login() refuse instead of opening a browser, so a
    // "signs in again" case ends in a recognizable error on every platform,
    // headless Linux included. A forced login flow would bypass that check.
    let savedCi: string | undefined;
    let savedFlow: string | undefined;
    beforeEach(() => {
      requests = [];
      tokenReply = () => Response.json({ error: 'unexpected' }, { status: 500 });
      savedCi = process.env.CI;
      savedFlow = process.env.SEMANTIUS_LOGIN_FLOW;
      process.env.CI = 'true';
      delete process.env.SEMANTIUS_LOGIN_FLOW;
    });
    afterEach(() => {
      if (savedCi === undefined) delete process.env.CI;
      else process.env.CI = savedCi;
      if (savedFlow === undefined) delete process.env.SEMANTIUS_LOGIN_FLOW;
      else process.env.SEMANTIUS_LOGIN_FLOW = savedFlow;
    });

    test('a still-fresh access token: success without contacting the host', async () => {
      await storeSession(host);

      const lines = await captureLog(() => useCommand({ host }));

      expect(lines).toEqual([`Current host: ${host} (none before)`]);
      expect(getCurrentHost()).toBe(host);
      expect(requests).toEqual([]);
    });

    test('a stale token that refreshes: success', async () => {
      await storeSession(host, { fresh: false });
      tokenReply = () =>
        Response.json({
          access_token: 'fresh',
          refresh_token: 'r2',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      await captureLog(() => useCommand({ host }));

      expect(getCurrentHost()).toBe(host);
      expect(requests).toContain('/token');
    });

    test('a refresh token the provider rejects (invalid_grant): signs in again', async () => {
      await storeSession(host, { fresh: false });
      tokenReply = () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 });

      const { lines, error } = await captureError(() => useCommand({ host }));

      expect(lines).toContain(
        `The session stored for ${host} can no longer be renewed; signing in again.`,
      );
      // The login it went on to start, refused here because CI is set: a
      // missing credential, so 5 — not the 3 of a transient failure.
      expect(error?.message).toMatch(/CI environment/);
      expect(exitCodeOf(error)).toBe(5);
      expect(getCurrentHost()).toBeNull();
    });

    test('a bare 401 from the token endpoint: signs in again', async () => {
      await storeSession(host, { fresh: false });
      tokenReply = () => new Response('', { status: 401 });

      const { lines, error } = await captureError(() => useCommand({ host }));

      expect(lines.join('\n')).toContain('can no longer be renewed');
      expect(error?.message).toMatch(/CI environment/);
    });

    test('a 503 says nothing against the session: exit 3, no new login, host unchanged', async () => {
      await storeSession(host, { fresh: false });
      setCurrentHost('previous.semantius.cloud');
      tokenReply = () => new Response('', { status: 503 });

      const { lines, error } = await captureError(() => useCommand({ host }));

      expect(error?.message).toBe(
        `Error [SESSION_REFRESH_FAILED]: the session stored for ${host} could not be refreshed right now (Token request failed with status 503)\n  Suggestion: The token endpoint could not be reached or reported trouble of its own; it did not refuse the session. Try again shortly.`,
      );
      expect(exitCodeOf(error)).toBe(3);
      expect(lines.join('\n')).not.toContain('signing in again');
      expect(getCurrentHost()).toBe('previous.semantius.cloud');
    });

    test('temporarily_unavailable is transient even with an OAuth error body', async () => {
      await storeSession(host, { fresh: false });
      tokenReply = () =>
        Response.json({ error: 'temporarily_unavailable' }, { status: 503 });

      const { lines, error } = await captureError(() => useCommand({ host }));

      expect(error?.message).toMatch(/temporarily_unavailable/);
      expect(exitCodeOf(error)).toBe(3);
      expect(lines.join('\n')).not.toContain('signing in again');
      expect(getCurrentHost()).toBeNull();
    });

    test('a 503 is transient even when its body says invalid_grant', async () => {
      // A gateway or an identity provider in trouble may answer with any body;
      // only a refusal with a status of its own is a spent session.
      await storeSession(host, { fresh: false });
      tokenReply = () =>
        Response.json({ error: 'invalid_grant' }, { status: 503 });

      const { lines, error } = await captureError(() => useCommand({ host }));

      expect(error?.message).toContain('SESSION_REFRESH_FAILED');
      expect(exitCodeOf(error)).toBe(3);
      expect(lines.join('\n')).not.toContain('signing in again');
      expect(getCurrentHost()).toBeNull();
    });

    test('a 429 from the token endpoint exits 3 too', async () => {
      await storeSession(host, { fresh: false });
      tokenReply = () => new Response('', { status: 429 });

      const { error } = await captureError(() => useCommand({ host }));

      expect(error?.message).toMatch(/status 429/);
      expect(exitCodeOf(error)).toBe(3);
    });

    test('discovery answering 502 exits 3', async () => {
      // A stale session sends the refresh through discovery first; a broken
      // front door there is as transient as one at the token endpoint. A
      // server of its own: discovery is memoized per host name.
      const broken = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('', { status: 502 }),
      });
      try {
        const brokenHost = `127.0.0.1:${broken.port}`;
        await storeSession(brokenHost, { fresh: false });

        const { error } = await captureError(() =>
          useCommand({ host: brokenHost }),
        );

        expect(error?.message).toMatch(/HOST_RESOLUTION_FAILED.*returned 502/);
        expect(exitCodeOf(error)).toBe(3);
        expect(getCurrentHost()).toBeNull();
      } finally {
        broken.stop(true);
      }
    });
  });

  describe('useCommand: no stored session', () => {
    test('attempts a login instead of erroring NO_SESSION, and records nothing on failure', async () => {
      // A loopback port nothing listens on: login()'s discovery fetch fails
      // fast (ECONNREFUSED), with no DNS lookup and no browser involved.
      expect(hasHost('localhost:1')).toBe(false);

      const error = await useCommand({ host: 'localhost:1' }).catch(
        (e: Error) => e,
      );

      expect(error?.message).toContain('HOST_RESOLUTION_FAILED');
      expect(error?.message).toContain('could not reach');
      // Nothing listening is the network's trouble, not the host name's.
      expect(exitCodeOf(error)).toBe(3);
      expect(hasHost('localhost:1')).toBe(false);
      expect(getCurrentHost()).toBeNull();
    });
  });

  describe('useCommand: the control plane cannot resolve a cloud host', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
      setCurrentHost('previous.semantius.cloud');
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Every request — here only the control plane's — gets `reply`. */
    function stubFetch(reply: () => Response): void {
      globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
    }

    test('a 503 exits 3 and leaves the current host', async () => {
      stubFetch(() => new Response('', { status: 503 }));

      const error = await useCommand({ host: 'acme.semantius.cloud' }).catch(
        (e: Error) => e,
      );

      expect(error?.message).toContain(
        'the Semantius control plane returned 503',
      );
      expect(exitCodeOf(error)).toBe(3);
      expect(getCurrentHost()).toBe('previous.semantius.cloud');
    });

    test('no answer at all exits 3', async () => {
      globalThis.fetch = (async () => {
        throw new Error('Unable to connect. Is the computer able to access the url?');
      }) as unknown as typeof fetch;

      const error = await useCommand({ host: 'acme.semantius.cloud' }).catch(
        (e: Error) => e,
      );

      expect(error?.message).toContain(
        'could not reach the Semantius control plane',
      );
      expect(exitCodeOf(error)).toBe(3);
      expect(getCurrentHost()).toBe('previous.semantius.cloud');
    });

    test('an unknown organization stays a client error (exit 1)', async () => {
      stubFetch(() => new Response('', { status: 404 }));

      const error = await useCommand({ host: 'nope.semantius.cloud' }).catch(
        (e: Error) => e,
      );

      expect(error?.message).toContain(
        'organization "nope" not found on the Semantius control plane',
      );
      // No exit code of its own: main() reports it as the generic 1.
      expect(exitCodeOf(error)).toBeUndefined();
      expect(getCurrentHost()).toBe('previous.semantius.cloud');
    });
  });

  describe('useCommand: --clear', () => {
    test('clears an existing current host, naming what it was', async () => {
      setCurrentHost('acme.semantius.cloud');

      const lines = await captureLog(() => useCommand({ clear: true }));

      expect(getCurrentHost()).toBeNull();
      expect(lines).toEqual(['Current host cleared (was acme.semantius.cloud).']);
    });

    test('says so when there was no current host to clear', async () => {
      const lines = await captureLog(() => useCommand({ clear: true }));
      expect(lines).toEqual(['No current host was set.']);
    });

    test('leaves the hosts-index entry and session untouched', async () => {
      await storeSession('acme.semantius.cloud');
      recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
      setCurrentHost('acme.semantius.cloud');

      await useCommand({ clear: true });

      expect(hasHost('acme.semantius.cloud')).toBe(true);
      expect(await hasStoredSessionFor('acme.semantius.cloud')).toBe(true);
    });
  });
});

describe('commands/hosts CLI surface (spawned)', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'semantius-hosts-cli-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  async function runCli(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: {
        ...process.env,
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_JWT: '',
        SEMANTIUS_HOST: '',
        SEMANTIUS_NO_DAEMON: '1',
        APPDATA: configDir,
        LOCALAPPDATA: configDir,
        HOME: configDir,
      },
      stdin: null,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return {
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode,
    };
  }

  test('"hosts" works on a machine with nothing configured at all', async () => {
    const result = await runCli(['hosts']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No hosts yet.');
  });

  test('"use" with no stored session attempts a login instead of erroring NO_SESSION', async () => {
    // A loopback port nothing listens on: the login attempt's discovery
    // fetch fails fast (ECONNREFUSED), with no DNS lookup and no browser —
    // a network failure, so exit 3.
    const result = await runCli(['use', 'localhost:1']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain('Error [NO_SESSION]:');
    expect(result.stderr).toContain('could not reach');
  });

  test('"login" exits 3 when the host cannot be reached, like "use"', async () => {
    const result = await runCli(['login', '--host', 'localhost:1']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('could not reach');
  });

  test('"use" with an invalid host name is a client error (exit 1)', async () => {
    const result = await runCli(['use', 'ftp://acme.semantius.cloud']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_HOST');
  });

  test('"use" without a host argument is a missing argument', async () => {
    const result = await runCli(['use']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MISSING_ARGUMENT');
  });

  test('"use --clear" works on a machine with nothing configured', async () => {
    const result = await runCli(['use', '--clear']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('No current host was set.');
  });

  test('"use --clear" cannot be combined with a host argument', async () => {
    const result = await runCli(['use', 'acme.semantius.cloud', '--clear']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--clear cannot be combined with a host argument');
  });

  test('"hosts" and "use" bypass the host gate (no MISSING_ENV_VAR)', async () => {
    const hosts = await runCli(['hosts']);
    expect(hosts.stderr).not.toContain('MISSING_ENV_VAR');
    const use = await runCli(['use', 'localhost:1']);
    expect(use.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('--login cannot be combined with "hosts"', async () => {
    const result = await runCli(['--login', 'hosts']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--login cannot be combined with "hosts"');
  });

  test('--login cannot be combined with "use"', async () => {
    const result = await runCli(['--login', 'use', 'acme.semantius.cloud']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--login cannot be combined with "use"');
  });

  test('--help documents hosts, use, --json and --clear', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hosts [--json]');
    expect(result.stdout).toContain('semantius use <host>');
    expect(result.stdout).toContain('use --clear');
  });
});
