/**
 * Benchmark: semantius CLI (via crud MCP server on Deno Deploy) vs. direct PostgREST.
 *
 * Usage:
 *   bun run bench.ts warm [iterations]        interleaved warm runs, all scenarios, all paths
 *   bun run bench.ts cold cli-first|direct-first   one pass per scenario after an idle period
 *
 * Paths:
 *   cli         spawn semantius-bench.exe call crud <tool> ... (wall clock; mcp_ms from the CLI's own JSONL log)
 *   direct-proc spawn `bun run direct-one.ts` (fresh process + fresh TLS + one fetch)
 *   direct-keep in-process fetch with keep-alive (network floor)
 *
 * Secrets: API key read from the repo .env, JWT fetched once via /token and passed to children via env only.
 */
import { join } from 'node:path';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';

const HERE = import.meta.dir;
const CLI = join(HERE, '..', 'semantius-bench.exe');
const LOG = join(HERE, 'cli.jsonl');
const RESULTS = join(HERE, 'results.jsonl');
const REPO = 'C:/dev/semantius-cli';

const mode = process.argv[2] ?? 'warm';
const arg3 = process.argv[3];
const iterations = mode === 'warm' ? Number(arg3 ?? 8) : 1;

// ---------------------------------------------------------------- setup
const env = Object.fromEntries(
  readFileSync(join(REPO, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const ORG = env.SEMANTIUS_ORG as string;
const KEY = env.SEMANTIUS_API_KEY as string;

async function getJwt(): Promise<string> {
  const r = await fetch(`https://${ORG}.semantius.cloud/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-api-key': KEY },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return (await r.json()).access_token;
}
async function getPostgrestUrl(): Promise<string> {
  const r = await fetch(`https://api.semantius.cloud/organization/${ORG}`);
  return (await r.json()).postgrest_url;
}

// Setup calls are NOT part of the measurement, but in cold mode they would warm the
// backends. Cold mode therefore reads a cached setup file written by a warm run.
const SETUP = join(HERE, 'setup.json');
interface Setup { pg: string; jwt: string; jwtExp: number; ids: Record<string, string>; counts: Record<string, number> }
let setup: Setup;
if (mode === 'cold' && existsSync(SETUP)) {
  setup = JSON.parse(readFileSync(SETUP, 'utf8'));
  if (setup.jwtExp - Date.now() < 5 * 60_000) throw new Error('cached JWT about to expire; run a warm pass first');
} else {
  const jwt = await getJwt();
  const exp = JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp * 1000;
  const pg = await getPostgrestUrl();
  const H = { authorization: `Bearer ${jwt}` };
  const ents: Array<{ table_name: string; id_column: string }> = await (await fetch(`${pg}/entities?select=table_name,id_column&module_id=eq.1001`, { headers: H })).json();
  const ids = Object.fromEntries(ents.map((e) => [e.table_name, e.id_column]));
  const counts: Record<string, number> = {};
  for (const t of ['products', 'orders', 'order_details', 'customers']) {
    const r = await fetch(`${pg}/${t}?select=${ids[t]}`, { method: 'HEAD', headers: { ...H, prefer: 'count=exact' } });
    counts[t] = Number((r.headers.get('content-range') ?? '/-1').split('/')[1]);
  }
  setup = { pg, jwt, jwtExp: exp, ids, counts };
  await Bun.write(SETUP, JSON.stringify(setup));
}
const { pg, jwt, ids, counts } = setup;

// ---------------------------------------------------------------- scenarios
interface Scenario {
  name: string;
  label: string;
  cliTool: string;
  cliArgs: Record<string, unknown>;
  cliFlags?: string[];
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  accept?: string;
  /** normalise both sides to comparable JSON */
  norm?: (x: unknown) => unknown;
}
const firstProductId = (await (await fetch(`${pg}/products?select=${ids.products}&order=${ids.products}.asc&limit=1`, { headers: { authorization: `Bearer ${jwt}` } })).json())[0][ids.products];

const scenarios: Scenario[] = [
  {
    name: 'user', label: 'getCurrentUser (what `ping` uses)',
    cliTool: 'getCurrentUser', cliArgs: {},
    method: 'POST', path: '/rpc/get_userinfo', body: '{}',
    // the MCP tool adds api_baseurl / semantius_org / ui_baseurl; strip for comparison
    // last_seen / updated_at are bumped by the RPC itself on every call
    norm: (x) => { const o = { ...(x as Record<string, unknown>) }; for (const k of ['api_baseurl', 'semantius_org', 'ui_baseurl', 'last_seen', 'updated_at']) delete o[k]; return o; },
  },
  {
    name: 'single', label: `single record: products?${ids.products}=eq.${firstProductId} (--single)`,
    cliTool: 'postgrestRequest', cliArgs: { method: 'GET', path: `/products?${ids.products}=eq.${firstProductId}` }, cliFlags: ['--single'],
    method: 'GET', path: `/products?${ids.products}=eq.${firstProductId}`, accept: 'application/vnd.pgrst.object+json',
  },
  {
    name: 'page100', label: 'page of 100: orders?limit=100',
    cliTool: 'postgrestRequest', cliArgs: { method: 'GET', path: `/orders?order=${ids.orders}.asc&limit=100` },
    method: 'GET', path: `/orders?order=${ids.orders}.asc&limit=100`,
  },
  {
    name: 'page1000', label: 'page of 1000: order_details?limit=1000',
    cliTool: 'postgrestRequest', cliArgs: { method: 'GET', path: `/order_details?order=${ids.order_details}.asc&limit=1000` },
    method: 'GET', path: `/order_details?order=${ids.order_details}.asc&limit=1000`,
  },
  {
    name: 'full', label: `full table: order_details (${counts.order_details} rows, limit=10000)`,
    cliTool: 'postgrestRequest', cliArgs: { method: 'GET', path: `/order_details?order=${ids.order_details}.asc&limit=10000` },
    method: 'GET', path: `/order_details?order=${ids.order_details}.asc&limit=10000`,
  },
];

// ---------------------------------------------------------------- runners
interface Sample {
  mode: string; order?: string; scenario: string; path: string; iter: number;
  wallMs: number; innerMs?: number; mcpMs?: number; bytes?: number; rows?: number; ok: boolean; error?: string; ts: string;
  jwtMiss?: boolean;
}

// Baselines (CLI only): process start alone, and process + in-process MCP server with no network.
const CSV = join(HERE, 'tiny.csv');
if (!existsSync(CSV)) await Bun.write(CSV, 'id,name\n1,a\n2,b\n');
async function runCliBaseline(kind: 'startup' | 'local'): Promise<Sample> {
  const args = kind === 'startup' ? ['--version'] : ['call', 'utils', 'get_csvschema', JSON.stringify({ path: CSV })];
  const t0 = performance.now();
  const proc = Bun.spawn({ cmd: [CLI, ...args], cwd: REPO, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SEMANTIUS_LOG_FILE: LOG, SEMANTIUS_LOG_LEVELS: 'all' } });
  const [, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { mode, order: arg3, scenario: `cli-${kind}`, path: 'cli', iter: 0, wallMs: performance.now() - t0, ok: code === 0, ts: new Date().toISOString() };
}

function rowsOf(x: unknown): number | undefined { return Array.isArray(x) ? x.length : x && typeof x === 'object' ? 1 : undefined; }

async function runCli(s: Scenario, iter: number): Promise<{ sample: Sample; data: unknown }> {
  const args = ['call', 'crud', s.cliTool, ...(s.cliFlags ?? []), JSON.stringify(s.cliArgs)];
  const t0 = performance.now();
  const proc = Bun.spawn({
    cmd: [CLI, ...args], cwd: REPO, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, SEMANTIUS_LOG_FILE: LOG, SEMANTIUS_LOG_LEVELS: 'all', SEMANTIUS_DEBUG: '1' },
  });
  const [out, errRaw, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const wallMs = performance.now() - t0;
  // Debug output is only used to detect a token fetch inside the timed call; never persisted.
  const jwtMiss = /JWT cache miss/.test(errRaw);
  const err = errRaw.split('\n').filter((l) => !l.startsWith('[semantius]')).join('\n');
  let mcpMs: number | undefined;
  try {
    const lines = readFileSync(LOG, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.log_type === 'request') mcpMs = last.mcp_ms;
  } catch { /* ignore */ }
  let data: unknown; let ok = code === 0;
  try { data = JSON.parse(out); } catch { ok = false; }
  return {
    sample: { mode, order: arg3, scenario: s.name, path: 'cli', iter, wallMs, mcpMs, bytes: Buffer.byteLength(out), rows: rowsOf(data), ok, error: ok ? undefined : err.trim().slice(0, 200), ts: new Date().toISOString(), jwtMiss },
    data,
  };
}

async function runDirectProc(s: Scenario, iter: number): Promise<{ sample: Sample; data: unknown }> {
  const t0 = performance.now();
  const proc = Bun.spawn({
    cmd: ['bun', 'run', join(HERE, 'direct-one.ts')], stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BENCH_PG: pg, BENCH_JWT: jwt, BENCH_METHOD: s.method, BENCH_PATH: s.path, BENCH_BODY: s.body ?? '', BENCH_ACCEPT: s.accept ?? '' },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const wallMs = performance.now() - t0;
  let innerMs: number | undefined; let data: unknown; let bytes: number | undefined; let ok = code === 0;
  try { const r = JSON.parse(out); innerMs = r.ms; bytes = r.bytes; data = r.data; ok = ok && r.status < 300; } catch { ok = false; }
  return {
    sample: { mode, order: arg3, scenario: s.name, path: 'direct-proc', iter, wallMs, innerMs, bytes, rows: rowsOf(data), ok, error: ok ? undefined : err.trim().slice(0, 200), ts: new Date().toISOString() },
    data,
  };
}

async function runDirectKeep(s: Scenario, iter: number): Promise<{ sample: Sample; data: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', prefer: 'return=representation' };
  if (s.accept) headers.accept = s.accept;
  const t0 = performance.now();
  let data: unknown; let bytes = 0; let ok = true; let error: string | undefined;
  try {
    const r = await fetch(`${pg}${s.path}`, { method: s.method, headers, body: s.body });
    const text = await r.text();
    bytes = Buffer.byteLength(text);
    ok = r.ok;
    if (!ok) error = text.slice(0, 200);
    data = JSON.parse(text);
  } catch (e) { ok = false; error = (e as Error).message; }
  const wallMs = performance.now() - t0;
  return { sample: { mode, order: arg3, scenario: s.name, path: 'direct-keep', iter, wallMs, bytes, rows: rowsOf(data), ok, error, ts: new Date().toISOString() }, data };
}

const runners = { cli: runCli, 'direct-proc': runDirectProc, 'direct-keep': runDirectKeep } as const;
type PathName = keyof typeof runners;

function record(sample: Sample) { appendFileSync(RESULTS, `${JSON.stringify(sample)}\n`); }
function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------- main
if (existsSync(LOG)) unlinkSync(LOG);
console.log(`mode=${mode}${arg3 ? ` order=${arg3}` : ''} iterations=${iterations} org=${ORG}`);
console.log(`postgrest=${pg}`);
console.log(`row counts: ${JSON.stringify(counts)}`);

const mismatches: string[] = [];

if (mode === 'warm') {
  for (let i = 0; i < iterations; i++) {
    for (const kind of ['startup', 'local'] as const) {
      const sample = await runCliBaseline(kind);
      sample.iter = i;
      record(sample);
      process.stdout.write(`${sample.scenario.padEnd(9)} ${'cli'.padEnd(12)} #${i} ${sample.wallMs.toFixed(0).padStart(6)} ms${sample.ok ? '' : ' FAIL'}\n`);
    }
  }
  // Interleave paths per iteration so drift affects all paths equally.
  for (let i = 0; i < iterations; i++) {
    for (const s of scenarios) {
      const results: Partial<Record<PathName, unknown>> = {};
      for (const p of ['cli', 'direct-proc', 'direct-keep'] as PathName[]) {
        const { sample, data } = await runners[p](s, i);
        record(sample);
        results[p] = data;
        process.stdout.write(`${s.name.padEnd(9)} ${p.padEnd(12)} #${i} ${sample.wallMs.toFixed(0).padStart(6)} ms${sample.mcpMs !== undefined ? ` (mcp ${sample.mcpMs} ms)` : ''}${sample.innerMs !== undefined ? ` (fetch ${sample.innerMs.toFixed(0)} ms)` : ''} rows=${sample.rows ?? '-'} bytes=${sample.bytes ?? '-'}${sample.jwtMiss ? ' JWT-FETCH' : ''}${sample.ok ? '' : ` FAIL ${sample.error}`}\n`);
      }
      if (i === 0) {
        const n = s.norm ?? ((x) => x);
        const a = n(results.cli), b = n(results['direct-keep']), c = n(results['direct-proc']);
        if (!deepEqual(a, b) || !deepEqual(a, c)) mismatches.push(s.name);
        console.log(`  data match cli==direct: ${deepEqual(a, b) && deepEqual(a, c)}`);
      }
    }
  }
} else {
  // Cold: exactly one call per scenario per path, in the requested order, no warm-up.
  const order: PathName[] = arg3 === 'direct-first' ? ['direct-proc', 'cli'] : ['cli', 'direct-proc'];
  for (const s of scenarios) {
    for (const p of order) {
      const { sample } = await runners[p](s, 0);
      record(sample);
      console.log(`${s.name.padEnd(9)} ${p.padEnd(12)} ${sample.wallMs.toFixed(0).padStart(6)} ms${sample.mcpMs !== undefined ? ` (mcp ${sample.mcpMs} ms)` : ''}${sample.innerMs !== undefined ? ` (fetch ${sample.innerMs.toFixed(0)} ms)` : ''} rows=${sample.rows ?? '-'}${sample.jwtMiss ? ' JWT-FETCH' : ''}${sample.ok ? '' : ` FAIL ${sample.error}`}`);
    }
  }
}
if (mismatches.length) console.log(`DATA MISMATCH in: ${mismatches.join(', ')}`);
console.log('done');
