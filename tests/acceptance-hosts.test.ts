/**
 * Acceptance tests for host resolution / credential binding: the scenarios
 * from the plan (project .env resolves host A; the user has also logged in
 * to a separate host B; the current host is untouched unless stated
 * otherwise; the current host overrides a different project .env), and
 * whoami's `host` / `host_source` rows.
 *
 * Spawns the real CLI throughout, config dir redirected (APPDATA/HOME) so
 * nothing here touches a developer's own hosts.json or global .env.
 * Sessions are seeded by writing cli-auth's file-fallback format directly
 * (see seedSession) rather than driving a real browser OAuth flow; that
 * fallback is read even when the real OS keyring is available and simply
 * has no entry for the host (see src/auth/storage.ts's load()). A cloud
 * host's control-plane record is seeded the same way (seedHostCache) so
 * resolving one never needs the network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig';

function safeName(name: string): string {
  return name.replace(/[:/\\]/g, '_');
}

/**
 * The semantius config dir a child spawned with APPDATA=LOCALAPPDATA=HOME=
 * configDir resolves (getUserConfigDir, and getUserSecretsDir, which such a
 * child points at the same place): %APPDATA%\semantius on Windows,
 * ~/.config/semantius elsewhere.
 */
function semantiusDir(configDir: string): string {
  return process.platform === 'win32'
    ? join(configDir, 'semantius')
    : join(configDir, '.config', 'semantius');
}

/** Seeds a session for `host`, in cli-auth's file-fallback format. */
async function seedSession(configDir: string, host: string, prefix = 'SEMANTIUS'): Promise<void> {
  const sessionDir = join(
    semantiusDir(configDir),
    'sessions',
    safeName(`${prefix}:${host}`),
  );
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'credentials.json'),
    JSON.stringify({
      refresh_token: 'r',
      tokens: { '': { access_token: 'a', expires_at: Date.now() + 3_600_000 } },
    }),
  );
}

/** Seeds a cloud host's control-plane record so resolving it needs no network. */
async function seedHostCache(configDir: string, host: string, postgrestUrl: string): Promise<void> {
  const dir = join(semantiusDir(configDir), 'hosts');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${host.replace(/[:/]/g, '_')}.json`),
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      record: { id: 'fake-tenant', postgrest_url: postgrestUrl, client_id_cli: null },
    }),
  );
}

async function runCli(
  cwd: string,
  configDir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Strip these out entirely (not blank them): loadDotEnv only fills a var
  // that is `undefined` in the child's env, so setting them to '' here would
  // block a project .env — which these acceptance tests rely on — from ever
  // loading. Stripped from `...process.env` rather than never spreading it,
  // this also prevents this test RUNNER's own inherited value (bun auto-loads
  // the repo's real .env at startup) from leaking into the child.
  const {
    SEMANTIUS_API_KEY: _k,
    SEMANTIUS_ORG: _o,
    SEMANTIUS_JWT: _j,
    SEMANTIUS_HOST: _h,
    ...baseEnv
  } = process.env;
  const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
    cwd,
    env: {
      ...baseEnv,
      SEMANTIUS_NO_DAEMON: '1',
      SEMANTIUS_MAX_RETRIES: '0',
      SEMANTIUS_TIMEOUT: '10',
      SEMANTIUS_CONNECT_TIMEOUT: '5',
      SEMANTIUS_DISABLE_JWT_CACHE: '1', // each test's key is fresh; never serve a cached token
      APPDATA: configDir,
      LOCALAPPDATA: configDir,
      HOME: configDir,
      ...env,
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

describe('acceptance: host resolution and credential binding', () => {
  // Host A: a local self-hosted stub (token exchange + PostgREST-shaped
  // replies), so "exchanged at A" / "works" is a real, offline HTTP round trip.
  let serverA: ReturnType<typeof Bun.serve>;
  let tokenRequestsA: string[];
  let hostA: string;

  beforeAll(() => {
    serverA = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/token') {
          tokenRequestsA.push(req.headers.get('x-api-key') ?? '');
          return Response.json({ access_token: JWT, expires_in: 3600 });
        }
        return Response.json([]); // PostgREST-shaped catch-all
      },
    });
    hostA = `127.0.0.1:${serverA.port}`;
  });
  afterAll(() => serverA.stop(true));

  let configDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tokenRequestsA = [];
    configDir = await mkdtemp(join(tmpdir(), 'semantius-accept-cfg-'));
    projectDir = await mkdtemp(join(tmpdir(), 'semantius-accept-proj-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe('scenario 1: a bare API key next to HOST/ORG A', () => {
    test('logout is harmless; the next command works, key exchanged at A', async () => {
      await writeFile(
        join(projectDir, '.env'),
        `SEMANTIUS_HOST=${hostA}\nSEMANTIUS_API_KEY=sk-bare-key\n`,
      );

      const logout = await runCli(projectDir, configDir, ['logout']);
      expect(logout.exitCode).toBe(0);
      expect(logout.stdout).toContain(`No session was stored for ${hostA}.`);

      const whoami = await runCli(projectDir, configDir, ['whoami']);
      expect(whoami.exitCode).toBe(0);
      expect(tokenRequestsA).toEqual(['sk-bare-key']);
    });

    test('an org-prefixed key does not stop "login --host B": --host wins outright and the credential is ignored', async () => {
      await writeFile(
        join(projectDir, '.env'),
        `SEMANTIUS_HOST=${hostA}\nSEMANTIUS_API_KEY=a-org:sk-bound-key\n`,
      );

      const login = await runCli(projectDir, configDir, [
        'login',
        '--host',
        '127.0.0.1:1', // nothing listens here: discovery fails fast (ECONNREFUSED)
      ]);
      // No conflict: --host always wins over a credential bound at a
      // lower-precedence layer (the project .env), so login proceeds to (and
      // fails at) actually reaching the host, instead of erroring up front.
      expect(login.exitCode).toBe(1);
      expect(login.stderr).not.toContain('HOST_CONFLICT');
      expect(login.stderr).toContain('could not reach');
      expect(tokenRequestsA).toEqual([]);
    });
  });

  describe('scenario 2: HOST/ORG A with no credentials at all', () => {
    test('logout is harmless; the next command exits 5, naming A', async () => {
      await writeFile(join(projectDir, '.env'), `SEMANTIUS_HOST=${hostA}\n`);
      // A separate host B has its own session — irrelevant to A's resolution.
      await seedSession(configDir, 'b.example.com');

      const logout = await runCli(projectDir, configDir, ['logout']);
      expect(logout.exitCode).toBe(0);

      const whoami = await runCli(projectDir, configDir, ['whoami']);
      expect(whoami.exitCode).toBe(5);
      expect(whoami.stderr).toContain(`no credentials for ${hostA}`);
      expect(whoami.stderr).toContain('semantius login');
      // B's session was never touched: no request left this process at all
      // (a real consultation of B would need the network; A's own mock saw
      // no token request either, since there is nothing to exchange).
      expect(tokenRequestsA).toEqual([]);
    });
  });

  describe('scenario 3: A was the current host', () => {
    test('logout clears the current host (hint on stderr); this folder is unaffected; elsewhere needs "use"', async () => {
      await writeFile(
        join(projectDir, '.env'),
        `SEMANTIUS_HOST=${hostA}\nSEMANTIUS_API_KEY=sk-bare-key\n`,
      );
      await seedSession(configDir, hostA);

      const use = await runCli(projectDir, configDir, ['use', hostA]);
      expect(use.exitCode).toBe(0);
      expect(use.stdout.trim()).toBe(`Current host: ${hostA} (none before)`);

      const logout = await runCli(projectDir, configDir, ['logout']);
      expect(logout.exitCode).toBe(0);
      expect(logout.stderr).toContain(`${hostA} was the current host`);
      expect(logout.stderr).toContain('semantius use <host>');

      // In the project folder, nothing changes: once "current" is cleared,
      // resolution falls through to the project .env, which names the same A.
      const stillWorks = await runCli(projectDir, configDir, ['whoami']);
      expect(stillWorks.exitCode).toBe(0);

      const elsewhereDir = await mkdtemp(
        join(tmpdir(), 'semantius-accept-elsewhere-'),
      );
      try {
        const before = await runCli(elsewhereDir, configDir, ['whoami']);
        expect(before.exitCode).toBe(1);
        expect(before.stderr).toContain('MISSING_ENV_VAR');

        await seedSession(configDir, hostA); // re-establish a session to promote
        const useAgain = await runCli(elsewhereDir, configDir, ['use', hostA]);
        expect(useAgain.exitCode).toBe(0);

        const after = await runCli(elsewhereDir, configDir, ['whoami']);
        expect(after.stderr).not.toContain('MISSING_ENV_VAR');
        expect(after.exitCode).toBe(0);
      } finally {
        await rm(elsewhereDir, { recursive: true, force: true });
      }
    });
  });

  describe('scenario 4: the current host overrides a different HOST/ORG from .env (the bug this redesign fixes)', () => {
    test('use hostA persists across directories, beating a different project .env', async () => {
      await seedSession(configDir, hostA);
      const use = await runCli(projectDir, configDir, ['use', hostA]);
      expect(use.exitCode).toBe(0);

      // A different project, with its OWN .env naming a completely different
      // host — under the old last-rung design this would win; the current
      // host (set by "use", above) must win instead.
      const otherProjectDir = await mkdtemp(
        join(tmpdir(), 'semantius-accept-other-'),
      );
      try {
        await writeFile(
          join(otherProjectDir, '.env'),
          'SEMANTIUS_ORG=some-other-org\n',
        );
        const result = await runCli(otherProjectDir, configDir, ['whoami']);
        expect(result.stdout).toContain(`host  ${hostA} (current)`);
        expect(result.stdout).toContain('host_source  current');
      } finally {
        await rm(otherProjectDir, { recursive: true, force: true });
      }
    });
  });

  describe('whoami rows: host and host_source', () => {
    test('source "current" gets the " (current)" suffix', async () => {
      await seedSession(configDir, hostA);
      const use = await runCli(projectDir, configDir, ['use', hostA]);
      expect(use.exitCode).toBe(0);

      const emptyDir = await mkdtemp(join(tmpdir(), 'semantius-accept-empty-'));
      try {
        const result = await runCli(emptyDir, configDir, ['whoami']);
        expect(result.stdout).toContain(`host  ${hostA} (current)`);
        expect(result.stdout).toContain('host_source  current');
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    test('source "dotenv:<path>" when SEMANTIUS_HOST comes from a project .env', async () => {
      const envPath = join(projectDir, '.env');
      await writeFile(envPath, `SEMANTIUS_HOST=${hostA}\nSEMANTIUS_API_KEY=sk-x\n`);

      const result = await runCli(projectDir, configDir, ['whoami']);
      expect(result.stdout).toMatch(/host_source\s+dotenv:.*\.env/);
      expect(result.stdout).not.toContain(`host  ${hostA} (current)`);
    });

    test('source "token" for --token', async () => {
      // Kept fully offline: the control-plane record for acme.semantius.cloud
      // is pre-seeded, pointing its PostgREST URL at the local stub.
      await seedHostCache(
        configDir,
        'acme.semantius.cloud',
        `http://${hostA}/rest`,
      );

      const emptyDir = await mkdtemp(join(tmpdir(), 'semantius-accept-token-'));
      try {
        const result = await runCli(emptyDir, configDir, [
          '--token',
          `acme:${JWT}`,
          'whoami',
        ]);
        expect(result.stdout).toContain('host  acme.semantius.cloud');
        expect(result.stdout).toContain('host_source  token');
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
