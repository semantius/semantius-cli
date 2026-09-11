/**
 * Tests for startup environment variable validation.
 *
 * At startup the CLI only requires a resolvable host: SEMANTIUS_ORG (which may
 * come from an "org:" prefix on either credential), SEMANTIUS_HOST or --host.
 * Credentials are not checked at startup — a command that needs them fails
 * with exit 5 when it authenticates.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

describe('Startup env variable validation', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');

  /**
   * Run the CLI with explicit control over SEMANTIUS_API_KEY, SEMANTIUS_ORG,
   * SEMANTIUS_JWT and SEMANTIUS_HOST. Omit a variable from the overrides map
   * to simulate it being unset.
   */
  async function runCliWithEnv(
    args: string[],
    envOverrides: Record<string, string | undefined>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Build env: start from process.env but strip the vars we want to control,
    // then apply the caller's overrides.
    const {
      SEMANTIUS_API_KEY: _k,
      SEMANTIUS_ORG: _o,
      SEMANTIUS_JWT: _j,
      SEMANTIUS_HOST: _h,
      ...baseEnv
    } = process.env as Record<string, string | undefined>;
    // Explicitly set controlled vars to empty string so that Bun's .env auto-loading
    // and the CLI's own loadDotEnv cannot fill them in when they should be "missing".
    // Bun respects OS env over .env file values, and an empty string is treated as
    // "not set" by the startup check (!process.env[v]).
    const env: Record<string, string> = {
      SEMANTIUS_API_KEY: '',
      SEMANTIUS_ORG: '',
      SEMANTIUS_JWT: '',
      SEMANTIUS_HOST: '',
    };
    for (const [key, value] of Object.entries({ ...baseEnv, ...envOverrides })) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: { ...env, SEMANTIUS_NO_DAEMON: '1' },
      stdin: null,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  }

  test('passes the startup check without credentials (checked when a command authenticates)', async () => {
    const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
      SEMANTIUS_ORG: 'test-org',
      // SEMANTIUS_API_KEY / SEMANTIUS_JWT intentionally omitted
    });
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('errors when no host is configured', async () => {
    const result = await runCliWithEnv(['grep', '*'], {
      SEMANTIUS_API_KEY: 'test-api-key',
      // SEMANTIUS_ORG / SEMANTIUS_HOST intentionally omitted
    });
    expect(result.exitCode).toBe(1); // CLIENT_ERROR — the host is config, not auth
    expect(result.stderr).toContain('MISSING_ENV_VAR');
    expect(result.stderr).toContain('SEMANTIUS_ORG');
    expect(result.stderr).toContain('set SEMANTIUS_ORG or --host');
  });

  test('errors when nothing is set, naming only the host', async () => {
    const result = await runCliWithEnv(['grep', '*'], {
      // Everything intentionally omitted
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MISSING_ENV_VAR');
    expect(result.stderr).toContain('SEMANTIUS_ORG');
    expect(result.stderr).not.toContain('SEMANTIUS_API_KEY');
  });

  test('SEMANTIUS_HOST satisfies the host requirement', async () => {
    const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
      SEMANTIUS_HOST: 'https://x.example.com',
    });
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('--host satisfies the host requirement', async () => {
    const result = await runCliWithEnv(
      ['--host', 'x.example.com', 'grep', 'nonexistent-tool-xyz'],
      {},
    );
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('succeeds past env check when both variables are set', async () => {
    const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
      SEMANTIUS_API_KEY: 'test-api-key',
      SEMANTIUS_ORG: 'test-org',
    });
    // Env check passes — any further error is about config/server, not missing vars
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('--help works without env vars (no startup check for help/version)', async () => {
    const result = await runCliWithEnv(['--help'], {
      // Both omitted
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  test('--version works without env vars (no startup check for help/version)', async () => {
    const result = await runCliWithEnv(['--version'], {
      // Both omitted
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
  });

  describe('org-prefixed credentials', () => {
    test('org: prefix on SEMANTIUS_API_KEY satisfies the ORG requirement', async () => {
      const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
        SEMANTIUS_API_KEY: 'test-org:test-api-key',
        // SEMANTIUS_ORG intentionally omitted — comes from the prefix
      });
      expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    });

    test('malformed prefix (empty org) does not satisfy ORG', async () => {
      const result = await runCliWithEnv(['grep', '*'], {
        SEMANTIUS_API_KEY: ':test-api-key',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ENV_VAR');
      expect(result.stderr).toContain('SEMANTIUS_ORG');
    });
  });

  describe('SEMANTIUS_JWT static token', () => {
    test('JWT + ORG passes env check without an API key', async () => {
      const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
        SEMANTIUS_JWT: 'test-jwt',
        SEMANTIUS_ORG: 'test-org',
        // SEMANTIUS_API_KEY intentionally omitted
      });
      expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    });

    test('org-prefixed JWT alone passes env check', async () => {
      const result = await runCliWithEnv(['grep', 'nonexistent-tool-xyz'], {
        SEMANTIUS_JWT: 'test-org:test-jwt',
        // No API key, no ORG — both derived from the JWT value
      });
      expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    });

    test('JWT without any org still requires a host', async () => {
      const result = await runCliWithEnv(['grep', '*'], {
        SEMANTIUS_JWT: 'test-jwt',
      });
      expect(result.exitCode).toBe(1); // CLIENT_ERROR — only the host is missing
      expect(result.stderr).toContain('MISSING_ENV_VAR');
      expect(result.stderr).toContain('SEMANTIUS_ORG');
      expect(result.stderr).not.toContain('SEMANTIUS_API_KEY');
    });

    test('SEMANTIUS_JWT does not satisfy --env PROD check', async () => {
      const result = await runCliWithEnv(['--env', 'PROD', 'grep', '*'], {
        SEMANTIUS_JWT: 'test-org:test-jwt',
        // PROD_* intentionally not set
      });
      expect(result.exitCode).toBe(1); // PROD_ORG is missing
      expect(result.stderr).toContain('PROD_ORG');
    });

    test('org-prefixed PROD_JWT satisfies --env PROD check', async () => {
      const result = await runCliWithEnv(['--env', 'PROD', 'grep', 'nonexistent-tool-xyz'], {
        PROD_JWT: 'test-org:test-jwt',
      });
      expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    });
  });

  describe('--env prefix flag', () => {
    test('--env PROD requires PROD_ORG instead of SEMANTIUS_ORG', async () => {
      const result = await runCliWithEnv(['--env', 'PROD', 'grep', '*'], {
        PROD_API_KEY: 'test-key',
        // PROD_ORG intentionally omitted
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ENV_VAR');
      expect(result.stderr).toContain('PROD_ORG');
      expect(result.stderr).not.toContain('SEMANTIUS_ORG');
    });

    test('--env prefix is case-insensitive (lowercased prefix is uppercased)', async () => {
      const result = await runCliWithEnv(['--env', 'prod', 'grep', '*'], {
        PROD_API_KEY: 'test-key',
        // PROD_ORG intentionally omitted
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('PROD_ORG');
    });

    test('--env PROD passes env check when PROD vars are set', async () => {
      const result = await runCliWithEnv(['--env', 'PROD', 'grep', 'nonexistent-tool-xyz'], {
        PROD_API_KEY: 'test-key',
        PROD_ORG: 'test-org',
      });
      expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    });

    test('SEMANTIUS vars do not satisfy --env PROD check', async () => {
      const result = await runCliWithEnv(['--env', 'PROD', 'grep', '*'], {
        SEMANTIUS_API_KEY: 'test-key',
        SEMANTIUS_ORG: 'test-org',
        // PROD_* intentionally not set
      });
      expect(result.exitCode).toBe(1); // PROD_ORG is missing
      expect(result.stderr).toContain('MISSING_ENV_VAR');
    });
  });
});
