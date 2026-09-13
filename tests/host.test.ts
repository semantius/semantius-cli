/**
 * Tests for host / server resolution (src/host.ts) and the host-related CLI
 * surface: --host precedence, cloud control-plane lookup and its on-disk
 * cache, self-hosted facts, org propagation, the relaxed startup gate, and the
 * --crud-mcp / cube errors on self-hosted hosts.
 *
 * fetch is stubbed and the host cache is redirected to a temp dir, so nothing
 * here touches the network or the real user config dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getApiKeyOrgInfo,
  getDefaultConfig,
  getJwtOrgInfo,
  getMissingRequiredEnvVars,
  loadConfig,
  loadDotEnv,
  normalizeCredentialEnv,
  setCrudMcpFlag,
  setEnvPrefix,
  setHostFlag,
  setTokenArg,
} from '../src/config';
import {
  HOST_CACHE_TTL_MS,
  deleteHostCache,
  getHost,
  getHostCachePath,
  getHostMode,
  getHostSource,
  hostBaseUrl,
  normalizeHost,
  propagateOrg,
  resolveHost,
  setHostCacheDirForTests,
} from '../src/host';
import { setCurrentHost, setHostsIndexDirForTests } from '../src/hosts-index';
import { formatServerDetails } from '../src/output';

const VARS = [
  'SEMANTIUS_HOST',
  'SEMANTIUS_ORG',
  'SEMANTIUS_API_KEY',
  'SEMANTIUS_JWT',
  'SEMANTIUS_CRUD_MCP',
  'SEMANTIUS_CONFIG_PATH',
];

const RECORD = {
  id: '0123456789abcdef0123456789abcdef',
  name: 'Acme',
  logo: null,
  postgrest_url: 'https://ep-test.apirest.example.neon.tech/neondb/rest/v1/',
  client_id: 'web-client-id',
  client_id_cli: 'cli-client-id',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('host resolution', () => {
  let saved: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  let cacheDir: string;
  let hostsIndexDir: string;

  /** Replace fetch; returns the list of requested URLs. */
  function stubFetch(
    handler: (url: string) => Response | Promise<Response>,
  ): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (input: URL | Request | string) => {
      calls.push(String(input));
      return handler(String(input));
    }) as typeof fetch;
    return calls;
  }

  beforeEach(async () => {
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    setEnvPrefix('SEMANTIUS');
    setHostFlag(undefined);
    setCrudMcpFlag(false);
    cacheDir = await mkdtemp(join(tmpdir(), 'semantius-host-test-'));
    setHostCacheDirForTests(cacheDir);
    // Redirected for every test in this describe block, not just the "current
    // host" one below: getHost() now checks the current host (hosts.json)
    // right after --host/--token, so a real stored current host on the
    // machine running these tests would otherwise leak into every scenario
    // here that expects it to fall through to the environment / .env layers.
    hostsIndexDir = await mkdtemp(join(tmpdir(), 'semantius-host-index-test-'));
    setHostsIndexDirForTests(hostsIndexDir);
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setHostFlag(undefined);
    setCrudMcpFlag(false);
    setHostCacheDirForTests(undefined);
    setHostsIndexDirForTests(undefined);
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
    await rm(cacheDir, { recursive: true, force: true });
    await rm(hostsIndexDir, { recursive: true, force: true });
  });

  describe('normalizeHost', () => {
    test('a host is a bare hostname: https:// / http:// and trailing slashes are stripped', () => {
      expect(normalizeHost('acme.semantius.cloud')).toBe(
        'acme.semantius.cloud',
      );
      expect(normalizeHost('https://acme.semantius.cloud/')).toBe(
        'acme.semantius.cloud',
      );
      expect(normalizeHost('http://acme.semantius.cloud')).toBe(
        'acme.semantius.cloud',
      );
    });

    test('keeps a non-default port, drops the default one, lowercases', () => {
      expect(normalizeHost('https://Semantius.Example.com:8443/')).toBe(
        'semantius.example.com:8443',
      );
      expect(normalizeHost('https://x.example.com:443//')).toBe(
        'x.example.com',
      );
      expect(normalizeHost('localhost:3000')).toBe('localhost:3000');
    });

    test('maps the web-app / MCP / analytics names of a cloud org to <org>.semantius.cloud', () => {
      expect(normalizeHost('cli1-bb82.semantius.app')).toBe(
        'cli1-bb82.semantius.cloud',
      );
      expect(normalizeHost('https://acme.semantius.app/')).toBe(
        'acme.semantius.cloud',
      );
      expect(normalizeHost('acme.semantius.ai')).toBe('acme.semantius.cloud');
      expect(normalizeHost('acme.semantius.io')).toBe('acme.semantius.cloud');
    });

    test('rejects other schemes, paths, queries and credentials', () => {
      expect(() => normalizeHost('ftp://x.example.com')).toThrow(
        'INVALID_HOST',
      );
      expect(() => normalizeHost('https://x.example.com/api')).toThrow(
        'INVALID_HOST',
      );
      expect(() => normalizeHost('https://x.example.com/?a=1')).toThrow(
        'INVALID_HOST',
      );
      expect(() => normalizeHost('https://u:p@x.example.com')).toThrow(
        'INVALID_HOST',
      );
    });

    test('HTTPS everywhere, plain HTTP only for loopback hosts', () => {
      expect(hostBaseUrl('x.example.com')).toBe('https://x.example.com');
      expect(hostBaseUrl('x.example.com:8443')).toBe(
        'https://x.example.com:8443',
      );
      expect(hostBaseUrl('localhost:3000')).toBe('http://localhost:3000');
      expect(hostBaseUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
      expect(hostBaseUrl('[::1]:8080')).toBe('http://[::1]:8080');
    });
  });

  describe('precedence', () => {
    test('--host beats SEMANTIUS_HOST beats the org default', () => {
      process.env.SEMANTIUS_ORG = 'org-default';
      process.env.SEMANTIUS_HOST = 'env.example.com';
      setHostFlag('flag.example.com');
      expect(getHost()).toBe('flag.example.com');

      setHostFlag(undefined);
      expect(getHost()).toBe('env.example.com');

      delete process.env.SEMANTIUS_HOST;
      expect(getHost()).toBe('org-default.semantius.cloud');
    });

    test('no host at all → null', () => {
      expect(getHost()).toBeNull();
      expect(getHostMode()).toBeNull();
    });

    describe('.env layer', () => {
      let projectDir: string;
      let originalCwd: string;

      beforeEach(async () => {
        originalCwd = process.cwd();
        projectDir = await mkdtemp(join(tmpdir(), 'semantius-host-env-'));
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_HOST=dotenv.example.com\nSEMANTIUS_ORG=dotenv-org\n',
        );
        process.chdir(projectDir);
      });

      afterEach(async () => {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      });

      test('a project .env HOST beats the org default', async () => {
        await loadDotEnv();
        expect(getHost()).toBe('dotenv.example.com');
      });

      test('shell SEMANTIUS_HOST beats the project .env', async () => {
        process.env.SEMANTIUS_HOST = 'shell.example.com';
        await loadDotEnv();
        expect(getHost()).toBe('shell.example.com');
      });

      test('--host beats the project .env', async () => {
        setHostFlag('https://flag.example.com');
        await loadDotEnv();
        expect(getHost()).toBe('flag.example.com');
      });
    });
  });

  describe('credential binding and conflicts', () => {
    // A credential's org resolves the host exactly like a bare ${PREFIX}_ORG
    // would, so its source is the same fixed 'org' string regardless of which
    // layer (shell / local .env / global .env) the credential itself sits in
    // — unlike a resolved *host* value, which distinguishes 'env' (shell)
    // from `dotenv:<path>` (a .env file). See host.ts's HostSource docstring.

    test('an org-prefixed API key alone binds the host, source "org"', () => {
      process.env.SEMANTIUS_API_KEY = 'acme:sk-secret';
      normalizeCredentialEnv();
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('org');
      // The value is stripped for actual use, same as before this feature.
      expect(process.env.SEMANTIUS_API_KEY).toBe('sk-secret');
    });

    test('an org-prefixed JWT alone binds the host, source "org"', () => {
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('org');
    });

    test('a --token argument binds the host, source "token"', () => {
      setTokenArg({ org: 'acme', jwt: 'eyJ.e30.sig' });
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('token');
    });

    test('a --token argument wins over an org-prefixed env credential', () => {
      process.env.SEMANTIUS_JWT = 'env-org:eyJ.e30.sig';
      normalizeCredentialEnv();
      setTokenArg({ org: 'token-org', jwt: 'eyJ.e30.sig' });
      expect(getHost()).toBe('token-org.semantius.cloud');
      expect(getHostSource()).toBe('token');
    });

    test('a JWT-prefixed org wins over an API-key-prefixed org for the binding', () => {
      process.env.SEMANTIUS_API_KEY = 'from-key:sk-secret';
      process.env.SEMANTIUS_JWT = 'from-jwt:eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(getHost()).toBe('from-jwt.semantius.cloud');
    });

    test('an org-prefixed credential in a project .env still resolves the host, source "org"', async () => {
      const projectDir = await mkdtemp(join(tmpdir(), 'semantius-host-bind-'));
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_API_KEY=acme:sk-secret\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        expect(getHost()).toBe('acme.semantius.cloud');
        expect(getHostSource()).toBe('org');
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test("a bare ${PREFIX}_HOST from a project .env has source dotenv:<path> (unlike a credential's org)", async () => {
      const projectDir = await mkdtemp(join(tmpdir(), 'semantius-host-bind-'));
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_HOST=dotenv.example.com\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        expect(getHost()).toBe('dotenv.example.com');
        expect(getHostSource()).toMatch(/^dotenv:.*\.env$/);
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('a bare shell SEMANTIUS_ORG is not clobbered by an org-prefixed credential at a later .env layer, and that credential is suppressed', async () => {
      // Regression test: normalizeCredentialEnv's hoist used to overwrite
      // ${PREFIX}_ORG with a credential's org unconditionally, wherever that
      // credential's own var lived — so a legitimate shell-set ORG could be
      // silently clobbered by an unrelated, lower-precedence .env file's
      // stale credential. Hoisting no longer touches ${PREFIX}_ORG at all
      // (see normalizeCredentialEnv's docstring); orgAt reads it directly.
      //
      // A private prefix, not SEMANTIUS: getEnvVarPosition keys off
      // _envSources, which — unlike process.env — is never reset between
      // tests in this file, and an earlier describe block's ".env layer"
      // tests already load a project .env containing a bare SEMANTIUS_ORG.
      // Reusing that name here would read as attributed to THAT old file,
      // not to the shell, making this test's "shell" premise flaky. A prefix
      // no earlier test ever touches has no such stale entry to collide with.
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-suppress-'),
      );
      const originalCwd = process.cwd();
      try {
        setEnvPrefix('HOSTSUPPRESS1');
        await writeFile(
          join(projectDir, '.env'),
          'HOSTSUPPRESS1_API_KEY=later-org:sk-secret\n',
        );
        process.chdir(projectDir);
        process.env.HOSTSUPPRESS1_ORG = 'shell-org'; // resolves first, at the shell layer
        await loadDotEnv();

        expect(getHost()).toBe('shell-org.semantius.cloud');
        expect(getHostSource()).toBe('org');
        // The .env's API key was never reached, and is actively suppressed —
        // not just skipped for the conflict check — so it can't be silently
        // sent to a host it was never configured for.
        expect(getApiKeyOrgInfo()).toBeUndefined();
        expect(process.env.HOSTSUPPRESS1_API_KEY).toBe('');
      } finally {
        setEnvPrefix('SEMANTIUS');
        delete process.env.HOSTSUPPRESS1_ORG;
        delete process.env.HOSTSUPPRESS1_API_KEY;
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('an org-bound shell credential resolves first; a credential at a later .env layer is suppressed', async () => {
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-suppress-2-'),
      );
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_API_KEY=later-org:sk-secret\n',
        );
        process.chdir(projectDir);
        process.env.SEMANTIUS_JWT = 'shell-org:eyJ.e30.sig';
        await loadDotEnv();

        expect(getHost()).toBe('shell-org.semantius.cloud');
        expect(getHostSource()).toBe('org');
        expect(getApiKeyOrgInfo()).toBeUndefined();
        expect(process.env.SEMANTIUS_API_KEY).toBe('');
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('both a JWT and an API key at an unreached later layer are suppressed, not just whichever credentialAt would prefer', async () => {
      // A private prefix, not SEMANTIUS — see the previous test's comment on
      // why a bare shell ORG needs one to avoid a stale _envSources entry.
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-suppress-both-'),
      );
      const originalCwd = process.cwd();
      try {
        setEnvPrefix('HOSTSUPPRESS2');
        await writeFile(
          join(projectDir, '.env'),
          'HOSTSUPPRESS2_JWT=later-jwt-org:eyJ.e30.sig\nHOSTSUPPRESS2_API_KEY=later-key-org:sk-secret\n',
        );
        process.chdir(projectDir);
        process.env.HOSTSUPPRESS2_ORG = 'shell-org'; // resolves first, at the shell layer
        await loadDotEnv();

        expect(getHost()).toBe('shell-org.semantius.cloud');
        expect(getJwtOrgInfo()).toBeUndefined();
        expect(getApiKeyOrgInfo()).toBeUndefined();
        expect(process.env.HOSTSUPPRESS2_JWT).toBe('');
        expect(process.env.HOSTSUPPRESS2_API_KEY).toBe('');
      } finally {
        setEnvPrefix('SEMANTIUS');
        delete process.env.HOSTSUPPRESS2_ORG;
        delete process.env.HOSTSUPPRESS2_JWT;
        delete process.env.HOSTSUPPRESS2_API_KEY;
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('a bare ORG agreeing with a same-layer credential (even in a different case) is not a conflict', async () => {
      process.env.SEMANTIUS_ORG = 'ACME';
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('org');
    });

    test('a bare ORG disagreeing with a same-layer credential is a HOST_CONFLICT, not a silent pick either way', async () => {
      // Regression test: Bun auto-loads the cwd's .env before the CLI's own
      // code runs, so loadEnvFile can only *guess* (by matching values) that
      // an already-set variable came from the file it's reading rather than
      // the shell — a guess good enough for describeEnvVar's cosmetic error
      // hints, and trusted the same way for layer attribution too (the
      // common case: the cwd's .env, which is exactly what Bun's auto-load
      // already read). The residual risk that guess carries — the shell
      // coincidentally exporting the same value a project's own .env also
      // happens to carry, next to a differently-bound credential — is what
      // this test pins down: orgAt must not silently prefer either side,
      // the same way checkSameLayerConflict already refuses to for
      // ${PREFIX}_HOST.
      //
      // A private prefix, not SEMANTIUS — see the earlier suppression
      // tests' comment on why a var this test needs read as "local" needs a
      // name no earlier test has already attributed to some other file.
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-shell-match-'),
      );
      const originalCwd = process.cwd();
      try {
        setEnvPrefix('HOSTSHELLMATCH');
        await writeFile(
          join(projectDir, '.env'),
          'HOSTSHELLMATCH_ORG=acme\nHOSTSHELLMATCH_JWT=other-org:eyJ.e30.sig\n',
        );
        process.chdir(projectDir);
        // Simulates Bun's own auto-load already having set this exact value
        // before the CLI's own loadDotEnv ever runs — indistinguishable, by
        // value alone, from a genuine shell export of the same org.
        process.env.HOSTSHELLMATCH_ORG = 'acme';
        await loadDotEnv();

        expect(() => getHost()).toThrow(/^Error \[HOST_CONFLICT\]:/);
        expect(() => getHost()).toThrow(
          /HOSTSHELLMATCH_JWT \(from .*\.env\) is bound to other-org\.semantius\.cloud, but HOSTSHELLMATCH_ORG \(from .*\.env\) names acme\.semantius\.cloud/,
        );
      } finally {
        setEnvPrefix('SEMANTIUS');
        delete process.env.HOSTSHELLMATCH_ORG;
        delete process.env.HOSTSHELLMATCH_JWT;
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('a bound credential is the host when nothing else names one', () => {
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(getHost()).toBe('acme.semantius.cloud');
    });

    test('--host wins over a credential bound at a lower-precedence layer, even naming a different org (never reached, so never a conflict)', () => {
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      setHostFlag('other.semantius.cloud');
      expect(getHost()).toBe('other.semantius.cloud');
      expect(getHostSource()).toBe('flag');
    });

    test('a --token argument alone normalizes a mixed-case org to lowercase', () => {
      setTokenArg({ org: 'Acme', jwt: 'eyJ.e30.sig' });
      expect(getHost()).toBe('acme.semantius.cloud');
    });

    test('SEMANTIUS_HOST naming a DIFFERENT host than the binding is HOST_CONFLICT, naming both and the origin', async () => {
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-conflict-'),
      );
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_HOST=other.example.com\nSEMANTIUS_API_KEY=acme:sk-secret\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        expect(() => getHost()).toThrow(/^Error \[HOST_CONFLICT\]:/);
        expect(() => getHost()).toThrow(
          /SEMANTIUS_API_KEY \(from .*\.env\) is bound to acme\.semantius\.cloud, but SEMANTIUS_HOST \(from .*\.env\) names other\.example\.com/,
        );
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('SEMANTIUS_HOST naming the SAME host via an alias / different case is not a same-layer conflict', async () => {
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-conflict-alias-'),
      );
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          // .app is the web-app alias for the managed cloud, and the org's
          // case differs from the credential's — both sides normalize before
          // comparison (normalizeHost / orgToHost), so this must not conflict.
          'SEMANTIUS_HOST=ACME.semantius.app\nSEMANTIUS_API_KEY=acme:sk-secret\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        expect(getHost()).toBe('acme.semantius.cloud');
        expect(getHostSource()).toMatch(/^dotenv:.*\.env$/);
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('a same-layer API key conflict is still caught even when a matching JWT is also set (checkSameLayerConflict checks every credential, not just the JWT-preferred one)', async () => {
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-conflict-apikey-'),
      );
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_HOST=acme.semantius.cloud\nSEMANTIUS_JWT=acme:eyJ.e30.sig\nSEMANTIUS_API_KEY=other-org:sk-secret\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        // credentialAt() alone (JWT-preferred) would see only the matching
        // JWT and miss the API key's conflicting org entirely.
        expect(() => getHost()).toThrow(/^Error \[HOST_CONFLICT\]:/);
        expect(() => getHost()).toThrow(
          /SEMANTIUS_API_KEY \(from .*\.env\) is bound to other-org\.semantius\.cloud, but SEMANTIUS_HOST \(from .*\.env\) names acme\.semantius\.cloud/,
        );
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('getMissingRequiredEnvVars is empty for a binding alone (no ORG, no HOST)', () => {
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(getMissingRequiredEnvVars()).toEqual([]);
    });

    test('getMissingRequiredEnvVars is empty (not throwing) when getHost() would throw a same-layer conflict', async () => {
      // A fresh project .env, not plain process.env vars: getEnvVarPosition
      // keys off _envSources, which (unlike process.env) is never reset
      // between tests in this file — a var set directly here could still
      // read as attributed to some earlier test's .env, which would make the
      // "same layer" conflict this test wants to force flaky. A freshly
      // loaded file always re-attributes the vars it actually finds.
      const projectDir = await mkdtemp(
        join(tmpdir(), 'semantius-host-conflict-missing-'),
      );
      const originalCwd = process.cwd();
      try {
        await writeFile(
          join(projectDir, '.env'),
          'SEMANTIUS_HOST=other.example.com\nSEMANTIUS_JWT=acme:eyJ.e30.sig\n',
        );
        process.chdir(projectDir);
        await loadDotEnv();
        expect(getMissingRequiredEnvVars()).toEqual([]);
        expect(() => getHost()).toThrow('HOST_CONFLICT');
      } finally {
        process.chdir(originalCwd);
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    test('propagateOrg writes the bound org', () => {
      process.env.SEMANTIUS_JWT = 'acme:eyJ.e30.sig';
      normalizeCredentialEnv();
      propagateOrg();
      expect(process.env.SEMANTIUS_ORG).toBe('acme');
    });
  });

  describe('current host', () => {
    test('the current host alone resolves it, source "current"', () => {
      setCurrentHost('acme.semantius.cloud');
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('current');
    });

    // The core behavior change this describe block exists to pin down: under
    // the old design the stored host was the LAST rung (env/.env always won);
    // now `semantius use` is meant to be the ultimate decision until changed,
    // so it must beat the shell environment instead of losing to it.
    test('the current host beats SEMANTIUS_ORG and SEMANTIUS_HOST from the shell', () => {
      setCurrentHost('acme.semantius.cloud');
      process.env.SEMANTIUS_ORG = 'other';
      process.env.SEMANTIUS_HOST = 'other.example.com';
      expect(getHost()).toBe('acme.semantius.cloud');
      expect(getHostSource()).toBe('current');
    });

    test('--host beats the current host', () => {
      setCurrentHost('acme.semantius.cloud');
      setHostFlag('other.example.com');
      expect(getHost()).toBe('other.example.com');
      expect(getHostSource()).toBe('flag');
    });

    test('a --token argument beats the current host', () => {
      setCurrentHost('acme.semantius.cloud');
      setTokenArg({ org: 'other', jwt: 'eyJ.e30.sig' });
      expect(getHost()).toBe('other.semantius.cloud');
      expect(getHostSource()).toBe('token');
    });

    test('no current host and nothing else → null, same as before', () => {
      expect(getHost()).toBeNull();
      expect(getHostSource()).toBeNull();
    });

    test('getMissingRequiredEnvVars is empty when only the current host supplies it', () => {
      setCurrentHost('acme.semantius.cloud');
      expect(getMissingRequiredEnvVars()).toEqual([]);
    });
  });

  describe('cloud hosts', () => {
    test('resolves the control-plane record into host facts', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      const calls = stubFetch(() => json(RECORD));

      const facts = await resolveHost();

      expect(calls).toEqual(['https://api.semantius.cloud/organization/acme']);
      expect(facts).toEqual({
        mode: 'cloud',
        host: 'acme.semantius.cloud',
        org: 'acme',
        tenantId: RECORD.id,
        postgrestUrl:
          'https://ep-test.apirest.example.neon.tech/neondb/rest/v1',
        discoveryUrl:
          'https://acme.semantius.cloud/.well-known/oauth-protected-resource',
        tokenExchange: {
          method: 'POST',
          url: 'https://acme.semantius.cloud/token',
        },
        clientId: 'cli-client-id',
        apiBaseUrl: 'https://acme.semantius.ai',
        uiBaseUrl: 'https://acme.semantius.app',
      });
    });

    test('--host <org>.semantius.cloud is cloud with that org', async () => {
      process.env.SEMANTIUS_ORG = 'other';
      setHostFlag('acme.semantius.cloud');
      const calls = stubFetch(() => json(RECORD));
      const facts = await resolveHost();
      expect(facts.mode).toBe('cloud');
      expect(facts.org).toBe('acme');
      expect(calls).toEqual(['https://api.semantius.cloud/organization/acme']);
    });

    test('writes a cache without secrets and serves the next resolution from it', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      stubFetch(() => json(RECORD));
      const first = await resolveHost();

      const path = getHostCachePath('acme.semantius.cloud');
      expect(path).toBe(join(cacheDir, 'acme.semantius.cloud.json'));
      const cached = JSON.parse(await readFile(path, 'utf8'));
      expect(Object.keys(cached.record).sort()).toEqual([
        'client_id_cli',
        'id',
        'postgrest_url',
      ]);
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }

      // New process (in-memory memo cleared): the cache answers, no fetch.
      setHostCacheDirForTests(cacheDir);
      const calls = stubFetch(() => {
        throw new Error('network must not be used on a cache hit');
      });
      expect(await resolveHost()).toEqual(first);
      expect(calls).toEqual([]);
    });

    test('an expired cache entry (older than 24 h) is refetched', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      const path = getHostCachePath('acme.semantius.cloud');
      await writeFile(
        path,
        JSON.stringify({
          fetched_at: new Date(
            Date.now() - HOST_CACHE_TTL_MS - 1000,
          ).toISOString(),
          record: {
            id: 'stale',
            postgrest_url: 'https://stale.example/rest',
            client_id_cli: null,
          },
        }),
      );
      const calls = stubFetch(() => json(RECORD));
      const facts = await resolveHost();
      expect(calls.length).toBe(1);
      expect(facts.tenantId).toBe(RECORD.id);
    });

    test('deleteHostCache (the --reset-cache action) forces a refetch', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      stubFetch(() => json(RECORD));
      await resolveHost();
      const path = deleteHostCache('acme.semantius.cloud');
      expect(existsSync(path)).toBe(false);

      const calls = stubFetch(() => json(RECORD));
      await resolveHost();
      expect(calls.length).toBe(1);
    });

    test('parallel resolutions share one control-plane request', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      const calls = stubFetch(() => json(RECORD));
      await Promise.all([resolveHost(), resolveHost(), resolveHost()]);
      expect(calls.length).toBe(1);
    });

    test('unknown org → HOST_RESOLUTION_FAILED', async () => {
      process.env.SEMANTIUS_ORG = 'nope';
      stubFetch(() => new Response('not found', { status: 404 }));
      await expect(resolveHost()).rejects.toThrow(
        /^Error \[HOST_RESOLUTION_FAILED\]: organization "nope" not found/,
      );
    });

    test('server error and unreachable control plane → HOST_RESOLUTION_FAILED', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      stubFetch(() => new Response('boom', { status: 502 }));
      await expect(resolveHost()).rejects.toThrow(
        /^Error \[HOST_RESOLUTION_FAILED\]: .*returned 502/,
      );

      stubFetch(() => {
        throw new Error('getaddrinfo ENOTFOUND api.semantius.cloud');
      });
      await expect(resolveHost()).rejects.toThrow(
        /^Error \[HOST_RESOLUTION_FAILED\]: could not reach the Semantius control plane/,
      );
    });

    test('a record without postgrest_url → HOST_RESOLUTION_FAILED', async () => {
      process.env.SEMANTIUS_ORG = 'acme';
      stubFetch(() => json({ id: 'x', name: 'Acme' }));
      await expect(resolveHost()).rejects.toThrow('HOST_RESOLUTION_FAILED');
    });

    test('no host configured → HOST_RESOLUTION_FAILED naming ORG and --host', async () => {
      await expect(resolveHost()).rejects.toThrow(
        'set SEMANTIUS_ORG or --host',
      );
    });
  });

  describe('self-hosted hosts', () => {
    test('--host https://x.example.com resolves from fixed paths without network', async () => {
      setHostFlag('https://x.example.com');
      const calls = stubFetch(() => {
        throw new Error('self-hosted resolution must not fetch');
      });

      const facts = await resolveHost();

      expect(calls).toEqual([]);
      expect(facts).toEqual({
        mode: 'selfhosted',
        host: 'x.example.com',
        org: null,
        tenantId: null,
        postgrestUrl: 'https://x.example.com/rest',
        discoveryUrl:
          'https://x.example.com/.well-known/oauth-protected-resource',
        tokenExchange: {
          method: 'GET',
          url: 'https://x.example.com/api/auth/token',
        },
        clientId: 'semantius-cli',
        apiBaseUrl: 'https://x.example.com/api',
        uiBaseUrl: 'https://x.example.com',
      });
      expect(existsSync(getHostCachePath('x.example.com'))).toBe(false);
    });

    test('any host outside the Semantius cloud domains is self-hosted', () => {
      setHostFlag('x.example.com');
      expect(getHostMode()).toBe('selfhosted');
      setHostFlag('acme.semantius.cloud');
      expect(getHostMode()).toBe('cloud');
      // The web-app name of a cloud org is mapped, not treated as self-hosted.
      setHostFlag('acme.semantius.app');
      expect(getHostMode()).toBe('cloud');
      expect(getHost()).toBe('acme.semantius.cloud');
    });

    test('the default config has no cube server', () => {
      setHostFlag('https://x.example.com');
      const config = getDefaultConfig();
      expect(Object.keys(config.mcpServers)).toEqual(['crud']);
      expect(config.mcpServers.crud).toEqual({ postgrest: true });
    });
  });

  describe('org propagation', () => {
    test('a cloud --host overrides SEMANTIUS_ORG', () => {
      process.env.SEMANTIUS_ORG = 'from-dotenv';
      setHostFlag('acme.semantius.cloud');
      propagateOrg();
      expect(process.env.SEMANTIUS_ORG).toBe('acme');
    });

    test('a cloud SEMANTIUS_HOST sets an unset SEMANTIUS_ORG', () => {
      process.env.SEMANTIUS_HOST = 'https://acme.semantius.cloud';
      propagateOrg();
      expect(process.env.SEMANTIUS_ORG).toBe('acme');
    });

    test('a self-hosted host leaves SEMANTIUS_ORG alone', () => {
      process.env.SEMANTIUS_ORG = 'keep';
      setHostFlag('https://x.example.com');
      propagateOrg();
      expect(process.env.SEMANTIUS_ORG).toBe('keep');
    });
  });

  describe('--crud-mcp config routing', () => {
    let originalCwd: string;
    let emptyDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      emptyDir = await mkdtemp(join(tmpdir(), 'semantius-host-cfg-'));
      process.chdir(emptyDir); // no mcp_servers.json → built-in default config
      process.env.SEMANTIUS_ORG = 'test-org';
      process.env.SEMANTIUS_API_KEY = 'test-key';
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(emptyDir, { recursive: true, force: true });
    });

    test('without --crud-mcp crud is the local PostgREST layer', async () => {
      const config = await loadConfig();
      expect(config.mcpServers.crud).toEqual({ postgrest: true });
    });

    test('--crud-mcp routes crud through the remote MCP server', async () => {
      setCrudMcpFlag(true);
      const config = await loadConfig();
      expect(config.mcpServers.crud).toEqual({
        url: 'https://test-org.semantius.ai/mcp',
        headers: { 'x-api-key': 'test-key' },
      });
    });

    test('SEMANTIUS_CRUD_MCP=1 does the same and keeps tool filters', async () => {
      process.env.SEMANTIUS_CRUD_MCP = '1';
      const configPath = join(emptyDir, 'mcp_servers.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            crud: { postgrest: true, disabledTools: ['delete_*'] },
          },
        }),
      );
      const config = await loadConfig(configPath);
      expect(config.mcpServers.crud).toEqual({
        url: 'https://test-org.semantius.ai/mcp',
        headers: { 'x-api-key': 'test-key' },
        disabledTools: ['delete_*'],
      });
    });

    test('an explicit url crud entry is left as configured', async () => {
      setCrudMcpFlag(true);
      const configPath = join(emptyDir, 'mcp_servers.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { crud: { url: 'https://custom.example.com/mcp' } },
        }),
      );
      const config = await loadConfig(configPath);
      expect(config.mcpServers.crud).toEqual({
        url: 'https://custom.example.com/mcp',
      });
    });
  });

  test('info labels the local layer "Transport: postgrest" with its URL', () => {
    const text = formatServerDetails(
      'crud',
      { postgrest: 'https://pg.example.com/rest' },
      [],
    );
    expect(text).toContain('Transport: postgrest');
    expect(text).toContain('URL: https://pg.example.com/rest');
    expect(formatServerDetails('crud', { url: 'https://x/mcp' }, [])).toContain(
      'Transport: HTTP',
    );
  });
});

describe('host CLI surface', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
  const noServersConfig = join(import.meta.dir, 'fixtures', 'no-servers.json');
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'semantius-host-cli-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  async function runCli(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: {
        ...process.env,
        // Controlled so the repo .env cannot fill them in.
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_JWT: '',
        SEMANTIUS_HOST: '',
        SEMANTIUS_CRUD_MCP: '',
        SEMANTIUS_NO_DAEMON: '1',
        SEMANTIUS_MAX_RETRIES: '0',
        APPDATA: configDir,
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

  test('relaxed gate: a host without credentials passes the startup check', async () => {
    const result = await runCli([
      '--host',
      'https://x.example.com',
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('--host matching a bound credential works even with a conflicting stray SEMANTIUS_HOST', async () => {
    // resolveHostValue() returns on --host before the env-layer loop (where
    // SEMANTIUS_HOST / the bound credential would be compared) ever runs, so
    // that stray conflict is never reached, let alone reported.
    const result = await runCli(
      [
        '--host',
        'acme.semantius.cloud',
        '-c',
        noServersConfig,
        'info',
        'utils',
      ],
      {
        SEMANTIUS_HOST: 'other.example.com',
        SEMANTIUS_JWT: 'acme:eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig',
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('HOST_CONFLICT');
  });

  test('--host without a value is a missing argument', async () => {
    const result = await runCli(['--host']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MISSING_ARGUMENT');
  });

  test('an invalid --host is rejected before anything runs', async () => {
    const result = await runCli(['--host', 'ftp://x.example.com', 'info']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_HOST');
  });

  test('--crud-mcp on a self-hosted host → NOT_AVAILABLE', async () => {
    const result = await runCli([
      '--host',
      'https://x.example.com',
      '--crud-mcp',
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Error [NOT_AVAILABLE]: --crud-mcp needs the Semantius cloud MCP server; self-hosted instances have none',
    );
  });

  test('SEMANTIUS_CRUD_MCP=1 on a self-hosted host → NOT_AVAILABLE', async () => {
    const result = await runCli(['-c', noServersConfig, 'info', 'utils'], {
      SEMANTIUS_HOST: 'https://x.example.com',
      SEMANTIUS_CRUD_MCP: '1',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [NOT_AVAILABLE]: --crud-mcp');
  });

  test('call cube / info cube on a self-hosted host → NOT_AVAILABLE', async () => {
    const expected =
      'Error [NOT_AVAILABLE]: the cube (analytics) server is not available on self-hosted instances';
    // No config file → the built-in default config, which has no cube on self-hosted.
    const env = { SEMANTIUS_CONFIG_PATH: '' };
    const call = await runCli(
      ['--host', 'https://x.example.com', 'call', 'cube', 'discover', '{}'],
      env,
    );
    expect(call.exitCode).toBe(1);
    expect(call.stderr).toContain(expected);

    const info = await runCli(
      ['--host', 'https://x.example.com', 'info', 'cube'],
      env,
    );
    expect(info.exitCode).toBe(1);
    expect(info.stderr).toContain(expected);
  });

  test('--reset-cache and --reset-jwt-cache also reset the host cache', async () => {
    for (const flag of ['--reset-cache', '--reset-jwt-cache']) {
      const result = await runCli(
        [flag, '-c', noServersConfig, 'info', 'utils'],
        { SEMANTIUS_ORG: 'semantius-cli-test-org' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Host cache reset:');
      expect(result.stderr).toContain(
        'semantius-cli-test-org.semantius.cloud.json',
      );
    }
  });

  test('--help documents --host, --crud-mcp and --reset-cache', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    for (const text of [
      '--host <hostname>',
      '--crud-mcp',
      '--reset-cache',
      'SEMANTIUS_HOST',
      'SEMANTIUS_CRUD_MCP=1',
    ]) {
      expect(result.stdout).toContain(text);
    }
  });
});
