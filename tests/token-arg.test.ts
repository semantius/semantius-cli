/**
 * Tests for --token / --token-file (spawned CLI so the whole argv → resolved
 * credential path is exercised, config dir redirected so a developer's own
 * hosts.json / global .env never leaks in): validation, resolution (literal /
 * stdin / file), the stderr warning for a literal, the HOST_CONFLICT binding
 * check, and that the JSONL log redacts the literal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('--token / --token-file', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
  const noServersConfig = join(import.meta.dir, 'fixtures', 'no-servers.json');
  const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig';
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'semantius-token-arg-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  async function runCli(
    args: string[],
    env: Record<string, string> = {},
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: {
        ...process.env,
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_JWT: '',
        SEMANTIUS_HOST: '',
        SEMANTIUS_NO_DAEMON: '1',
        SEMANTIUS_MAX_RETRIES: '0',
        APPDATA: configDir,
        HOME: configDir,
        ...env,
      },
      stdin: stdin === undefined ? null : new Blob([stdin]),
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

  test('bare --token (no org prefix) is INVALID_TOKEN', async () => {
    const result = await runCli([
      '--token',
      'no-colon-here',
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [INVALID_TOKEN]:');
    expect(result.stderr).toContain('--token requires the form org:jwt');
  });

  test('--token with no value is a missing argument', async () => {
    const result = await runCli(['--token']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MISSING_ARGUMENT');
  });

  test('--token and --token-file together is INVALID_OPTION', async () => {
    const result = await runCli([
      '--token',
      'acme:x',
      '--token-file',
      join(configDir, 'whatever.txt'),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--token-file');
  });

  test('--token-file pointing at a missing file is TOKEN_FILE_UNREADABLE', async () => {
    const result = await runCli(['--token-file', join(configDir, 'nope.txt')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [TOKEN_FILE_UNREADABLE]:');
  });

  test('--token-file pointing at an empty (whitespace-only) file is TOKEN_FILE_UNREADABLE', async () => {
    const path = join(configDir, 'empty.txt');
    await writeFile(path, '   \n');
    const result = await runCli(['--token-file', path]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [TOKEN_FILE_UNREADABLE]:');
    expect(result.stderr).toContain('is empty');
  });

  test('--token-file reads and trims org:jwt, no stderr warning', async () => {
    const path = join(configDir, 'token.txt');
    await writeFile(path, `  acme:${JWT}  \n`);
    const result = await runCli([
      '--token-file',
      path,
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('puts the token on the command line');
  });

  test('--token - reads the token from stdin and passes the startup check', async () => {
    const result = await runCli(
      ['--token', '-', '-c', noServersConfig, 'info', 'utils'],
      {},
      `acme:${JWT}\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('MISSING_ENV_VAR');
    expect(result.stderr).not.toContain('puts the token on the command line');
  });

  test('--token - with call and no inline JSON is rejected: both read stdin', async () => {
    const result = await runCli(['--token', '-', 'call', 'crud', 'getCurrentUser']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('both read stdin');
  });

  test('--token - with call and inline JSON is fine (only the token reads stdin)', async () => {
    const result = await runCli(
      ['--token', '-', '-c', noServersConfig, 'call', 'utils', 'get_csvschema', '{}'],
      {},
      `acme:${JWT}\n`,
    );
    expect(result.stderr).not.toContain('INVALID_OPTION');
    expect(result.stderr).not.toContain('both read stdin');
  });

  test('a literal --token warns on stderr and still runs', async () => {
    const result = await runCli([
      '--token',
      `acme:${JWT}`,
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      '[semantius] Warning: --token puts the token on the command line, visible to other processes and the shell history; prefer --token - or --token-file.',
    );
  });

  test('--token cannot be combined with --auth apikey', async () => {
    const result = await runCli(['--token', 'acme:x', '--auth', 'apikey']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--auth apikey');
  });

  test('--token cannot be combined with --auth oauth', async () => {
    const result = await runCli(['--token', 'acme:x', '--auth', 'oauth']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
  });

  test('--token combined with --auth jwt is fine (redundant, not contradictory)', async () => {
    const result = await runCli([
      '--token',
      `acme:${JWT}`,
      '--auth',
      'jwt',
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.stderr).not.toContain('INVALID_OPTION');
    expect(result.exitCode).toBe(0);
  });

  test('--token cannot be combined with --login', async () => {
    const result = await runCli(['--token', 'acme:x', '--login', 'whoami']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('INVALID_OPTION');
    expect(result.stderr).toContain('--login');
  });

  test('--token acme:x --host other.example.com is HOST_CONFLICT', async () => {
    const result = await runCli([
      '--token',
      `acme:${JWT}`,
      '--host',
      'other.example.com',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error [HOST_CONFLICT]:');
    expect(result.stderr).toContain('acme.semantius.cloud');
    expect(result.stderr).toContain('other.example.com');
  });

  test('--token acme:x --host acme.semantius.cloud is allowed: same host', async () => {
    const result = await runCli([
      '--token',
      `acme:${JWT}`,
      '--host',
      'acme.semantius.cloud',
      '-c',
      noServersConfig,
      'info',
      'utils',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('HOST_CONFLICT');
  });

  test('the JSONL log redacts a literal --token, never the raw value', async () => {
    const logPath = join(configDir, 'semantius.jsonl');
    const result = await runCli(
      ['--token', `acme:${JWT}`, '-c', noServersConfig, 'info', 'utils'],
      { SEMANTIUS_LOG_FILE: logPath },
    );
    expect(result.exitCode).toBe(0);
    const log = await readFile(logPath, 'utf8');
    expect(log).not.toContain(JWT);
    const entry = JSON.parse(log.trim().split('\n')[0]);
    expect(entry.cli).toContain('--token');
    expect(entry.cli).toContain('<redacted>');
  });

  test('--help documents --token and --token-file', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--token <org:jwt | ->');
    expect(result.stdout).toContain('--token-file <path>');
  });
});
