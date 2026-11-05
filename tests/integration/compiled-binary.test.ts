/**
 * Integration test: the COMPILED binary must carry what the crud tools read from
 * disk at run time, on every OS CI tests.
 *
 * sqlToRest's WASM parser is read from next to its glue code as soon as the crud
 * tools load. From source that file is in node_modules, so a run from source
 * passes whether or not a release binary has it. Built without it the binary
 * still compiles, then reports an ENOENT on pg-parser.wasm on every crud command.
 * Hence this test compiles a real binary the way a release does (scripts/build.ts)
 * and runs it away from the repository, where nothing else could supply the file.
 *
 * No request is sent: sqlToRest computes locally, and example.invalid cannot
 * resolve if that ever changes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCommand } from '../../scripts/build';

describe('compiled binary', () => {
  let tempDir: string;
  let binary: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-compiled-'));
    binary = join(
      tempDir,
      process.platform === 'win32' ? 'semantius.exe' : 'semantius',
    );
    const build = Bun.spawnSync({
      cmd: compileCommand({ outfile: binary }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`compile failed: ${build.stderr.toString()}`);
    }
  }, 120_000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function run(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn([binary, ...args], {
      cwd: tempDir,
      env: {
        ...process.env,
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_HOST: 'https://example.invalid',
        SEMANTIUS_JWT: 'test-jwt',
        SEMANTIUS_CONFIG_PATH: '',
        SEMANTIUS_CRUD_MCP: '',
        SEMANTIUS_NO_DAEMON: '1',
        SEMANTIUS_MAX_RETRIES: '0',
        APPDATA: tempDir,
        LOCALAPPDATA: tempDir,
        HOME: tempDir,
      },
      stdin: null,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test('sqlToRest translates SQL', async () => {
    const r = await run([
      'call',
      'crud',
      'sqlToRest',
      JSON.stringify({
        sql: 'SELECT id, name FROM users WHERE id > 5 ORDER BY name LIMIT 1',
      }),
    ]);
    expect(r.stderr).not.toContain('pg-parser');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      method: 'GET',
      path: '/users?select=id,name&id=gt.5&order=name&limit=1',
    });
  }, 30_000);

  test('sqlToRest reports the parser error for SQL it cannot read', async () => {
    const r = await run([
      'call',
      'crud',
      'sqlToRest',
      JSON.stringify({ sql: 'SELEC nonsense' }),
    ]);
    expect(r.stderr).toContain('syntax error');
    expect(r.stderr).not.toContain('pg-parser');
    expect(r.exitCode).toBe(4);
  }, 30_000);

  test('the other crud tools load without a word about the parser', async () => {
    const r = await run(['info', 'crud', 'getCurrentUser']);
    expect(r.stderr).not.toContain('pg-parser');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Tool: getCurrentUser');
  }, 30_000);
});
