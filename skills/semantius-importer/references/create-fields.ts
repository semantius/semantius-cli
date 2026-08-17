/**
 * Bulk field creation for the semantius-importer skill.
 *
 * Reads `./mapping.json` (schema-mapping.md section 8) and creates every
 * column with disposition "create" through ONE `semantius call crud
 * create_field` per batch of up to BATCH_SIZE (100) fields: `data` is an
 * ARRAY of field objects. The typed tool takes heterogeneous items (one row
 * carries `enum_values`, another `precision`, another `reference_table`;
 * the server sends `?columns=<union>` with `Prefer: missing=default`, so a
 * key omitted from an item takes the column default) and inserts the whole
 * batch in one request and one transaction — all-or-nothing per call.
 * Explicit `field_order` comes from the mapping (increments of 10 - the
 * platform preserves it, so the position inside the array carries no
 * meaning). This replaces the old one-call-per-field runner (pool of 5).
 *
 * - Idempotent: live fields are read first; columns whose field_name already
 *   exists are skipped (safe re-run; read-before-create).
 * - Transient-tolerant: exit 3 (transport failure, CLI retries exhausted) is
 *   retried per batch up to 3 times with 1s/3s/9s backoff - the same policy
 *   as import.template.ts. Before each retry the live fields are RE-READ and
 *   names that already landed are dropped from the batch (a lost response is
 *   the common exit-3 case; a blind resend would 409 on the rows that landed
 *   and fail the whole batch).
 * - Fail-fast on real errors: exit 4 (validation - a bad mapping) and exit 5
 *   (auth) never retry; a failed batch landed NOTHING (one transaction), every
 *   field of it is reported "failed" with the platform's first stderr line,
 *   later batches are "not-run", and the run exits 1 (5 on auth). There is
 *   deliberately no per-field fallback loop: fix the cause and re-run — the
 *   read-before-create skips whatever landed.
 * - Verified: after the batches succeed the live fields are read AGAIN and
 *   every requested name must be present (never trust the create response).
 * - Loud: every field gets a row in the final table - field, status
 *   (ok / failed / skipped-exists / not-run), exit code, first stderr line.
 *   No error is ever swallowed.
 *
 * Run (inside the run folder):
 *   bun run create-fields.ts            # create the fields
 *   bun run create-fields.ts --dry-run  # print the exact bulk payload(s), no writes
 */
import { readFileSync } from "node:fs";

type ColumnSpec = {
  header: string;
  field_name: string;
  format: string;
  empty_value?: string | number | boolean | null;
  bool_pair?: { true: string; false: string };
  disposition?: "create" | "exists" | "label" | "skip";
  reason?: string;
  title?: string;
  precision?: number;
  enum_values?: string[];
  input_type?: string;
  field_order?: number;
  reference_table?: string;
  reference_delete_mode?: string;
  unique_value?: boolean;
  searchable?: boolean;
  default_value?: string;
};

type Mapping = { table: string; columns: ColumnSpec[] };

const DRY_RUN = process.argv.includes("--dry-run");
/** Fields per create_field call. 100 keeps one DDL-heavy transaction bounded; lower it if a call is slow. */
const BATCH_SIZE = 100;

const M: Mapping = JSON.parse(
  readFileSync(new URL("./mapping.json", import.meta.url), "utf8"),
);
const toCreate = M.columns.filter((c) => c.disposition === "create");

if (toCreate.length === 0) {
  console.log(`no columns with disposition "create" in mapping.json - nothing to do`);
  process.exit(0);
}

function titleCase(name: string): string {
  return name.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** One create_field record (the item that goes into the `data` array). */
function rowFor(c: ColumnSpec): Record<string, unknown> {
  const data: Record<string, unknown> = {
    table_name: M.table,
    field_name: c.field_name,
    title: c.title ?? titleCase(c.field_name),
    format: c.format,
    width: "default",
    input_type: c.input_type ?? "default",
  };
  if (typeof c.field_order === "number") data.field_order = c.field_order;
  if (typeof c.precision === "number" && c.format === "number") data.precision = c.precision;
  if (c.enum_values) data.enum_values = c.enum_values;
  if (c.reference_table) {
    data.reference_table = c.reference_table;
    data.reference_delete_mode = c.reference_delete_mode ?? "restrict";
  }
  if (c.unique_value) data.unique_value = true;
  if (c.searchable) data.searchable = true;
  if (c.default_value !== undefined) data.default_value = c.default_value;
  return data;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function call(tool: string, payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

if (DRY_RUN) {
  const batches = chunk(toCreate.map(rowFor), BATCH_SIZE);
  for (const rows of batches) console.log(JSON.stringify({ data: rows }, null, 2));
  console.error(
    `dry run: ${toCreate.length} create_field payload(s) for table "${M.table}" in ${batches.length} bulk call(s) of up to ${BATCH_SIZE}, nothing written`,
  );
  process.exit(0);
}

/** Names of the fields currently live on the entity (exit 5 → exit 5; any other failure → exit 1, refuse to create blind). */
async function liveFieldNames(): Promise<Set<string>> {
  const live = await call("read_field", { filters: `table_name=eq.${M.table}` });
  if (live.code !== 0) {
    console.error(`read_field failed (exit ${live.code}) - refusing to create blind:\n${live.stderr || live.stdout}`);
    process.exit(live.code === 5 ? 5 : 1);
  }
  return new Set((JSON.parse(live.stdout) as { field_name: string }[]).map((f) => f.field_name));
}

// Idempotency: skip field names that already exist on the live entity.
const existing = await liveFieldNames();

type Result = { status: "ok" | "failed" | "skipped-exists" | "not-run"; code?: number; error?: string };
const results = new Map<string, Result>();
const queue: ColumnSpec[] = [];

for (const c of toCreate) {
  if (existing.has(c.field_name)) results.set(c.field_name, { status: "skipped-exists" });
  else queue.push(c);
}

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim()) ?? "";

/**
 * One bulk create_field call for a batch, with the exit-3 retry policy. Returns
 * the final CLI result; `batch` may shrink between attempts when a re-read shows
 * that some (or all) of its fields landed despite the transport failure.
 */
async function createBatch(batch: ColumnSpec[]): Promise<{ code: number; stdout: string; stderr: string; sent: ColumnSpec[] }> {
  let pending = batch;
  let res = await call("create_field", { data: pending.map(rowFor) });
  for (let attempt = 1; res.code === 3 && attempt <= 3; attempt++) {
    const delay = 1000 * 3 ** (attempt - 1);
    console.error(`  transient  batch of ${pending.length} (exit 3), retry ${attempt}/3 in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    const landed = await liveFieldNames();                 // re-read: never resend rows that already landed
    pending = pending.filter((c) => !landed.has(c.field_name));
    if (pending.length === 0) return { code: 0, stdout: "[]", stderr: "", sent: [] };
    res = await call("create_field", { data: pending.map(rowFor) });
  }
  return { ...res, sent: pending };
}

const batches = chunk(queue, BATCH_SIZE);
let authFailure = false;
let stopped = false;

for (const [i, batch] of batches.entries()) {
  if (stopped) { for (const c of batch) results.set(c.field_name, { status: "not-run" }); continue; }
  const res = await createBatch(batch);
  if (res.code === 0) {
    for (const c of batch) results.set(c.field_name, { status: "ok" });
    console.error(`  ok       batch ${i + 1}/${batches.length}: ${batch.length} field(s) in one create_field call`);
  } else {
    const error = firstLine(res.stderr || res.stdout);
    for (const c of batch) results.set(c.field_name, { status: "failed", code: res.code, error });
    console.error(`  FAILED   batch ${i + 1}/${batches.length} (${batch.length} field(s), exit ${res.code}) - nothing from this call landed: ${error}`);
    stopped = true;                                          // fail fast: later batches are not run
    if (res.code === 5) authFailure = true;
  }
}

// Never trust the create response: re-read and assert every "ok" field is live.
if (queue.some((c) => results.get(c.field_name)?.status === "ok")) {
  const after = await liveFieldNames();
  for (const c of queue) {
    if (results.get(c.field_name)?.status === "ok" && !after.has(c.field_name)) {
      results.set(c.field_name, { status: "failed", code: 0, error: "create_field reported success but the field is not live after re-read" });
    }
  }
}

// Compact result table, one row per requested field, in mapping order.
const w = Math.max(...toCreate.map((c) => c.field_name.length), 5);
console.log(`\n${"field".padEnd(w)}  status          exit  error`);
for (const c of toCreate) {
  const r = results.get(c.field_name)!;
  console.log(
    `${c.field_name.padEnd(w)}  ${r.status.padEnd(14)}  ${String(r.code ?? "").padEnd(4)}  ${(r.error ?? "").slice(0, 120)}`,
  );
}

const counts = { ok: 0, "failed": 0, "skipped-exists": 0, "not-run": 0 } as Record<string, number>;
for (const r of results.values()) counts[r.status] += 1;
console.log(`\n${counts.ok} created, ${counts["skipped-exists"]} already existed, ${counts.failed} failed, ${counts["not-run"]} not run (${batches.length} create_field call(s))`);

if (authFailure) process.exit(5);
if (counts.failed > 0 || counts["not-run"] > 0) process.exit(1);
