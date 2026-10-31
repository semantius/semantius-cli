/**
 * Integration test: the COMPILED binary must be able to spawn and reuse its
 * connection daemons on POSIX: an MCP daemon, and the PostgREST proxy
 * daemon of the local crud layer.
 *
 * Regression guard for the bugs where spawnDaemon ran
 * `bun run <import.meta.dir>/daemon.ts`, and later told the compiled binary
 * apart from a source run by its file name: inside a `bun build --compile`
 * binary the first path is Bun's virtual bundle (/$bunfs/root), and a release
 * binary is installed under another name than it was built with, so the
 * spawn failed and every call silently fell back to a direct connection. The
 * daemon only ever worked under `bun run src/index.ts`, which is why unit
 * tests never caught it — hence this test compiles a real binary, under a
 * build name, and runs it renamed.
 *
 * Daemons start in the background (the spawning call goes direct), so each
 * first call is followed by a wait for the daemon to be ready.
 *
 * Skipped on Windows (no daemon there by design) and requires npx for the
 * filesystem MCP server, like cli.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPidPath, getSocketPath } from '../../src/config';
import { isProcessRunning, killProcess } from '../../src/daemon';
import { proxyDaemonName } from '../../src/postgrest-proxy';

const posixOnly = process.platform !== 'win32';

describe.skipIf(!posixOnly)('compiled binary daemon', () => {
  let tempDir: string;
  let binary: string;
  let configPath: string;
  let logPath: string;
  // Unique server name so the test never touches a real daemon of the user.
  const serverName = `fs-daemon-test-${process.pid}`;

  // The local crud layer's PostgREST, stubbed in this process.
  let postgrest: ReturnType<typeof Bun.serve>;
  let origin: string;
  let proxyName: string;
  const postgrestHits: string[] = [];

  async function runCli(
    args: string[],
    stdin?: string,
    env: Record<string, string> = {},
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
        HOME: tempDir,
        APPDATA: tempDir,
        LOCALAPPDATA: tempDir,
        // The stub is a self-hosted host: resolved without any network, and
        // the JWT is its credential (an org would be looked up online).
        SEMANTIUS_HOST: origin,
        SEMANTIUS_JWT: 'test-jwt',
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_CONFIG_PATH: '',
        SEMANTIUS_CRUD_MCP: '',
        SEMANTIUS_MAX_RETRIES: '0',
        SEMANTIUS_DEBUG: '1',
        SEMANTIUS_LOG_FILE: logPath,
        SEMANTIUS_LOG_LEVELS: 'all',
        SEMANTIUS_DAEMON_TIMEOUT: '60',
        SEMANTIUS_NO_DAEMON: '0',
        ...env,
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

  function daemonPid(name = serverName): number | null {
    const pidPath = getPidPath(name);
    if (!existsSync(pidPath)) return null;
    return JSON.parse(readFileSync(pidPath, 'utf8')).pid as number;
  }

  /** Wait until a daemon spawned in the background has opened its socket. */
  async function waitForDaemon(name: string): Promise<number> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const pid = daemonPid(name);
      if (pid && existsSync(getSocketPath(name, pid))) return pid;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no daemon for ${name} came up`);
  }

  const listDirectory = () => [
    '-c',
    configPath,
    'call',
    '--diag', // list_directory returns plain text, not JSON
    serverName,
    'list_directory',
    JSON.stringify({ path: tempDir }),
  ];

  const getThings = () => [
    '-c',
    configPath,
    'call',
    'crud',
    'postgrestRequest',
    JSON.stringify({ method: 'GET', path: '/things' }),
  ];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-daemon-test-'));
    // Built under a release-style name, run under the installed one.
    const built = join(tempDir, 'semantius-test-build');
    binary = join(tempDir, 'semantius');
    logPath = join(tempDir, 'semantius.jsonl');

    const build = Bun.spawnSync({
      cmd: [
        'bun',
        'build',
        '--compile',
        join(import.meta.dir, '..', '..', 'src', 'index.ts'),
        '--outfile',
        built,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`bun build --compile failed: ${build.stderr.toString()}`);
    }
    await rename(built, binary);

    postgrest = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/rest/v1/')) {
          return new Response(null, { status: 404 });
        }
        postgrestHits.push(`${req.method} ${url.pathname}`);
        // Compressed, as a real PostgREST behind a CDN answers: the proxy
        // must pass the encoding through for the CLI's fetch to decode.
        return new Response(
          Bun.gzipSync(JSON.stringify([{ id: 'via-stub' }])),
          {
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
            },
          },
        );
      },
    });
    origin = `http://127.0.0.1:${postgrest.port}`;
    proxyName = proxyDaemonName(origin);

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
          crud: { postgrest: `${origin}/rest/v1` },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const name of [serverName, proxyName]) {
      const pid = daemonPid(name);
      if (pid && isProcessRunning(pid)) killProcess(pid);
      await rm(getPidPath(name), { force: true });
      if (pid) await rm(getSocketPath(name, pid), { force: true });
    }
    postgrest?.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  });

  test('first call goes direct and starts a daemon that outlives the CLI process', async () => {
    const r = await runCli(listDirectory());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('mcp_servers.json');
    expect(r.stderr).toContain('Spawning daemon');
    expect(r.stderr).toContain('Using direct connection');

    const pid = await waitForDaemon(serverName);
    expect(isProcessRunning(pid)).toBe(true);
    expect(logEvents()).toContain('daemon_start');
  }, 120_000);

  test('second call reuses the running daemon instead of spawning another', async () => {
    const before = logEvents().filter((e) => e === 'daemon_start').length;
    const pidBefore = daemonPid();

    const r = await runCli(listDirectory());
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
    expect(existsSync(getSocketPath(serverName, pid as number))).toBe(false);
  }, 30_000);

  test('the local crud layer goes direct first, then through its PostgREST daemon', async () => {
    const first = await runCli(getThings());
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('via-stub');
    expect(first.stderr).toContain(`Spawning daemon for ${proxyName}`);
    expect(first.stderr).not.toContain('through its daemon');

    const pid = await waitForDaemon(proxyName);
    const hitsBefore = postgrestHits.length;

    const second = await runCli(getThings());
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('via-stub');
    expect(second.stderr).toContain('through its daemon');
    expect(second.stderr).not.toContain('Spawning daemon');
    expect(postgrestHits.length).toBe(hitsBefore + 1);
    expect(daemonPid(proxyName)).toBe(pid);
  }, 120_000);

  test('an upstream the PostgREST daemon cannot reach fails as a direct request would', async () => {
    postgrest.stop(true);
    const direct = await runCli(getThings(), undefined, {
      SEMANTIUS_NO_DAEMON: '1',
    });
    const r = await runCli(getThings());
    expect(r.stderr).toContain('through its daemon');
    // The connection error itself, not a 502 from the daemon.
    expect(direct.stderr).toContain('Unable to connect');
    expect(r.stderr).toContain('Unable to connect');
    expect(r.code).toBe(direct.code);
  }, 60_000);
});
