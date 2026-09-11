/**
 * Parity: the local PostgREST crud layer vs the remote crud MCP server
 * (--crud-mcp), against a real tenant. The A1 acceptance test.
 *
 * Skipped unless SEMANTIUS_PARITY=1 and SEMANTIUS_API_KEY / SEMANTIUS_ORG
 * are set (the repo .env has them for the `tests` tenant):
 *
 *   SEMANTIUS_PARITY=1 bun test --timeout 120000 tests/integration/parity.test.ts
 *
 * Each scenario runs the CLI twice — plain and with --crud-mcp — with the
 * environment from .env plus SEMANTIUS_NO_DAEMON=1. The scenarios are those of
 * docs/plans/bench/bench.ts. sqlToRest is MCP-only (not in the local layer),
 * so it is removed from the remote side of the listing comparisons.
 *
 * Needs network access to <org>.semantius.ai (Deno), api.semantius.cloud,
 * <org>.semantius.cloud/token and the tenant PostgREST. The write test creates
 * and deletes a scratch entity zz_parity_<epoch> in module 1001.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const ENABLED =
  process.env.SEMANTIUS_PARITY === '1' &&
  !!process.env.SEMANTIUS_API_KEY &&
  !!process.env.SEMANTIUS_ORG;

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const MCP_ONLY_TOOLS = ['sqlToRest'];

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, SEMANTIUS_NO_DAEMON: '1', ...env },
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

/** Run plain and with --crud-mcp; both must succeed. */
async function both(args: string[]): Promise<{ local: Run; mcp: Run }> {
  const [local, mcp] = await Promise.all([
    run(args),
    run(['--crud-mcp', ...args]),
  ]);
  expect(local.stderr).toBe('');
  expect(local.exitCode).toBe(0);
  expect(mcp.exitCode).toBe(0);
  return { local, mcp };
}

/** get_userinfo bumps these on every call. */
function withoutUserTimestamps(user: unknown): unknown {
  const { last_seen: _l, updated_at: _u, ...rest } = user as Record<
    string,
    unknown
  >;
  return rest;
}

/** The --diag fields that must match; response headers differ per call, request headers by design. */
function diagView(text: string, normData: (d: unknown) => unknown = (d) => d) {
  const e = JSON.parse(text);
  return {
    status: e.response.status,
    data: normData(e.response.data),
    method: e.request.method,
    url: e.request.url,
    body: e.request.body,
  };
}

describe.skipIf(!ENABLED)('local layer vs --crud-mcp parity', () => {
  interface Scenario {
    name: string;
    args: string[];
    norm?: (data: unknown) => unknown;
  }
  let scenarios: Scenario[] = [];
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    // Id columns and the first product id, as bench.ts derives them.
    const entities = await run([
      'call',
      'crud',
      'read_entity',
      JSON.stringify({ select: 'table_name,id_column', filters: 'module_id=eq.1001' }),
    ]);
    expect(entities.exitCode).toBe(0);
    ids = Object.fromEntries(
      (JSON.parse(entities.stdout) as Array<{ table_name: string; id_column: string }>).map(
        (e) => [e.table_name, e.id_column],
      ),
    );
    const first = await run([
      'call',
      'crud',
      'postgrestRequest',
      JSON.stringify({
        method: 'GET',
        path: `/products?select=${ids.products}&order=${ids.products}.asc&limit=1`,
      }),
    ]);
    expect(first.exitCode).toBe(0);
    const firstProductId = JSON.parse(first.stdout)[0][ids.products];

    const get = (path: string) => JSON.stringify({ method: 'GET', path });
    scenarios = [
      {
        name: 'getCurrentUser',
        args: ['call', 'crud', 'getCurrentUser', '{}'],
        norm: withoutUserTimestamps,
      },
      {
        name: 'single product (--single)',
        args: [
          'call',
          'crud',
          'postgrestRequest',
          '--single',
          get(`/products?${ids.products}=eq.${firstProductId}`),
        ],
      },
      {
        name: 'orders x100',
        args: ['call', 'crud', 'postgrestRequest', get(`/orders?order=${ids.orders}.asc&limit=100`)],
      },
      {
        name: 'order_details x1000',
        args: [
          'call',
          'crud',
          'postgrestRequest',
          get(`/order_details?order=${ids.order_details}.asc&limit=1000`),
        ],
      },
      {
        name: 'order_details x10000',
        args: [
          'call',
          'crud',
          'postgrestRequest',
          get(`/order_details?order=${ids.order_details}.asc&limit=10000`),
        ],
      },
    ];
  });

  test('default stdout is JSON-equal for the five bench scenarios', async () => {
    for (const s of scenarios) {
      const { local, mcp } = await both(s.args);
      const norm = s.norm ?? ((d: unknown) => d);
      expect({ scenario: s.name, data: norm(JSON.parse(local.stdout)) }).toEqual({
        scenario: s.name,
        data: norm(JSON.parse(mcp.stdout)),
      });
    }
  });

  test('--diag agrees on status, data, method, url and body', async () => {
    for (const s of scenarios) {
      const [, , , ...rest] = s.args; // ['call', 'crud', tool, ...]
      const args = ['call', 'crud', s.args[2], '--diag', ...rest];
      const { local, mcp } = await both(args);
      expect({ scenario: s.name, ...diagView(local.stdout, s.norm) }).toEqual({
        scenario: s.name,
        ...diagView(mcp.stdout, s.norm),
      });
      // The local envelope no longer echoes the bearer (Q15).
      expect(local.stdout).not.toMatch(/"authorization"/i);
    }
  });

  test('info crud: same tools (minus MCP-only) and the same instructions', async () => {
    const { local, mcp } = await both(['info', 'crud']);
    const parse = (text: string) => {
      const lines = text.split('\n');
      const toolsAt = lines.findIndex((l) => /^Tools \(\d+\):$/.test(l));
      const instrAt = lines.indexOf('Instructions:');
      return {
        instructions: lines.slice(instrAt + 1, toolsAt).join('\n'),
        tools: lines
          .slice(toolsAt + 1)
          .map((l) => /^ {2}(\w+)$/.exec(l)?.[1])
          .filter((n): n is string => !!n),
      };
    };
    const l = parse(local.stdout);
    const m = parse(mcp.stdout);
    expect(local.stdout).toContain('Transport: postgrest');
    expect(mcp.stdout).toContain('Transport: HTTP');
    expect(l.instructions.length).toBeGreaterThan(1000);
    expect(l.instructions).toBe(m.instructions);
    expect(l.tools).toEqual(m.tools.filter((t) => !MCP_ONLY_TOOLS.includes(t)));
  });

  test('grep and -md are text-equal apart from MCP-only tools', async () => {
    const dropMcpOnlyLines = (text: string) =>
      text
        .split('\n')
        .filter((l) => !MCP_ONLY_TOOLS.some((t) => l.includes(t)))
        .join('\n');
    const g = await both(['grep', '*']);
    expect(g.local.stdout).toBe(dropMcpOnlyLines(g.mcp.stdout));

    // In -md, drop each MCP-only tool's "#### <tool>" section and the tool
    // counts it changes.
    const dropMcpOnlySections = (md: string) => {
      const out: string[] = [];
      let skipping = false;
      for (const line of md.split('\n')) {
        if (line.startsWith('#')) {
          skipping = MCP_ONLY_TOOLS.some((t) => line === `#### ${t}`);
        }
        if (!skipping) out.push(line.replace(/^### Tools \(\d+\)$/, '### Tools'));
      }
      return out.join('\n');
    };
    const md = await both(['-md']);
    expect(dropMcpOnlySections(md.local.stdout)).toBe(dropMcpOnlySections(md.mcp.stdout));
  });

  describe('--stream', () => {
    /** A token and the PostgREST URL straight from the platform, as bench.ts gets them. */
    async function direct(path: string, accept?: string): Promise<Uint8Array> {
      const org = process.env.SEMANTIUS_ORG as string;
      const raw = process.env.SEMANTIUS_API_KEY as string;
      const apiKey = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      const tokenResponse = await fetch(`https://${org}.semantius.cloud/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-api-key': apiKey,
        },
        body: 'grant_type=client_credentials',
      });
      const { access_token } = (await tokenResponse.json()) as { access_token: string };
      const tenant = (await (
        await fetch(`https://api.semantius.cloud/organization/${org}`)
      ).json()) as { postgrest_url: string };
      const response = await fetch(`${tenant.postgrest_url}${path}`, {
        headers: {
          authorization: `Bearer ${access_token}`,
          ...(accept ? { accept } : {}),
        },
      });
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    }

    async function streamed(path: string, accept?: string): Promise<Uint8Array> {
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          CLI,
          'call',
          'crud',
          'postgrestRequest',
          '--stream',
          JSON.stringify({ method: 'GET', path, ...(accept ? { accept } : {}) }),
        ],
        {
          cwd: REPO,
          env: { ...process.env, SEMANTIUS_NO_DAEMON: '1' },
          stdin: null,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      return new Uint8Array(stdout);
    }

    test('order_details x10000: stdout is the PostgREST body, byte for byte', async () => {
      const path = `/order_details?order=${ids.order_details}.asc&limit=10000`;
      const [cli, body] = await Promise.all([streamed(path), direct(path)]);
      expect(cli.byteLength).toBe(body.byteLength);
      expect(Buffer.from(cli).equals(Buffer.from(body))).toBe(true);
    });

    test('accept: text/csv passes the CSV through', async () => {
      const path = `/products?order=${ids.products}.asc&limit=3`;
      const [cli, body] = await Promise.all([
        streamed(path, 'text/csv'),
        direct(path, 'text/csv'),
      ]);
      expect(new TextDecoder().decode(cli)).toBe(new TextDecoder().decode(body));
      expect(new TextDecoder().decode(cli).split('\n')[0]).toContain(ids.products);
    });
  });

  describe('writes through the local layer', () => {
    const table = `zz_parity_${Date.now()}`;

    afterAll(async () => {
      await run(['call', 'crud', 'delete_entity', JSON.stringify({ table_name: table })]);
    });

    test('create_field refreshes the schema cache exactly once', async () => {
      const entity = await run([
        'call',
        'crud',
        'create_entity',
        JSON.stringify({ data: { table_name: table, singular_label: 'Parity', module_id: 1001 } }),
      ]);
      expect(entity.stderr).toBe('');
      expect(entity.exitCode).toBe(0);

      const field = await run(
        [
          'call',
          'crud',
          'create_field',
          JSON.stringify({
            data: { table_name: table, field_name: 'note', title: 'Note', format: 'string' },
          }),
        ],
        { SEMANTIUS_DEBUG: '1' },
      );
      expect(field.exitCode).toBe(0);
      expect(JSON.parse(field.stdout)[0].field_name).toBe('note');
      const okLines = field.stderr
        .split('\n')
        .filter((l) => l.includes('resetSchemaCache: refresh_schema_cache ok'));
      expect(okLines).toEqual(['[semantius] resetSchemaCache: refresh_schema_cache ok']);
    });
  });
});
