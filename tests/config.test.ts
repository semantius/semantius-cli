/**
 * Unit tests for config module
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  getServerConfig,
  listServerNames,
  isHttpServer,
  isStdioServer,
  getDefaultConfig,
  setEnvPrefix,
  getEnvPrefix,
  getRequiredEnvVarNames,
  getMissingRequiredEnvVars,
  getEnvJwt,
  splitOrgPrefix,
  normalizeCredentialEnv,
  getUserConfigDir,
} from '../src/config';

describe('config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadConfig', () => {
    test('loads valid config from explicit path', async () => {
      const configPath = join(tempDir, 'mcp_servers.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { command: 'echo', args: ['hello'] },
          },
        })
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test).toBeDefined();
      expect((config.mcpServers.test as any).command).toBe('echo');
    });

    test('throws on missing config file', async () => {
      const configPath = join(tempDir, 'nonexistent.json');
      await expect(loadConfig(configPath)).rejects.toThrow('not found');
    });

    test('uses built-in default config when no config file is found', async () => {
      // Run loadConfig from a temp directory that has no mcp_servers.json
      // to verify the default config is returned instead of throwing.
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        // Unset SEMANTIUS_CONFIG_PATH to avoid using it
        const savedConfigPath = process.env.SEMANTIUS_CONFIG_PATH;
        delete process.env.SEMANTIUS_CONFIG_PATH;

        // Set env vars so substitution works. Clear any ambient SEMANTIUS_JWT
        // so credential normalization can't hoist a different org.
        const savedJwt = process.env.SEMANTIUS_JWT;
        delete process.env.SEMANTIUS_JWT;
        process.env.SEMANTIUS_API_KEY = 'test-key';
        process.env.SEMANTIUS_ORG = 'test-org';

        const config = await loadConfig();

        expect(config.mcpServers.crud).toBeDefined();
        expect(config.mcpServers.cube).toBeDefined();
        expect((config.mcpServers.crud as any).url).toBe('https://test-org.semantius.ai/mcp');
        expect((config.mcpServers.crud as any).headers['x-api-key']).toBe('test-key');

        // Restore
        if (savedConfigPath !== undefined) {
          process.env.SEMANTIUS_CONFIG_PATH = savedConfigPath;
        }
        if (savedJwt !== undefined) {
          process.env.SEMANTIUS_JWT = savedJwt;
        }
        delete process.env.SEMANTIUS_API_KEY;
        delete process.env.SEMANTIUS_ORG;
      } finally {
        process.chdir(originalCwd);
      }
    });

    test('throws on invalid JSON', async () => {
      const configPath = join(tempDir, 'invalid.json');
      await writeFile(configPath, 'not valid json');

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSON');
    });

    test('throws on missing mcpServers key', async () => {
      const configPath = join(tempDir, 'bad_structure.json');
      await writeFile(configPath, JSON.stringify({ servers: {} }));

      await expect(loadConfig(configPath)).rejects.toThrow('mcpServers');
    });

    test('substitutes environment variables', async () => {
      process.env.TEST_MCP_TOKEN = 'secret123';

      const configPath = join(tempDir, 'env_config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' },
            },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.headers.Authorization).toBe('Bearer secret123');

      delete process.env.TEST_MCP_TOKEN;
    });

    test('handles missing env vars gracefully with SEMANTIUS_STRICT_ENV=false', async () => {
      // Set non-strict mode to allow missing env vars with warning
      process.env.SEMANTIUS_STRICT_ENV = 'false';

      const configPath = join(tempDir, 'missing_env.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'echo',
              env: { TOKEN: '${NONEXISTENT_VAR}' },
            },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.env.TOKEN).toBe('');

      delete process.env.SEMANTIUS_STRICT_ENV;
    });

    test('throws error on missing env vars in strict mode (default)', async () => {
      // Ensure strict mode is enabled (default)
      delete process.env.SEMANTIUS_STRICT_ENV;

      const configPath = join(tempDir, 'missing_env_strict.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'echo',
              env: { TOKEN: '${ANOTHER_NONEXISTENT_VAR}' },
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('MISSING_ENV_VAR');
    });

    test('throws error on empty server config', async () => {
      const configPath = join(tempDir, 'empty_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            badserver: {},
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('missing required field');
    });

    test('throws error on server with both command and url', async () => {
      const configPath = join(tempDir, 'both_types.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            mixed: {
              command: 'echo',
              url: 'https://example.com',
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('both "command" and "url"');
    });

    test('throws error on null server config', async () => {
      const configPath = join(tempDir, 'null_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            nullserver: null,
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid server configuration');
    });
  });

  describe('getServerConfig', () => {
    test('returns server config by name', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            server1: { command: 'cmd1' },
            server2: { command: 'cmd2' },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = getServerConfig(config, 'server1');
      expect((server as any).command).toBe('cmd1');
    });

    test('throws on unknown server', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { known: { command: 'cmd' } },
        })
      );

      const config = await loadConfig(configPath);
      expect(() => getServerConfig(config, 'unknown')).toThrow('not found');
    });
  });

  describe('listServerNames', () => {
    test('returns all server names', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: 'a' },
            beta: { command: 'b' },
            gamma: { url: 'https://example.com' },
          },
        })
      );

      const config = await loadConfig(configPath);
      const names = listServerNames(config);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
      expect(names.length).toBe(3);
    });
  });

  describe('type guards', () => {
    test('isHttpServer identifies HTTP config', () => {
      expect(isHttpServer({ url: 'https://example.com' })).toBe(true);
      expect(isHttpServer({ command: 'echo' })).toBe(false);
    });

    test('isStdioServer identifies stdio config', () => {
      expect(isStdioServer({ command: 'echo' })).toBe(true);
      expect(isStdioServer({ url: 'https://example.com' })).toBe(false);
    });
  });

  describe('getDefaultConfig', () => {
    beforeEach(() => setEnvPrefix('SEMANTIUS'));
    afterEach(() => setEnvPrefix('SEMANTIUS'));

    test('has crud and cube servers', () => {
      const config = getDefaultConfig();
      expect(config.mcpServers.crud).toBeDefined();
      expect(config.mcpServers.cube).toBeDefined();
    });

    test('crud server is HTTP with correct URL template', () => {
      const crud = getDefaultConfig().mcpServers.crud as any;
      expect(crud.url).toContain('${SEMANTIUS_ORG}');
      expect(crud.url).toContain('semantius.ai');
    });

    test('cube server is HTTP with correct URL template', () => {
      const cube = getDefaultConfig().mcpServers.cube as any;
      expect(cube.url).toContain('${SEMANTIUS_ORG}');
      expect(cube.url).toContain('semantius.io');
    });

    test('both servers use SEMANTIUS_API_KEY in headers', () => {
      const crud = getDefaultConfig().mcpServers.crud as any;
      const cube = getDefaultConfig().mcpServers.cube as any;
      expect(crud.headers['x-api-key']).toBe('${SEMANTIUS_API_KEY}');
      expect(cube.headers['x-api-key']).toBe('${SEMANTIUS_API_KEY}');
    });

    test('respects custom env prefix', () => {
      setEnvPrefix('PROD');
      const config = getDefaultConfig();
      const crud = config.mcpServers.crud as any;
      const cube = config.mcpServers.cube as any;
      expect(crud.url).toContain('${PROD_ORG}');
      expect(crud.headers['x-api-key']).toBe('${PROD_API_KEY}');
      expect(cube.url).toContain('${PROD_ORG}');
      expect(cube.headers['x-api-key']).toBe('${PROD_API_KEY}');
    });
  });

  describe('env prefix state', () => {
    afterEach(() => setEnvPrefix('SEMANTIUS'));

    test('getEnvPrefix returns SEMANTIUS by default', () => {
      setEnvPrefix('SEMANTIUS');
      expect(getEnvPrefix()).toBe('SEMANTIUS');
    });

    test('setEnvPrefix uppercases the prefix', () => {
      setEnvPrefix('prod');
      expect(getEnvPrefix()).toBe('PROD');
    });

    test('getRequiredEnvVarNames returns vars with default prefix', () => {
      setEnvPrefix('SEMANTIUS');
      expect(getRequiredEnvVarNames()).toEqual(['SEMANTIUS_API_KEY', 'SEMANTIUS_ORG']);
    });

    test('getRequiredEnvVarNames reflects custom prefix', () => {
      setEnvPrefix('STAGING');
      expect(getRequiredEnvVarNames()).toEqual(['STAGING_API_KEY', 'STAGING_ORG']);
    });
  });

  describe('splitOrgPrefix', () => {
    test('value without colon is returned unchanged', () => {
      expect(splitOrgPrefix('sk-abc-secret')).toEqual({ value: 'sk-abc-secret' });
    });

    test('splits org:value at the first colon', () => {
      expect(splitOrgPrefix('my-org:sk-abc-secret')).toEqual({
        org: 'my-org',
        value: 'sk-abc-secret',
      });
    });

    test('empty org side is treated as malformed (unchanged)', () => {
      expect(splitOrgPrefix(':sk-abc')).toEqual({ value: ':sk-abc' });
    });

    test('empty value side is treated as malformed (unchanged)', () => {
      expect(splitOrgPrefix('my-org:')).toEqual({ value: 'my-org:' });
    });

    test('splits at the FIRST colon, preserving the rest', () => {
      expect(splitOrgPrefix('a:b:c')).toEqual({ org: 'a', value: 'b:c' });
    });
  });

  describe('credential env normalization', () => {
    const VARS = [
      'SEMANTIUS_API_KEY',
      'SEMANTIUS_ORG',
      'SEMANTIUS_JWT',
      'PROD_API_KEY',
      'PROD_ORG',
      'PROD_JWT',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      setEnvPrefix('SEMANTIUS');
      saved = {};
      for (const v of VARS) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
    });

    afterEach(() => {
      setEnvPrefix('SEMANTIUS');
      for (const v of VARS) {
        if (saved[v] !== undefined) {
          process.env[v] = saved[v];
        } else {
          delete process.env[v];
        }
      }
    });

    test('hoists org prefix from API key and overwrites SEMANTIUS_ORG', () => {
      process.env.SEMANTIUS_API_KEY = 'key-org:sk-abc-secret';
      process.env.SEMANTIUS_ORG = 'env-org';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBe('sk-abc-secret');
      expect(process.env.SEMANTIUS_ORG).toBe('key-org');
    });

    test('bare API key leaves SEMANTIUS_ORG untouched', () => {
      process.env.SEMANTIUS_API_KEY = 'sk-abc-secret';
      process.env.SEMANTIUS_ORG = 'env-org';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBe('sk-abc-secret');
      expect(process.env.SEMANTIUS_ORG).toBe('env-org');
    });

    test('hoists org prefix from JWT', () => {
      process.env.SEMANTIUS_JWT = 'jwt-org:eyJhbGciOiJIUzI1NiJ9.e30.sig';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_JWT).toBe('eyJhbGciOiJIUzI1NiJ9.e30.sig');
      expect(process.env.SEMANTIUS_ORG).toBe('jwt-org');
    });

    test('JWT org wins over API key org when both are prefixed', () => {
      process.env.SEMANTIUS_API_KEY = 'key-org:sk-abc-secret';
      process.env.SEMANTIUS_JWT = 'jwt-org:eyJ.e30.sig';
      process.env.SEMANTIUS_ORG = 'env-org';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_ORG).toBe('jwt-org');
    });

    test('malformed prefixed values are left untouched', () => {
      process.env.SEMANTIUS_API_KEY = ':sk-abc';
      process.env.SEMANTIUS_JWT = 'my-org:';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBe(':sk-abc');
      expect(process.env.SEMANTIUS_JWT).toBe('my-org:');
      expect(process.env.SEMANTIUS_ORG).toBeUndefined();
    });

    test('backfills empty API key in JWT-only mode', () => {
      process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBe('');
    });

    test('does not backfill API key when JWT is empty', () => {
      process.env.SEMANTIUS_JWT = '';
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBeUndefined();
    });

    test('is idempotent', () => {
      process.env.SEMANTIUS_API_KEY = 'key-org:sk-abc-secret';
      process.env.SEMANTIUS_JWT = 'jwt-org:eyJ.e30.sig';
      normalizeCredentialEnv();
      const after = {
        key: process.env.SEMANTIUS_API_KEY,
        org: process.env.SEMANTIUS_ORG,
        jwt: process.env.SEMANTIUS_JWT,
      };
      normalizeCredentialEnv();
      expect(process.env.SEMANTIUS_API_KEY).toBe(after.key!);
      expect(process.env.SEMANTIUS_ORG).toBe(after.org!);
      expect(process.env.SEMANTIUS_JWT).toBe(after.jwt!);
    });

    test('respects the active env prefix and leaves other prefixes alone', () => {
      setEnvPrefix('PROD');
      process.env.PROD_JWT = 'prod-org:eyJ.e30.sig';
      process.env.SEMANTIUS_JWT = 'sem-org:other.jwt.sig';
      normalizeCredentialEnv();
      expect(process.env.PROD_JWT).toBe('eyJ.e30.sig');
      expect(process.env.PROD_ORG).toBe('prod-org');
      expect(process.env.PROD_API_KEY).toBe('');
      expect(process.env.SEMANTIUS_JWT).toBe('sem-org:other.jwt.sig');
      expect(process.env.SEMANTIUS_ORG).toBeUndefined();
    });

    test('getEnvJwt returns undefined when unset or empty', () => {
      expect(getEnvJwt()).toBeUndefined();
      process.env.SEMANTIUS_JWT = '';
      expect(getEnvJwt()).toBeUndefined();
    });

    test('getEnvJwt returns the bare token', () => {
      process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
      expect(getEnvJwt()).toBe('eyJ.e30.sig');
    });

    test('getEnvJwt strips an org prefix defensively', () => {
      process.env.SEMANTIUS_JWT = 'my-org:eyJ.e30.sig';
      expect(getEnvJwt()).toBe('eyJ.e30.sig');
    });

    test('getMissingRequiredEnvVars: nothing set → both missing', () => {
      expect(getMissingRequiredEnvVars()).toEqual(['SEMANTIUS_API_KEY', 'SEMANTIUS_ORG']);
    });

    test('getMissingRequiredEnvVars: API key + ORG set → none missing', () => {
      process.env.SEMANTIUS_API_KEY = 'sk-abc-secret';
      process.env.SEMANTIUS_ORG = 'test-org';
      expect(getMissingRequiredEnvVars()).toEqual([]);
    });

    test('getMissingRequiredEnvVars: JWT makes the API key optional', () => {
      process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
      process.env.SEMANTIUS_ORG = 'test-org';
      expect(getMissingRequiredEnvVars()).toEqual([]);
    });

    test('getMissingRequiredEnvVars: JWT alone still requires ORG', () => {
      process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
      expect(getMissingRequiredEnvVars()).toEqual(['SEMANTIUS_ORG']);
    });

    test('loadConfig resolves the default config in JWT-only mode', async () => {
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const savedConfigPath = process.env.SEMANTIUS_CONFIG_PATH;
        delete process.env.SEMANTIUS_CONFIG_PATH;

        process.env.SEMANTIUS_JWT = 'jwt-org:eyJ.e30.sig';

        const config = await loadConfig();
        const crud = config.mcpServers.crud as any;
        expect(crud.url).toBe('https://jwt-org.semantius.ai/mcp');
        // API key was backfilled to '' so strict substitution succeeds
        expect(crud.headers['x-api-key']).toBe('');

        if (savedConfigPath !== undefined) {
          process.env.SEMANTIUS_CONFIG_PATH = savedConfigPath;
        }
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('getUserConfigDir', () => {
    test('returns a non-empty string', () => {
      const dir = getUserConfigDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });

    test('includes "semantius" in the path', () => {
      expect(getUserConfigDir().toLowerCase()).toContain('semantius');
    });

    test('returns platform-appropriate path', () => {
      const dir = getUserConfigDir();
      if (process.platform === 'win32') {
        // Should be under AppData\Roaming or USERPROFILE
        expect(dir).toMatch(/[Ss]emantius/);
      } else {
        expect(dir).toContain('.config/semantius');
      }
    });
  });
});
