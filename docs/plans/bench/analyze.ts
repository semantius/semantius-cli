// Aggregates results.jsonl into markdown tables.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Sample {
  mode: string; order?: string; scenario: string; path: string; iter: number;
  wallMs: number; innerMs?: number; mcpMs?: number; bytes?: number; rows?: number; ok: boolean; error?: string; ts: string; jwtMiss?: boolean;
}
const rows: Sample[] = readFileSync(join(import.meta.dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const med = (xs: number[]) => q(xs, 0.5);
const fmt = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? '-' : Math.round(n).toString());
const SCEN = ['cli-startup', 'cli-local', 'user', 'single', 'page100', 'page1000', 'full'];
const PATHS = ['cli', 'direct-proc', 'direct-keep'];

const warm = rows.filter((r) => r.mode === 'warm');
const out: string[] = [];

out.push('### Warm (interleaved, n per cell in the table)');
out.push('');
out.push('| Scenario | Path | n | min ms | median ms | p90 ms | max ms | median mcp/fetch ms | bytes | rows | fails |');
out.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const s of SCEN) for (const p of PATHS) {
  const xs = warm.filter((r) => r.scenario === s && r.path === p);
  if (!xs.length) continue;
  const w = xs.map((r) => r.wallMs);
  const inner = xs.map((r) => r.mcpMs ?? r.innerMs).filter((x): x is number => typeof x === 'number');
  out.push(`| ${s} | ${p} | ${xs.length} | ${fmt(Math.min(...w))} | ${fmt(med(w))} | ${fmt(q(w, 0.9))} | ${fmt(Math.max(...w))} | ${inner.length ? fmt(med(inner)) : '-'} | ${xs[0].bytes ?? '-'} | ${xs[0].rows ?? '-'} | ${xs.filter((r) => !r.ok).length}${xs.some((r) => r.jwtMiss) ? ' (jwt fetch seen)' : ''} |`);
}
out.push('');

// Decomposition of the CLI path (medians)
const m = (s: string, p: string, k: 'wallMs' | 'mcpMs' | 'innerMs' = 'wallMs') => med(warm.filter((r) => r.scenario === s && r.path === p && typeof r[k] === 'number').map((r) => r[k] as number));
const startup = m('cli-startup', 'cli');
const local = m('cli-local', 'cli');
out.push('### CLI time decomposition (warm medians)');
out.push('');
out.push(`- process start alone (\`--version\`): ${fmt(startup)} ms`);
out.push(`- process + in-process MCP server, no network (\`utils/get_csvschema\`): ${fmt(local)} ms`);
out.push('');
out.push('| Scenario | CLI wall | of which tools/call (mcp_ms) | remainder = start + config + JWT cache + MCP connect handshake | direct-proc wall | direct-proc fetch only | direct-keep | CLI wall ÷ direct-proc |');
out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const s of SCEN.slice(2)) {
  const wall = m(s, 'cli'), mcp = m(s, 'cli', 'mcpMs'), dp = m(s, 'direct-proc'), dpf = m(s, 'direct-proc', 'innerMs'), dk = m(s, 'direct-keep');
  if (Number.isNaN(wall)) continue;
  out.push(`| ${s} | ${fmt(wall)} | ${fmt(mcp)} | ${fmt(wall - mcp)} | ${fmt(dp)} | ${fmt(dpf)} | ${fmt(dk)} | ${(wall / dp).toFixed(1)}x |`);
}
out.push('');

for (const order of ['cli-first', 'direct-first']) {
  const cold = rows.filter((r) => r.mode === 'cold' && r.order === order);
  if (!cold.length) continue;
  out.push(`### Cold pass (${order}) — one call per cell, after 20 min idle; first row of each scenario is the cold one`);
  out.push('');
  out.push('| Scenario | Path | wall ms | mcp/fetch ms | rows | note |');
  out.push('|---|---|---:|---:|---:|---|');
  for (const r of cold) out.push(`| ${r.scenario} | ${r.path} | ${fmt(r.wallMs)} | ${fmt(r.mcpMs ?? r.innerMs)} | ${r.rows ?? '-'} | ${[r.jwtMiss ? 'CLI fetched a new JWT inside the call' : '', r.ok ? '' : `FAIL ${r.error}`].filter(Boolean).join('; ')} |`);
  out.push('');
}
console.log(out.join('\n'));
