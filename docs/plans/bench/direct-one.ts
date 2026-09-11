// One direct PostgREST request in a fresh process (fresh TLS). Prints {status, ms, bytes, data}.
const pg = process.env.BENCH_PG!;
const headers: Record<string, string> = {
  authorization: `Bearer ${process.env.BENCH_JWT}`,
  'content-type': 'application/json',
  prefer: 'return=representation',
};
if (process.env.BENCH_ACCEPT) headers.accept = process.env.BENCH_ACCEPT;
const t0 = performance.now();
const r = await fetch(`${pg}${process.env.BENCH_PATH}`, {
  method: process.env.BENCH_METHOD,
  headers,
  body: process.env.BENCH_BODY || undefined,
});
const text = await r.text();
const ms = performance.now() - t0;
let data: unknown = null;
try { data = JSON.parse(text); } catch { data = text; }
console.log(JSON.stringify({ status: r.status, ms, bytes: Buffer.byteLength(text), data }));
