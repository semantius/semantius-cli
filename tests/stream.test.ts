/**
 * Tests for `call crud postgrestRequest --stream` (src/local-tools/crud/stream.ts).
 *
 * 1. The request it builds equals the one the vendored postgrestRequest
 *    handler sends (fetch stubbed, in-process).
 * 2. End to end: the real CLI is spawned against a local Bun.serve stub posing
 *    as a (self-hosted) PostgREST at http://127.0.0.1:<port>/rest — byte-exact
 *    piping, CSV, stdin args, the exit-code table, the JWT retry, and the
 *    rejected flag combinations.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { isolateVendoredCall } from '../src/local-tools/crud/isolate';
import {
  type StreamArgs,
  buildStreamRequest,
  streamExitCode,
} from '../src/local-tools/crud/stream';
import { postgrestRequestTool } from '../src/vendor/postgrest-mcp/src/tools/postgrestRequest';

const PG = 'https://pg.example.com/rest/v1';

describe('buildStreamRequest equals the vendored handler request', () => {
  let originalFetch: typeof fetch;
  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const cases: StreamArgs[] = [
    { method: 'GET', path: '/order_details?limit=10', accept: 'text/csv' },
    { method: 'GET', path: '/products?id=eq.1' },
    { method: 'POST', path: '/contacts', body: { name: 'Grüße', n: 1 } },
    { method: 'POST', path: '/contacts?columns=a,b', body: [{ a: 1 }, { b: 2 }] },
    {
      method: 'PATCH',
      path: '/contacts?id=eq.1',
      body: { name: 'b' },
      accept: 'application/vnd.pgrst.object+json',
    },
    { method: 'DELETE', path: '/contacts?id=in.(1,2)' },
  ];

  for (const args of cases) {
    test(`${args.method} ${args.path}`, async () => {
      let captured: unknown;
      globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
        captured = {
          url: String(input),
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        };
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      // Run the handler as the local layer does (API_KEY & co. hidden).
      process.env.API_KEY = 'must-not-leak';
      try {
        const result = await isolateVendoredCall(() =>
          // The vendored Tool type lists every input key, optional ones as undefined.
          postgrestRequestTool.handler(
            { body: undefined, accept: undefined, ...args },
            { authInfo: { token: 'tok', apiBaseUrl: PG } },
          ),
        );
        expect(result.isError).toBeUndefined();
      } finally {
        delete process.env.API_KEY;
      }

      expect(buildStreamRequest(PG, 'tok', args)).toEqual(
        captured as ReturnType<typeof buildStreamRequest>,
      );
    });
  }

  test('exit codes: 401/403 → 5, 5xx → 3, other non-2xx → 4', () => {
    expect([401, 403].map(streamExitCode)).toEqual([5, 5]);
    expect([500, 502, 503, 504].map(streamExitCode)).toEqual([3, 3, 3, 3]);
    expect([400, 404, 406, 409, 422].map(streamExitCode)).toEqual([4, 4, 4, 4, 4]);
  });
});

describe('call crud postgrestRequest --stream (end to end)', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');
  const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig';

  interface Seen {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }
  let seen: Seen[] = [];
  let reply: (seen: Seen) => Response = () => new Response('[]');
  let server: ReturnType<typeof Bun.serve>;
  let host: string;

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const entry = {
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
          body: await req.text(),
        };
        seen.push(entry);
        return reply(entry);
      },
    });
    host = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  afterEach(() => {
    seen = [];
    reply = () => new Response('[]');
  });

  async function runCli(
    args: string[],
    opts: { env?: Record<string, string>; stdin?: string; host?: string | null } = {},
  ): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
    // The stub is the environment's profile: SEMANTIUS_HOST + SEMANTIUS_JWT
    // (--host would use only credentials stored for that host).
    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: {
        ...process.env,
        SEMANTIUS_API_KEY: '',
        SEMANTIUS_ORG: '',
        SEMANTIUS_HOST: opts.host === null ? '' : (opts.host ?? host),
        SEMANTIUS_JWT: JWT,
        SEMANTIUS_CONFIG_PATH: '',
        SEMANTIUS_CRUD_MCP: '',
        SEMANTIUS_STREAM: '',
        SEMANTIUS_NO_DAEMON: '1',
        SEMANTIUS_MAX_RETRIES: '0',
        // Must never reach PostgREST as `apikey`.
        API_KEY: 'leak',
        ...opts.env,
      },
      stdin: opts.stdin === undefined ? null : new Blob([opts.stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: new Uint8Array(stdout), stderr, exitCode };
  }

  const stream = (args: object) => [
    'call',
    'crud',
    'postgrestRequest',
    '--stream',
    JSON.stringify(args),
  ];

  test('pipes the PostgREST body to stdout byte for byte', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      name: `Grüße 🍺 ${i}`,
      price: i / 7,
    }));
    const body = new TextEncoder().encode(JSON.stringify(rows));
    reply = () =>
      new Response(body, { headers: { 'content-type': 'application/json' } });

    const result = await runCli(stream({ method: 'GET', path: '/order_details?limit=10000' }));

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.byteLength).toBe(body.byteLength);
    expect(Buffer.from(result.stdout).equals(Buffer.from(body))).toBe(true);

    expect(seen.length).toBe(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].path).toBe('/rest/order_details?limit=10000');
    expect(seen[0].headers.authorization).toBe(`Bearer ${JWT}`);
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].headers.prefer).toBe('return=representation');
    expect(seen[0].headers.apikey).toBeUndefined();
  });

  test('passes CSV through for accept: text/csv', async () => {
    const csv = 'id,name\n1,Chai\n2,"Chang, Ltd"\n';
    reply = () => new Response(csv, { headers: { 'content-type': 'text/csv' } });

    const result = await runCli(
      stream({ method: 'GET', path: '/products?limit=3', accept: 'text/csv' }),
    );

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(csv);
    expect(seen[0].headers.accept).toBe('text/csv');
  });

  test('reads JSON args from stdin as usual (POST body)', async () => {
    reply = () => new Response('[{"a":1},{"a":2}]', { status: 201 });
    const result = await runCli(['call', 'crud', 'postgrestRequest', '--stream'], {
      stdin: '{"method":"POST","path":"/t?columns=a","body":[{"a":1},{"a":2}]}',
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe('[{"a":1},{"a":2}]');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toBe('[{"a":1},{"a":2}]');
  });

  test('non-2xx: "Error: (code) message" on stderr, exit by status', async () => {
    for (const [status, code] of [
      [401, 5],
      [403, 5],
      [404, 4],
      [409, 4],
      [500, 3],
    ] as const) {
      reply = () =>
        Response.json({ code: `C${status}`, message: `failed ${status}` }, { status });
      const result = await runCli(stream({ method: 'GET', path: '/t' }));
      expect({ status, exitCode: result.exitCode }).toEqual({ status, exitCode: code });
      expect(result.stderr.trim()).toBe(`Error: (C${status}) failed ${status}`);
      expect(result.stdout.byteLength).toBe(0);
    }
  });

  test('a non-PostgREST error page names the status, the request and the host', async () => {
    reply = () =>
      new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    const result = await runCli(stream({ method: 'GET', path: '/t' }));
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe(
      `Error: (HTTP 502) Bad Gateway from GET ${host}/rest/t — is 127.0.0.1:${server.port} a Semantius instance? Its PostgREST is expected at ${host}/rest`,
    );
  });

  test('network failure → exit 3', async () => {
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = closed.port;
    closed.stop(true);
    const result = await runCli(stream({ method: 'GET', path: '/t' }), {
      host: `http://127.0.0.1:${port}`,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/^Error: /);
  });

  test('an expired token is re-exchanged and the request retried', async () => {
    let exchanges = 0;
    reply = (req) => {
      if (req.path === '/api/auth/token') {
        exchanges++;
        return Response.json({ access_token: `token-${exchanges}`, expires_in: 3600 });
      }
      return req.headers.authorization === 'Bearer token-1'
        ? Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 })
        : new Response('[{"ok":true}]');
    };
    const result = await runCli(stream({ method: 'GET', path: '/t' }), {
      env: {
        SEMANTIUS_JWT: '',
        SEMANTIUS_API_KEY: 'sk-streamtest-0123456789abcdef',
        SEMANTIUS_DISABLE_JWT_CACHE: '1',
      },
    });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe('[{"ok":true}]');
    expect(exchanges).toBe(2);
    const tokenRequests = seen.filter((s) => s.path === '/api/auth/token');
    expect(tokenRequests.map((s) => [s.method, s.headers['x-api-key']])).toEqual([
      ['GET', 'sk-streamtest-0123456789abcdef'],
      ['GET', 'sk-streamtest-0123456789abcdef'],
    ]);
  });

  test('rejected combinations exit 1 with one line, before any request', async () => {
    const q = JSON.stringify({ method: 'GET', path: '/t' });
    const rejected: Array<[string[], string, (string | null)?]> = [
      [['call', 'crud', 'postgrestRequest', '--stream', '--single', q], '--single'],
      [['call', 'crud', 'postgrestRequest', '--stream', '--diag', q], '--diag'],
      [['call', 'crud', 'read_entity', '--stream', '{}'], 'postgrestRequest'],
      [
        ['--host', 'acme.semantius.cloud', '--crud-mcp', 'call', 'crud', 'postgrestRequest', '--stream', q],
        '--crud-mcp',
        null,
      ],
    ];
    for (const [args, mention, hostOpt] of rejected) {
      const result = await runCli(args, { host: hostOpt });
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 1 });
      const lines = result.stderr.trim().split('\n');
      expect(lines.length).toBe(1);
      expect(lines[0]).toStartWith('Error [STREAM_UNSUPPORTED]: ');
      expect(lines[0]).toContain(mention);
    }
    expect(seen).toEqual([]);
  });

  test('--stream on a server that is not the local PostgREST layer → exit 1', async () => {
    const configPath = join(import.meta.dir, 'fixtures', 'no-servers.json');
    const result = await runCli([
      '-c',
      configPath,
      'call',
      'utils',
      'postgrestRequest',
      '--stream',
      '{"method":"GET","path":"/t"}',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      'Error [STREAM_UNSUPPORTED]: --stream needs the local PostgREST layer; server "utils" is not one',
    );
  });

  test('SEMANTIUS_STREAM=1 streams postgrestRequest and is ignored for other tools', async () => {
    reply = () => new Response('[{"id":1}]');
    const raw = await runCli(['call', 'crud', 'postgrestRequest', '{"method":"GET","path":"/t"}'], {
      env: { SEMANTIUS_STREAM: '1' },
    });
    expect(raw.exitCode).toBe(0);
    expect(new TextDecoder().decode(raw.stdout)).toBe('[{"id":1}]'); // compact, as sent

    const typed = await runCli(['call', 'crud', 'read_entity', '{}'], {
      env: { SEMANTIUS_STREAM: '1' },
    });
    expect(typed.exitCode).toBe(0);
    expect(new TextDecoder().decode(typed.stdout)).toBe('[\n  {\n    "id": 1\n  }\n]\n');
  });
});
