/**
 * Tests for the host index CLI surface (src/commands/hosts.ts): the "hosts"
 * table / --json output, per-host session probing, the one-time sessions-dir
 * migration scan, and "use". The keyring is a fake object (never Bun.secrets)
 * and the user config dir is redirected to a temp dir, so nothing here
 * touches the real OS keyring or a developer's own hosts.json.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostsCommand, useCommand } from '../src/commands/hosts';
import { type SecretsApi, setSecretsForTests } from '../src/auth/storage';
import { setEnvPrefix, setHostFlag } from '../src/config';
import { setHostCacheDirForTests } from '../src/host';
import {
  getDefaultHost,
  hasHost,
  recordHost,
  sessionsScannedAt,
  setDefaultHost,
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

describe('commands/hosts (in-process)', () => {
  let configDir: string;
  let secrets: ReturnType<typeof fakeSecrets>;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'semantius-hosts-cmd-'));
    process.env.APPDATA = configDir;
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

  /** Seeds a session directly into the fake keyring, keyed as storage.ts does. */
  function storeFakeSession(host: string): void {
    secrets.store.set(
      `semantius:SEMANTIUS:${host}`,
      JSON.stringify({
        refresh_token: 'r',
        tokens: { '': { access_token: 'a', expires_at: Date.now() + 3_600_000 } },
      }),
    );
  }

  describe('hostsCommand', () => {
    test('an empty index hints at login', async () => {
      const lines = await captureLog(() => hostsCommand({}));
      expect(lines).toEqual([
        'No hosts yet. Run "semantius login --host <host>" to sign in to one.',
      ]);
    });

    test('table: mode, org, session, default marker, and a drift row (no session)', async () => {
      recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
      recordHost('x.example.com', { mode: 'selfhosted', org: null });
      setDefaultHost('acme.semantius.cloud');
      storeFakeSession('acme.semantius.cloud');
      // x.example.com is recorded but has no session: the index and the
      // credential store have drifted apart.

      const lines = await captureLog(() => hostsCommand({}));
      const out = lines.join('\n');

      expect(out).toContain('HOST');
      expect(out).toContain('MODE');
      expect(out).toMatch(/\*\s+acme\.semantius\.cloud\s+cloud\s+acme\s+yes/);
      expect(out).toMatch(/x\.example\.com\s+selfhosted\s+\(none\)\s+no\s+-/);
      // The default host IS "current" here: nothing else names one.
      expect(lines.at(-1)).toBe('current: acme.semantius.cloud (default)');
    });

    test('"current" reflects getHost() / getHostSource() for this directory', async () => {
      recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
      setDefaultHost('acme.semantius.cloud');
      setHostFlag('other.example.com');

      const lines = await captureLog(() => hostsCommand({}));
      expect(lines.at(-1)).toBe('current: other.example.com (flag)');
    });

    test('--json: defaultHost, current, and the full row shape', async () => {
      recordHost(
        'acme.semantius.cloud',
        { mode: 'cloud', org: 'acme' },
        { loggedInAt: '2026-01-01T00:00:00.000Z' },
      );
      setDefaultHost('acme.semantius.cloud');
      storeFakeSession('acme.semantius.cloud');
      process.env.SEMANTIUS_ORG = 'acme';

      const lines = await captureLog(() => hostsCommand({ json: true }));
      const parsed = JSON.parse(lines.join('\n'));

      expect(parsed.defaultHost).toBe('acme.semantius.cloud');
      expect(parsed.current).toEqual({
        host: 'acme.semantius.cloud',
        source: 'org',
      });
      expect(parsed.hosts).toHaveLength(1);
      expect(parsed.hosts[0]).toMatchObject({
        host: 'acme.semantius.cloud',
        mode: 'cloud',
        org: 'acme',
        loggedInAt: '2026-01-01T00:00:00.000Z',
        isDefault: true,
        session: true,
      });
      expect(typeof parsed.hosts[0].sessionExpires).toBe('string');
    });

    test('--json with an empty index: still valid JSON, not the plain-text hint', async () => {
      const lines = await captureLog(() => hostsCommand({ json: true }));
      const parsed = JSON.parse(lines.join('\n'));
      expect(parsed).toEqual({ defaultHost: null, current: null, hosts: [] });
    });

    test('one-time sessions scan indexes an unindexed host and reverses a mangled port', async () => {
      const sessDir = join(
        configDir,
        'semantius',
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
        configDir,
        'semantius',
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

  describe('useCommand: success path', () => {
    test('sets the default and records a not-yet-indexed host, "none before"', async () => {
      storeFakeSession('acme.semantius.cloud');
      expect(hasHost('acme.semantius.cloud')).toBe(false);

      const lines = await captureLog(() =>
        useCommand({ host: 'acme.semantius.cloud' }),
      );

      expect(getDefaultHost()).toBe('acme.semantius.cloud');
      expect(hasHost('acme.semantius.cloud')).toBe(true);
      expect(lines).toEqual(['Default host: acme.semantius.cloud (none before)']);
    });

    test('reports the previous default', async () => {
      storeFakeSession('b.semantius.cloud');
      setDefaultHost('a.semantius.cloud');

      const lines = await captureLog(() => useCommand({ host: 'b.semantius.cloud' }));

      expect(lines).toEqual([
        'Default host: b.semantius.cloud (was a.semantius.cloud)',
      ]);
    });

    test('normalizes the host argument', async () => {
      storeFakeSession('acme.semantius.cloud');
      await useCommand({ host: 'https://acme.semantius.app/' });
      expect(getDefaultHost()).toBe('acme.semantius.cloud');
    });

    test('does not overwrite an already-indexed host entry', async () => {
      storeFakeSession('acme.semantius.cloud');
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

  test('"use" refuses a host with no stored session', async () => {
    const result = await runCli(['use', 'never-logged-in.example.com']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [NO_SESSION]:');
    expect(result.stderr).toContain('never-logged-in.example.com');
    expect(result.stderr).toContain('semantius login --host never-logged-in.example.com');
  });

  test('"use" without a host argument is a missing argument', async () => {
    const result = await runCli(['use']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MISSING_ARGUMENT');
  });

  test('"hosts" and "use" bypass the host gate (no MISSING_ENV_VAR)', async () => {
    const hosts = await runCli(['hosts']);
    expect(hosts.stderr).not.toContain('MISSING_ENV_VAR');
    const use = await runCli(['use', 'never-logged-in.example.com']);
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

  test('--help documents hosts, use and --json', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hosts [--json]');
    expect(result.stdout).toContain('semantius use <host>');
  });
});
