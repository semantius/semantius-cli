/**
 * Integration test: the COMPILED binary must be able to spawn and reuse its
 * connection daemon on POSIX.
 *
 * Regression guard for the bug where spawnDaemon ran
 * `bun run <import.meta.dir>/daemon.ts`: inside a `bun build --compile`
 * binary that path is Bun's virtual bundle (/$bunfs/root), so the spawn
 * failed and every call silently fell back to a direct connection. The
 * daemon only ever worked under `bun run src/index.ts`, which is why unit
 * tests never caught it — hence this test compiles a real binary.
 *
 * Skipped on Windows (no daemon there by design) and requires npx for the
 * filesystem MCP server, like cli.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPidPath, getSocketPath } from '../../src/config';
import { isProcessRunning, killProcess } from '../../src/daemon';

const posixOnly = process.platform !== 'win32';

describe.skipIf(!posixOnly)('compiled binary daemon', () => {
  let tempDir: string;
  let binary: string;
  let configPath: string;
  let logPath: string;
  // Unique server name so the test never touches a real daemon of the user.
  const serverName = `fs-daemon-test-${process.pid}`;

  async function runCli(
    args: string[],
    stdin?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: [binary, ...args],
      cwd: tempDir,
      // Large JSON arguments must be piped (the OS argv limit is ~128 KB).
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SEMANTIUS_API_KEY: 'sk-test-dummy',
        SEMANTIUS_ORG: 'test',
        SEMANTIUS_DEBUG: '1',
        SEMANTIUS_LOG_FILE: logPath,
        SEMANTIUS_LOG_LEVELS: 'all',
        SEMANTIUS_DAEMON_TIMEOUT: '60',
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  function logEvents(): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.log_type === 'event')
      .map((e) => e.event as string);
  }

  function daemonPid(): number | null {
    const pidPath = getPidPath(serverName);
    if (!existsSync(pidPath)) return null;
    return JSON.parse(readFileSync(pidPath, 'utf8')).pid as number;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-daemon-test-'));
    binary = join(tempDir, 'semantius');
    logPath = join(tempDir, 'semantius.jsonl');

    const build = Bun.spawnSync({
      cmd: [
        'bun',
        'build',
        '--compile',
        join(import.meta.dir, '..', '..', 'src', 'index.ts'),
        '--outfile',
        binary,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`bun build --compile failed: ${build.stderr.toString()}`);
    }

    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [serverName]: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
            env: { npm_config_registry: 'https://registry.npmjs.org' },
          },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    const pid = daemonPid();
    if (pid && isProcessRunning(pid)) killProcess(pid);
    for (const p of [getPidPath(serverName), getSocketPath(serverName)]) {
      await rm(p, { force: true });
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('first call spawns a daemon and the daemon outlives the CLI process', async () => {
    const r = await runCli([
      '-c',
      configPath,
      'call',
      '--diag', // list_directory returns plain text, not JSON
      serverName,
      'list_directory',
      JSON.stringify({ path: tempDir }),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('mcp_servers.json');
    expect(r.stderr).toContain('Using daemon connection');
    expect(logEvents()).toContain('daemon_start');

    const pid = daemonPid();
    expect(pid).not.toBeNull();
    expect(isProcessRunning(pid as number)).toBe(true);
    expect(existsSync(getSocketPath(serverName))).toBe(true);
  }, 120_000);

  test('second call reuses the running daemon instead of spawning another', async () => {
    const before = logEvents().filter((e) => e === 'daemon_start').length;
    const pidBefore = daemonPid();

    const r = await runCli([
      '-c',
      configPath,
      'call',
      '--diag', // list_directory returns plain text, not JSON
      serverName,
      'list_directory',
      JSON.stringify({ path: tempDir }),
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Using daemon connection');
    expect(r.stderr).not.toContain('Spawning daemon');

    expect(logEvents().filter((e) => e === 'daemon_start').length).toBe(before);
    expect(daemonPid()).toBe(pidBefore);
  }, 60_000);

  test('large request and response frames survive the daemon socket', async () => {
    // Both directions exceed one socket read (~64 KB) several times over, and
    // the multi-byte characters can land on any chunk boundary. Before frames
    // were newline-delimited, this failed with "Invalid response from daemon".
    const content = 'zeile-äöü-€-'.repeat(50_000); // ≈ 700 KB UTF-8
    const bigFile = join(tempDir, 'big.txt');

    const w = await runCli(
      ['-c', configPath, 'call', '--diag', serverName, 'write_file'],
      JSON.stringify({ path: bigFile, content }), // via stdin: too big for argv
    );
    expect(w.code).toBe(0);
    expect(w.stderr).toContain('Using daemon connection');

    const r = await runCli([
      '-c',
      configPath,
      'call',
      '--diag',
      serverName,
      'read_text_file',
      JSON.stringify({ path: bigFile }),
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Using daemon connection');
    // --diag prints the tool's text content verbatim (plus a trailing newline)
    expect(r.stdout.trimEnd()).toBe(content);
  }, 120_000);

  test('SIGTERM shuts the daemon down cleanly (daemon_stop logged, files removed)', async () => {
    const pid = daemonPid();
    expect(pid).not.toBeNull();
    killProcess(pid as number); // SIGTERM → cleanup('sigterm')

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isProcessRunning(pid as number)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isProcessRunning(pid as number)).toBe(false);
    expect(logEvents()).toContain('daemon_stop');
    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName))).toBe(false);
  }, 30_000);
});
