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
  getDefaultConfig,
  loadConfig,
  loadDotEnv,
  setCrudMcpFlag,
  setEnvPrefix,
  setHostFlag,
} from '../src/config';
import {
  HOST_CACHE_TTL_MS,
  deleteHostCache,
  getHost,
  getHostCachePath,
  getHostMode,
  hostBaseUrl,
  normalizeHost,
  propagateOrg,
  resolveHost,
  setHostCacheDirForTests,
} from '../src/host';
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
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setHostFlag(undefined);
    setCrudMcpFlag(false);
    setHostCacheDirForTests(undefined);
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
    await rm(cacheDir, { recursive: true, force: true });
  });

  describe('normalizeHost', () => {
    test('a host is a bare hostname: https:// / http:// and trailing slashes are stripped', () => {
      expect(normalizeHost('acme.semantius.cloud')).toBe('acme.semantius.cloud');
      expect(normalizeHost('https://acme.semantius.cloud/')).toBe('acme.semantius.cloud');
      expect(normalizeHost('http://acme.semantius.cloud')).toBe('acme.semantius.cloud');
    });

    test('keeps a non-default port, drops the default one, lowercases', () => {
      expect(normalizeHost('https://Semantius.Example.com:8443/')).toBe(
        'semantius.example.com:8443',
      );
      expect(normalizeHost('https://x.example.com:443//')).toBe('x.example.com');
      expect(normalizeHost('localhost:3000')).toBe('localhost:3000');
    });

    test('maps the web-app / MCP / analytics names of a cloud org to <org>.semantius.cloud', () => {
      expect(normalizeHost('cli1-bb82.semantius.app')).toBe('cli1-bb82.semantius.cloud');
      expect(normalizeHost('https://acme.semantius.app/')).toBe('acme.semantius.cloud');
      expect(normalizeHost('acme.semantius.ai')).toBe('acme.semantius.cloud');
      expect(normalizeHost('acme.semantius.io')).toBe('acme.semantius.cloud');
    });

    test('rejects other schemes, paths, queries and credentials', () => {
      expect(() => normalizeHost('ftp://x.example.com')).toThrow('INVALID_HOST');
      expect(() => normalizeHost('https://x.example.com/api')).toThrow('INVALID_HOST');
      expect(() => normalizeHost('https://x.example.com/?a=1')).toThrow('INVALID_HOST');
      expect(() => normalizeHost('https://u:p@x.example.com')).toThrow('INVALID_HOST');
    });

    test('HTTPS everywhere, plain HTTP only for loopback hosts', () => {
      expect(hostBaseUrl('x.example.com')).toBe('https://x.example.com');
      expect(hostBaseUrl('x.example.com:8443')).toBe('https://x.example.com:8443');
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
        postgrestUrl: 'https://ep-test.apirest.example.neon.tech/neondb/rest/v1',
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
          fetched_at: new Date(Date.now() - HOST_CACHE_TTL_MS - 1000).toISOString(),
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
        discoveryUrl: 'https://x.example.com/.well-known/oauth-protected-resource',
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
          mcpServers: { crud: { postgrest: true, disabledTools: ['delete_*'] } },
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
