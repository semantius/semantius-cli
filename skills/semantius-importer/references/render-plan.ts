/**
 * Deterministic mapping-table and plan rendering for the semantius-importer
 * skill. Reads `./mapping.json` (schema-mapping.md section 8) and prints, as
 * markdown on stdout:
 *
 *   1. the Stage 2 mapping table (one row per CSV column), and
 *   2. a facts block with every count the pre-write plan and the final
 *      report need (columns, skips, fields to create, batches, ...).
 *
 * The artifact is the single source of truth: the skill pastes this output
 * instead of restating numbers in prose, so the rendered table, the plan,
 * and what actually executes can never disagree.
 *
 * Run from the session cwd by path (offline, no CLI calls — but the same
 * invocation shape as its siblings, which do spawn `semantius`; preflight
 * check 1 says never `cd` into the run folder):
 *   bun run .tmp_import/run-<ts>/render-plan.ts
 */
import { readFileSync } from "node:fs";

type ColumnSpec = {
  header: string;
  field_name: string | null;
  format?: string;
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

type Mapping = {
  table: string;
  id_column?: string;
  natural_key?: string | null;
  on_exists?: string; // legacy (postponed update mode); warned on below
  expected_records?: number | null;
  batch_size?: number;
  columns: ColumnSpec[];
};

const M: Mapping = JSON.parse(
  readFileSync(new URL("./mapping.json", import.meta.url), "utf8"),
);

function extras(c: ColumnSpec): string {
  const parts: string[] = [];
  if (typeof c.precision === "number" && c.format === "number") parts.push(`precision ${c.precision}`);
  if (c.enum_values) {
    const list = c.enum_values.join(", ");
    parts.push(`enum: ${list.length > 60 ? `${c.enum_values.length} values` : list}`);
  }
  if (c.bool_pair) parts.push(`pair ${c.bool_pair.true}/${c.bool_pair.false}`);
  if (c.input_type && c.input_type !== "default") parts.push(c.input_type);
  if (c.reference_table) parts.push(`→ ${c.reference_table} (${c.reference_delete_mode ?? "restrict"})`);
  if (c.unique_value) parts.push("unique");
  if (c.searchable) parts.push("searchable");
  if (c.default_value !== undefined) parts.push(`default ${JSON.stringify(c.default_value)}`);
  return parts.join(", ");
}

const lines: string[] = [];
lines.push(`| # | CSV header | field | format | extras | empty cell | disposition | notes |`);
lines.push(`|---|---|---|---|---|---|---|---|`);
M.columns.forEach((c, i) => {
  const skip = c.disposition === "skip";
  lines.push(
    `| ${i + 1} | ${c.header} | ${c.field_name ?? ""} | ${skip ? "" : (c.format ?? "")} | ${skip ? "" : extras(c)} | ${skip ? "" : JSON.stringify(c.empty_value ?? null)} | ${c.disposition ?? ""} | ${c.reason ?? ""} |`,
  );
});
console.log(lines.join("\n"));

const total = M.columns.length;
const byDisposition = (d: string) => M.columns.filter((c) => c.disposition === d);
const skipped = byDisposition("skip");
const creates = byDisposition("create");
const exists = byDisposition("exists");
const label = byDisposition("label");
const imported = total - skipped.length;
const batchSize = M.batch_size ?? 250;
const expected = M.expected_records ?? null;

console.log(`\n**Facts (from mapping.json - the numbers the plan and report must use):**\n`);
console.log(`- table: \`${M.table}\` (primary key column: \`${M.id_column ?? "id"}\`)`);
console.log(`- columns in file: ${total} = ${imported} imported + ${skipped.length} skipped${skipped.length ? ` (${skipped.map((c) => c.header).join(", ")})` : ""}`);
console.log(`- fields to create: ${creates.length}${creates.length ? ` (${creates.map((c) => c.field_name).join(", ")})` : ""}`);
console.log(`- existing live fields targeted: ${exists.length}`);
console.log(`- label column: ${label.length ? `\`${label[0]!.field_name}\` (auto-created by the platform, imported, never create_field)` : "none declared"}`);
console.log(`- unique key: ${M.natural_key ? `\`${M.natural_key}\` (marked unique; re-runs skip rows whose value already exists, existing rows are never modified)` : "none (plain insert; re-running duplicates rows)"}`);
console.log(`- expected records: ${expected ?? "unknown (capped scan)"}${expected ? `, up to ${Math.ceil(expected / batchSize)} batch(es) of ${batchSize}` : ""}`);

// Sanity warnings - never fatal, always visible.
const nonSkipNames = M.columns.filter((c) => c.disposition !== "skip").map((c) => c.field_name);
if (M.natural_key && !nonSkipNames.includes(M.natural_key)) {
  console.log(`\n⚠ natural_key "${M.natural_key}" is not among the imported field names`);
}
if (M.natural_key) {
  const keyCol = M.columns.find((c) => c.field_name === M.natural_key && c.disposition !== "skip");
  if (keyCol && keyCol.disposition === "create" && !keyCol.unique_value) {
    console.log(`\n⚠ natural_key "${M.natural_key}" is a new field but does not carry unique_value: true - the "mark unique" answer was not recorded on the column`);
  }
}
if (M.on_exists !== undefined && M.on_exists !== "insert") {
  console.log(`\n⚠ on_exists "${M.on_exists}" is not supported: the import is insert-only (updating existing records is postponed); import.ts will refuse to run - remove the key`);
}
const dupes = nonSkipNames.filter((n, i) => n && nonSkipNames.indexOf(n) !== i);
if (dupes.length) console.log(`\n⚠ duplicate field names in mapping: ${[...new Set(dupes)].join(", ")}`);
const badOrder = creates.filter((c) => typeof c.field_order !== "number" || c.field_order % 10 !== 0 || c.field_order < 30);
if (badOrder.length) console.log(`\n⚠ field_order should start at 30 in increments of 10 (10 and 20 are used by auto-created fields); check: ${badOrder.map((c) => c.field_name).join(", ")}`);
if (label.length > 1) console.log(`\n⚠ more than one column has disposition "label": ${label.map((c) => c.field_name).join(", ")}`);
