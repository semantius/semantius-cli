/**
 * Tests for postgrest-proxy.ts: requests to a PostgREST origin go through
 * its proxy daemon once one is ready, arrive unchanged, fail as network
 * errors when the daemon cannot reach the origin, and go direct again when
 * the daemon disappears. tests/integration/daemon.test.ts covers the same
 * path end to end with the compiled binary, spawn included.
 *
 * The daemon here is started from source by the test itself (Bun.main is the
 * test file, so spawnDaemon could not), under its real name, so that
 * routePostgrestThroughDaemon finds it ready and never spawns one.
 *
 * POSIX only, like every daemon: there is none on Windows.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPidPath, getSocketPath } from '../src/config';
import {
  DAEMON_CONFIG_ENV,
  PROXY_TIMING_HEADER,
  isProcessRunning,
  readPidFile,
} from '../src/daemon';
import {
  proxyDaemonName,
  resetPostgrestRoutesForTests,
  routePostgrestThroughDaemon,
} from '../src/postgrest-proxy';

const posixOnly = process.platform !== 'win32';
const indexTs = join(import.meta.dir, '..', 'src', 'index.ts');

describe.skipIf(!posixOnly)('PostgREST through its daemon', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let origin: string;
  const daemons: ReturnType<typeof Bun.spawn>[] = [];
  const hits: string[] = [];
  let noDaemon: string | undefined;

  /** Start a proxy daemon for `target` and wait for its socket. */
  async function startDaemon(target: string): Promise<number> {
    const name = proxyDaemonName(target);
    const proc = Bun.spawn({
      cmd: [process.execPath, indexTs, '--daemon', name],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: {
        ...process.env,
        [DAEMON_CONFIG_ENV]: JSON.stringify({ postgrestProxy: target }),
        SEMANTIUS_DAEMON_TIMEOUT: '60',
      },
    });
    daemons.push(proc);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (
        readPidFile(name)?.pid === proc.pid &&
        existsSync(getSocketPath(name, proc.pid))
      ) {
        return proc.pid;
      }
      await Bun.sleep(50);
    }
    throw new Error(`proxy daemon for ${target} did not come up`);
  }

  beforeAll(() => {
    noDaemon = process.env.SEMANTIUS_NO_DAEMON;
    process.env.SEMANTIUS_NO_DAEMON = '0';
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.startsWith('/rest/')) {
          return new Response(null, { status: 404 });
        }
        hits.push(
          `${req.method} ${url.pathname}${url.search} ${req.headers.get('authorization')} ${await req.text()}`,
        );
        return new Response(Bun.gzipSync('[{"ok":true}]'), {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          },
        });
      },
    });
    origin = `http://127.0.0.1:${upstream.port}`;
  });

  afterEach(() => {
    resetPostgrestRoutesForTests();
    hits.length = 0;
  });

  afterAll(async () => {
    for (const proc of daemons) {
      proc.kill();
      await proc.exited;
    }
    upstream.stop(true);
    if (noDaemon === undefined)
      Reflect.deleteProperty(process.env, 'SEMANTIUS_NO_DAEMON');
    else process.env.SEMANTIUS_NO_DAEMON = noDaemon;
  });

  test('a request arrives through the daemon unchanged, and its answer back', async () => {
    const pid = await startDaemon(origin);
    const seen: { url: string; unix?: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        unix: (init as { unix?: string })?.unix,
      });
      return real(input as string, init);
    }) as typeof fetch;
    try {
      routePostgrestThroughDaemon(`${origin}/rest/v1`);
      const response = await fetch(`${origin}/rest/v1/things?id=eq.1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t0k3n' },
        body: '{"a":1}',
      });
      expect(response.status).toBe(201);
      // Debug-only: never part of the headers a tool returns.
      expect(response.headers.get(PROXY_TIMING_HEADER)).toBeNull();
      expect(await response.json()).toEqual([{ ok: true }]);
    } finally {
      resetPostgrestRoutesForTests();
      globalThis.fetch = real;
    }
    expect(hits).toEqual(['POST /rest/v1/things?id=eq.1 Bearer t0k3n {"a":1}']);
    expect(seen).toEqual([
      {
        url: 'http://localhost/rest/v1/things?id=eq.1',
        unix: getSocketPath(proxyDaemonName(origin), pid),
      },
    ]);
  }, 30_000);

  test('other origins are left alone', async () => {
    routePostgrestThroughDaemon(`${origin}/rest/v1`);
    const other = await fetch(`http://localhost:${upstream.port}/rest/v1/x`);
    expect(other.status).toBe(201);
    expect(hits).toHaveLength(1);
  }, 30_000);

  test('an origin the daemon cannot reach fails as a network error', async () => {
    // A port with nothing listening on it.
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const dead = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await startDaemon(dead);

    routePostgrestThroughDaemon(`${dead}/rest/v1`);
    const error = await fetch(`${dead}/rest/v1/things`).catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
  }, 30_000);

  test('requests go direct again once the daemon is gone', async () => {
    const pid = (readPidFile(proxyDaemonName(origin)) ?? { pid: 0 }).pid;
    expect(isProcessRunning(pid)).toBe(true);
    routePostgrestThroughDaemon(`${origin}/rest/v1`);

    const proc = daemons.find((d) => d.pid === pid);
    proc?.kill();
    await proc?.exited;
    expect(existsSync(getPidPath(proxyDaemonName(origin)))).toBe(false);

    const response = await fetch(`${origin}/rest/v1/after`);
    expect(response.status).toBe(201);
    expect(hits).toEqual(['GET /rest/v1/after null ']);
  }, 30_000);
});
