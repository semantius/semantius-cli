/**
 * Batched CSV import into a Semantius table.
 *
 * Shipped with the semantius-importer skill as `references/import.template.ts`
 * and copied VERBATIM into the run folder as `import.ts` — never retyped,
 * never edited per run. All run configuration comes from `./mapping.json`
 * (schema-mapping.md section 8) next to this script.
 *
 * INSERT-ONLY: existing rows are never modified (updating existing records
 * from a re-import is postponed, see README -> Postponed). Safe to re-run
 * only with `natural_key` set in mapping.json (the field marked unique):
 * rows whose key already exists are skipped. Otherwise re-running duplicates rows.
 *
 * Run FROM THE SESSION CWD (repo root), by path — never `cd` into the run folder:
 *   bun run .tmp_import/run-<ts>/import.ts <absolute-path-to-csv>
 * Every batch spawns `semantius call`, and the CLI reads its `.env` from the
 * spawning shell's cwd (preflight check 1). Nothing here needs the run folder
 * as cwd: mapping.json and the two output files resolve via import.meta.url,
 * csv-parse via Bun's upward node_modules lookup from this file.
 */
import { parse } from "csv-parse";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";

const CSV_PATH = process.argv[2];
if (!CSV_PATH) { console.error("usage: bun run import.ts <csv-path>"); process.exit(1); }

// ---------------------------------------------------------------- CONFIG --
// Single source: ./mapping.json (the approved mapping artifact). This script
// carries no generation-time placeholders.

type ColumnSpec = {
  header: string;                       // raw CSV header (row key)
  field_name: string;                   // Semantius field name (payload key)
  // Open set - e.g. "string", "multiline", "integer", "number", "date",
  // "date-time", "boolean", "enum", "reference", "email", "url". Formats the
  // coercion switch does not know pass through verbatim.
  format: string;
  empty_value: string | number | boolean | null;
  bool_pair?: { true: string; false: string };
  // Carried for field creation (create-fields.ts) and plan rendering
  // (render-plan.ts); the import itself only reads `disposition` to drop
  // skipped columns and ignores the rest.
  disposition?: "create" | "exists" | "label" | "skip";
  reason?: string;
  title?: string;
  precision?: number;
  enum_values?: string[];
  input_type?: string;
  field_order?: number;
  reference_table?: string;
  reference_delete_mode?: string;
};

type Mapping = {
  table: string;
  id_column?: string;
  natural_key?: string | null;
  // Legacy key from the (postponed) update mode. Anything but "insert" is rejected.
  on_exists?: string;
  expected_records?: number | null;
  batch_size?: number;
  columns: ColumnSpec[];
};

const M: Mapping = JSON.parse(
  readFileSync(new URL("./mapping.json", import.meta.url), "utf8"),
);

const TABLE = M.table;
const BATCH_SIZE = M.batch_size ?? 250;
// The field the user chose to mark unique (unique_value: true), or null
// (plain insert; re-running duplicates rows). Rows whose key value already
// exists in the table are SKIPPED - never updated (update mode is postponed).
const NATURAL_KEY: string | null = M.natural_key ?? null;
if (M.on_exists !== undefined && M.on_exists !== "insert") {
  console.error(`mapping.json: on_exists "${M.on_exists}" is not supported - this import is insert-only (updating existing records is postponed). Remove the key.`);
  process.exit(4);
}
// The entity's primary key column, copied into mapping.json from the LIVE
// entity's id_column property (read_entity; default "id", but customizable
// per entity - never assume the literal "id" for existing targets). Stripped
// from every payload (hard guard, design rule 2) while id preservation is deferred.
const ID_COLUMN = M.id_column ?? "id";
// record_count from the introspection wrapper; null when the scan was capped.
const EXPECTED_RECORDS: number | null = M.expected_records ?? null;
const MAPPING: ColumnSpec[] = M.columns.filter((c) => c.disposition !== "skip");

// ------------------------------------------------------------- transport --
// The child inherits process.cwd(); the CLI reads `.env` from there. Printed on
// exit 5 so a run started from inside the run folder names its likely cause.
const AUTH_HINT = `hint: semantius reads .env from the current working directory (${process.cwd()}); run this script from the session cwd by path (bun run .tmp_import/run-<ts>/import.ts ...), never from inside the run folder.`;

async function pgRequest(payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["semantius", "call", "crud", "postgrestRequest"], {
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

async function postBatch(rows: Record<string, unknown>[], attempt = 1): Promise<{ ok: boolean; error?: string }> {
  // No prefer key: the server strips it and always answers with the representation envelope.
  const res = await pgRequest({ method: "POST", path: `/${TABLE}`, body: rows });
  if (res.code === 0) return { ok: true };
  if (res.code === 5) { console.error(`auth failure, aborting:\n${res.stderr}\n${AUTH_HINT}`); process.exit(5); }
  if (res.code === 3 && attempt <= 3) {
    const delay = 1000 * 3 ** (attempt - 1);
    console.error(`  transient failure, retry ${attempt}/3 in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    return postBatch(rows, attempt + 1);
  }
  return { ok: false, error: res.stderr || res.stdout };
}

async function serverCount(): Promise<number> {
  const res = await pgRequest({ method: "GET", path: `/${TABLE}?select=count` });
  if (res.code !== 0) { console.error(`count read failed:\n${res.stderr}`); process.exit(1); }
  return JSON.parse(res.stdout)[0].count;
}

// -------------------------------------------------------------- coercion --
function coerce(spec: ColumnSpec, raw: string | undefined): { ok: boolean; value?: unknown; reason?: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { ok: true, value: spec.empty_value };
  switch (spec.format) {
    case "integer": {
      if (!/^[+-]?\d+$/.test(v)) return { ok: false, reason: `not an integer: "${v}"` };
      return { ok: true, value: Number.parseInt(v, 10) };
    }
    case "number": {
      const n = Number.parseFloat(v);
      if (Number.isNaN(n)) return { ok: false, reason: `not a number: "${v}"` };
      return { ok: true, value: n };
    }
    case "boolean": {
      const p = spec.bool_pair;
      if (p) {
        if (v.toLowerCase() === p.true.toLowerCase()) return { ok: true, value: true };
        if (v.toLowerCase() === p.false.toLowerCase()) return { ok: true, value: false };
      }
      return { ok: false, reason: `unknown boolean token: "${v}"` };
    }
    case "date":
    case "date-time": {
      if (Number.isNaN(Date.parse(v))) return { ok: false, reason: `invalid date: "${v}"` };
      return { ok: true, value: v };
    }
    default:
      return { ok: true, value: v }; // string / multiline / enum / reference / email / url pass through
  }
}

// ------------------------------------------------------------------ main --
const failed: { batchIndex: number; rowRange?: string; row?: unknown; error: string }[] = [];
let parsed = 0, inserted = 0, skipped = 0, rowFailed = 0;

// Key values already present in the table; rows carrying one of them are skipped.
const liveKeys = new Set<string>();
if (NATURAL_KEY) {
  let offset = 0;
  for (;;) {
    const res = await pgRequest({ method: "GET", path: `/${TABLE}?select=${NATURAL_KEY}&order=${NATURAL_KEY}&limit=1000&offset=${offset}` });
    if (res.code !== 0) { console.error(`unique-key preload failed:\n${res.stderr}`); process.exit(1); }
    const page = JSON.parse(res.stdout) as Record<string, unknown>[];
    for (const r of page) liveKeys.add(String(r[NATURAL_KEY]));
    if (page.length < 1000) break;
    offset += 1000;
  }
  console.error(`unique key "${NATURAL_KEY}": ${liveKeys.size} existing values loaded (rows with these values will be skipped)`);
} else {
  console.error(`no unique key set: plain insert (re-running this import duplicates rows)`);
}
const preexisting = await serverCount();

const parser = createReadStream(CSV_PATH).pipe(
  parse({ columns: true, bom: true, skip_empty_lines: true }),
);

let batch: Record<string, unknown>[] = [];
let batchIndex = 0;

async function flush() {
  if (batch.length === 0) return;
  batchIndex += 1;
  const rows = batch;
  batch = [];
  const res = await postBatch(rows);
  if (res.ok) {
    inserted += rows.length;
    console.error(`batch ${batchIndex} ok - ${inserted}/${parsed} rows inserted`);
  } else {
    rowFailed += rows.length;
    failed.push({ batchIndex, rowRange: `${parsed - rows.length + 1}-${parsed}`, error: res.error!, row: rows });
    console.error(`batch ${batchIndex} FAILED (${rows.length} rows captured): ${res.error!.slice(0, 200)}`);
  }
}

const seenInFile = new Set<string>();

for await (const record of parser) {
  parsed += 1;
  const out: Record<string, unknown> = {};
  let bad: string | null = null;
  for (const spec of MAPPING) {
    const c = coerce(spec, record[spec.header]);
    if (!c.ok) { bad = `${spec.field_name}: ${c.reason}`; break; }
    out[spec.field_name] = c.value;
  }
  if (bad) {
    rowFailed += 1;
    failed.push({ batchIndex: -1, row: record, error: bad });
    continue;
  }
  // Hard guard (design rule 2): the primary key never travels while id
  // preservation is deferred - silently dropped, whatever the mapping says.
  delete out[ID_COLUMN];
  if (NATURAL_KEY) {
    const key = String(out[NATURAL_KEY]);
    if (seenInFile.has(key)) {
      rowFailed += 1;
      failed.push({ batchIndex: -1, row: record, error: `${NATURAL_KEY}: duplicate key in file: "${key}"` });
      continue;
    }
    seenInFile.add(key);
    // Insert-only: an existing key is skipped, never updated.
    if (liveKeys.has(key)) { skipped += 1; continue; }
  }
  batch.push(out);
  if (batch.length >= BATCH_SIZE) await flush();
}
await flush();

// ---------------------------------------------------------------- verify --
const finalCount = await serverCount();
const expected = preexisting + inserted;
const summary = {
  table: TABLE, parsed, inserted, skipped, failed: rowFailed,
  preexisting, finalCount, countMatches: finalCount === expected,
  expectedRecords: EXPECTED_RECORDS,
  recordCountMatches: EXPECTED_RECORDS === null || parsed === EXPECTED_RECORDS,
};
writeFileSync(new URL("./import-summary.json", import.meta.url), JSON.stringify(summary, null, 2));
if (failed.length > 0) writeFileSync(new URL("./failed-batches.json", import.meta.url), JSON.stringify(failed, null, 2));
console.log(JSON.stringify(summary));
if (!summary.recordCountMatches) console.error(`RECORD COUNT MISMATCH: introspection saw ${EXPECTED_RECORDS} records, parser saw ${parsed} - investigate delimiters/embedded newlines`);
if (!summary.countMatches) { console.error(`COUNT MISMATCH: expected ${expected}, server has ${finalCount}`); process.exit(1); }
if (failed.length > 0) process.exit(1);
