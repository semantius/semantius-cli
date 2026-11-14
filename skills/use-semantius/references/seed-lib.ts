#!/usr/bin/env bun
/**
 * seed-lib.ts — what stands before and after the import of a sample-data file (`references/seed-data.md`).
 *
 * Sample data is one records file, checked and written by the CLI's import:
 *   semantius call utils/import_entities '{"path":".tmp_deploy/seed_<slug>.json","check":true}'   lists every problem, writes nothing
 *   semantius call utils/import_entities '{"path":".tmp_deploy/seed_<slug>.json"}'                writes; a re-run writes only what differs
 *
 * This script:
 *   bun seed-lib.ts --describe <table>[,<table>…]   the file's skeleton and what a record of each table carries
 *   bun seed-lib.ts --emails <file>                 before the import: the file is valid JSON (a mistake is named
 *                                                   with its line, through jq), and every email address is at a
 *                                                   subdomain of example.com, so sample data never reaches a real inbox.
 *                                                   It starts every run of the seed command, so it also counts the runs:
 *                                                   an eleventh run without a finished report prints SEED STOPPED, exit 5
 *   bun seed-lib.ts --report <file>               after the import: the records on the host, the columns the platform
 *                                                   filled, and how parent and child states stand to each other
 *   bun seed-lib.ts --clear <file>                  deletes the file's records again, children first
 *
 * A record of an entity with a TypeID key names itself `<prefix>_sr<n>` (`candidate_sr1`), in its id and in every
 * relationship to it. The import stores `<prefix>_0sr<n>` padded with `x` to 26 characters, and `--report` and
 * `--clear` pad the same way, because the platform refuses a read by the short form.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type Row = Record<string, any>;

// ─────────────────────────────── transport ───────────────────────────────

type Reply = { code: number; out: string; err: string };
type Transport = (argv: string[], stdin: string) => Promise<Reply>;

const spawnTransport: Transport = async (argv, stdin) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};
let transport: Transport = spawnTransport;

/** Tests only: replace the process that talks to the platform (`null` restores it). */
export const setTransport = (t: Transport | null): void => {
  transport = t ?? spawnTransport;
  metaCache.clear();
  moduleLoads.clear();
};

/** One `postgrestRequest` call. Throws on a non-zero exit, with what the platform said. */
export async function pgRequest(method: string, path: string, body?: unknown): Promise<any> {
  const payload: Row = { method, path };
  if (body !== undefined) payload.body = body;
  const { code, out, err } = await transport(["semantius", "call", "crud", "postgrestRequest"], JSON.stringify(payload));
  if (code !== 0) throw new Error(`${method} ${path} failed (exit ${code}): ${(err || out).trim()}`);
  return out.trim() ? JSON.parse(out) : null;
}

const chunk = <T>(rows: ReadonlyArray<T>, size = 100): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

/** PostgREST `in.()` value quoting: plain when safe, else double-quoted with `\` and `"` escaped. */
const PG_PLAIN = /^[A-Za-z0-9_$.\-:@]+$/;
export const pgQuote = (v: string | number): string => {
  const s = String(v);
  return PG_PLAIN.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/** `col=in.(v1,v2,…)`, each value quoted and percent-encoded. */
export function inFilter(column: string, values: ReadonlyArray<string | number>): string {
  if (!values.length) throw new Error(`inFilter ${column}: empty value list`);
  return `${column}=in.(${values.map((v) => encodeURIComponent(pgQuote(v))).join(",")})`;
}

// ─────────────────────────────── reading the file ───────────────────────────────

/** What a JSON lint says about a file: nothing when it reads it, else its message, which names a line and column. */
type Lint = (path: string) => { found: boolean; message: string };

/** `jq empty <file>`: the parser of the runtime says a file is not JSON, `jq` says where (preflight installs it). */
const jqLint: Lint = (path) => {
  try {
    const p = Bun.spawnSync(["jq", "empty", path], { stdout: "pipe", stderr: "pipe" });
    return { found: true, message: p.exitCode === 0 ? "" : p.stderr.toString().trim() };
  } catch {
    return { found: false, message: "" };
  }
};
let lint: Lint = jqLint;

/** Tests only: replace the lint (`null` restores `jq`). */
export const setLint = (l: Lint | null): void => { lint = l ?? jqLint; };

/** The offset right after the first JSON object or array of `text`, or -1 when it never closes. */
function endOfFirstValue(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth <= 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The parsed records file. A file that is not JSON is refused with the place of the mistake: the line and column
 * `jq` names, with that line and the one before it, where a missing comma or bracket usually is.
 */
function readJsonFile(path: string): any {
  let text: string;
  try { text = readFileSync(path, "utf8").replace(/^﻿/, ""); }
  catch (e) { throw new Error(`${path} cannot be read: ${e instanceof Error ? e.message : e}`); }
  try { return JSON.parse(text); }
  catch (e) {
    const lines = text.split(/\r?\n/);
    const around = (line: number): string =>
      [line - 1, line].filter((n) => n >= 1 && n <= lines.length).map((n) => `  ${String(n).padStart(4)} | ${lines[n - 1].slice(0, 200)}`).join("\n");
    const { found, message } = lint(path);
    const at = /line (\d+), column (\d+)/.exec(message);
    let where: string;
    if (at) {
      where = `${message.replace(/^jq: /, "").replace(/^(error: |parse error: )/, "")}\n${around(Number(at[1]))}`;
    } else {
      // jq reads several JSON values one after another, so it accepts a document with something after its end
      const end = endOfFirstValue(text);
      const after = end < 0 ? -1 : text.slice(end).search(/\S/);
      if (after >= 0) {
        const line = text.slice(0, end + after).split("\n").length;
        where = `the document is closed before line ${line}, column ${end + after - text.lastIndexOf("\n", end + after - 1)}, and something follows it; a records file is one object, closed once\n${around(line)}`;
      } else {
        where = `${e instanceof Error ? e.message : e}${found ? "" : "; jq was not found to say where (preflight.md → check 2)"}`;
      }
    }
    throw new Error(
      `${path} is not valid JSON: ${where}\n` +
      "Fix that place with your file-edit tool, then run the command again. The usual causes: a closing bracket or brace too many or too few, " +
      'a missing comma between two records, a comma after the last record, a double quote inside a text that is not written \\".',
    );
  }
}

// ─────────────────────────────── sample ids ───────────────────────────────

const TYPEID_KEYS = new Set(["typeid", "is_a", "has_a"]);
const SAMPLE_ID = /^([a-z](?:[a-z_]{0,61}[a-z])?)_sr([0-9]{1,23})$/;

/** A sample id (`candidate_sr1`) as the import stores it (`candidate_0sr1xxxxxxxxxxxxxxxxxxxxxx`); anything else unchanged. */
export function padSampleId(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const m = SAMPLE_ID.exec(value);
  if (!m) return value;
  const body = `0sr${m[2]}`;
  return `${m[1]}_${body}${"x".repeat(26 - body.length)}`;
}

// ─────────────────────────────── table descriptions ───────────────────────────────

type FieldMeta = {
  field_name: string; format: string; input_type: string; input_type_rule: unknown; enum_values: unknown;
  default_value: unknown; ctype: string; reference_table: string; rollup?: { link_field?: string } | null;
};
type TableMeta = { table: string; entity: Row; fields: Map<string, FieldMeta>; base?: TableMeta };

const ENTITY_COLS = "table_name,module_id,id_type,id_prefix,id_refentity,label_column,computed_fields,select_rule";
const FIELD_COLS = "table_name,field_name,format,input_type,input_type_rule,enum_values,default_value,ctype,reference_table,rollup";
const metaCache = new Map<string, TableMeta>();
/** The module reads in progress, by module id, so two tables of one module asked for together read it once. */
const moduleLoads = new Map<string, Promise<void>>();

/** The entity and fields of `table`, read once with every other entity of its module. */
async function metaOf(table: string): Promise<TableMeta> {
  if (!metaCache.has(table)) await loadModuleOf(table);
  const meta = metaCache.get(table)!;
  // also for a table read alongside another of its module, which the cache then holds without its base
  if (["is_a", "has_a"].includes(String(meta.entity.id_type)) && meta.entity.id_refentity && !meta.base) {
    meta.base = await metaOf(String(meta.entity.id_refentity));
  }
  return meta;
}

async function loadModuleOf(table: string): Promise<void> {
  const [entity] =(await pgRequest("GET", `/entities?select=${ENTITY_COLS}&table_name=eq.${encodeURIComponent(table)}`)) ?? [];
  if (!entity) throw new Error(`${table} is not an entity on this host; check the table name (read_entity lists them)`);
  if (entity.module_id === null || entity.module_id === undefined) return loadEntities(table, entity);
  const key = String(entity.module_id);
  if (!moduleLoads.has(key)) moduleLoads.set(key, loadEntities(table, entity));
  await moduleLoads.get(key);
  if (!metaCache.has(table)) await loadEntities(table, entity);
}

async function loadEntities(table: string, entity: Row): Promise<void> {
  const entities: Row[] = entity.module_id === null || entity.module_id === undefined
    ? [entity]
    : (await pgRequest("GET", `/entities?select=${ENTITY_COLS}&module_id=eq.${encodeURIComponent(String(entity.module_id))}`)) ?? [];
  if (!entities.some((e) => e?.table_name === table)) entities.push(entity);
  const fields: Row[] = [];
  for (const part of chunk(entities.map((e) => String(e.table_name)), 40)) {
    fields.push(...((await pgRequest("GET", `/fields?select=${FIELD_COLS}&${inFilter("table_name", part)}`)) ?? []));
  }
  for (const e of entities) {
    if (metaCache.has(e.table_name)) continue;
    metaCache.set(e.table_name, {
      table: e.table_name, entity: e,
      fields: new Map(fields.filter((f) => f.table_name === e.table_name).map((f) => [String(f.field_name), f as FieldMeta])),
    });
  }
}

const idTypeOf = (m: TableMeta): string => String(m.entity.id_type || "auto_increment");
/** Own fields plus, for an `is_a` / `has_a` entity, the fields of its bases. */
const fieldsOf = (m: TableMeta): Map<string, FieldMeta> => (m.base ? new Map([...fieldsOf(m.base), ...m.fields]) : m.fields);
/** The fields a record of the table writes: an extension (`has_a`) writes its own, its base's belong to the base record. */
const writtenFields = (m: TableMeta): Map<string, FieldMeta> => (idTypeOf(m) === "has_a" ? m.fields : fieldsOf(m));
const rulesOf = (m: TableMeta): Row[] => [
  ...(Array.isArray(m.entity?.computed_fields) ? m.entity.computed_fields : []), ...(m.base ? rulesOf(m.base) : []),
];
const emptyRule = (r: unknown): boolean => !r || (typeof r === "object" && !Array.isArray(r) && Object.keys(r as object).length === 0);

/** A rule that reads its own field keeps what an insert sends there (an approval stamp on a record past its step). */
const keepsSent = (rule: Row, col: string): boolean => {
  const t = JSON.stringify(rule?.jsonlogic ?? null);
  return t.includes(`"var":"${col}"`) || t.includes(`"var":["${col}"`);
};

/** Whether the platform fills `col`, so a record never carries it. A stamp an insert keeps is not one of them. */
function platformFills(m: TableMeta, col: string): boolean {
  const f = fieldsOf(m).get(col);
  if (f && ["audit", "core", "rollup"].includes(f.ctype)) return true;
  const rule = rulesOf(m).find((r) => r?.name === col);
  if (rule) return isRequesterStamp(rule) || !keepsSent(rule, col);
  return f?.ctype === "computed";
}

const MODE_INSERT = JSON.stringify({ "==": [{ var: "$mode" }, "insert"] });

/** The states in which `rule` keeps a stamp an insert sends (`rbac.md` → "Controls on a gate", control 5), or null. */
function keptStates(rule: Row): string[] | null {
  const own = JSON.stringify({ "!=": [{ var: rule?.name }, null] });
  let found: string[] | null = null;
  const walk = (n: any): void => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (Array.isArray(n.and)) {
      const parts = n.and.map((x: any) => JSON.stringify(x));
      const states = n.and.find((x: any) => Array.isArray(x?.in) && JSON.stringify(x.in[0]) === '{"var":"workflow_state"}' && Array.isArray(x.in[1]));
      if (parts.includes(MODE_INSERT) && parts.includes(own) && states) { found = states.in[1].map(String); return; }
    }
    Object.values(n).forEach(walk);
  };
  walk(rule?.jsonlogic);
  return found;
}

/** A rule that stamps the requester: `{"if": [$mode == insert, $user_id, …]}`. */
const isRequesterStamp = (rule: Row): boolean => {
  const j = rule?.jsonlogic;
  return Array.isArray(j?.if) && JSON.stringify(j.if[0]) === MODE_INSERT && JSON.stringify(j.if[1]) === '{"var":"$user_id"}';
};

const enumValues = (f: FieldMeta): string[] =>
  (Array.isArray(f.enum_values) ? f.enum_values : []).map((e: any) => (e && typeof e === "object" ? String(e.value) : String(e)));

const NULLABLE = new Set(["reference", "date", "date-time"]);
const isRelationship = (f: FieldMeta): boolean => (f.format === "reference" || f.format === "parent") && !!f.reference_table;

/** How a record names itself, or a record of `m` is named by another. */
function idExample(m: TableMeta, n = 1): string {
  const type = idTypeOf(m);
  if (type === "has_a" && m.base) return idExample(m.base, n);
  if (type === "typeid" || type === "is_a") return `"${m.entity.id_prefix}_sr${n}"`;
  if (type === "uuid") return "a UUID";
  if (type === "text") return "its text key";
  return String(n);
}

function idLine(m: TableMeta): string {
  const type = idTypeOf(m);
  if (type === "has_a" && m.base) return `the id of the ${m.base.table} record it extends, such as ${idExample(m.base)}; that record is in the file or on the host`;
  if (type === "typeid" || type === "is_a") return `${idExample(m, 1)}, ${idExample(m, 2)}, … (a sample id: the prefix ${m.entity.id_prefix}, "_sr", a number from 1)`;
  if (type === "uuid") return "a UUID on every record";
  if (type === "text") return "a text key on every record";
  if (type === "bigint") return "a whole number on every record";
  return "1, 2, 3, … (a whole number)";
}

/** The parent and child tables among `metas` that both carry `workflow_state`, with the field that relates them. */
function statePairs(metas: ReadonlyArray<TableMeta>): Array<{ parent: TableMeta; child: TableMeta; field: string }> {
  const out: Array<{ parent: TableMeta; child: TableMeta; field: string }> = [];
  const has = (m: TableMeta) => fieldsOf(m).has("workflow_state");
  for (const child of metas) {
    if (!has(child)) continue;
    for (const f of writtenFields(child).values()) {
      if (!isRelationship(f) || f.reference_table === child.table) continue;
      const parent = metas.find((m) => m.table === f.reference_table);
      if (parent && has(parent)) out.push({ parent, child, field: f.field_name });
    }
  }
  return out;
}

/** The file's skeleton and, for each table, what a record carries. */
export async function describeTables(names: ReadonlyArray<string>): Promise<string> {
  const tables = names.map((n) => n.trim().replace(/^\//, "")).filter(Boolean);
  // Each round trip to the host costs seconds: the tables are read together, then the tables they relate to and the users.
  const metas = await Promise.all(tables.map((t) => metaOf(t)));
  const described = metas.flatMap((m) => [...writtenFields(m).values()].filter((f) => f.field_name !== "id" && !(platformFills(m, f.field_name) || ["id", "audit", "core"].includes(f.ctype))));
  const targets = [...new Set(described.filter((f) => isRelationship(f) && f.reference_table !== "users").map((f) => f.reference_table))];
  const usersNamed = described.some((f) => isRelationship(f) && f.reference_table === "users");
  const [, usersRead] = await Promise.all([
    Promise.all(targets.map((t) => metaOf(t))),
    usersNamed ? Promise.all([currentUserId(), pgRequest("GET", "/users?select=id,display_name,external_id&order=id&limit=20")]) : Promise.resolve(undefined),
  ]);
  const out: string[] = [
    "The file, .tmp_deploy/seed_<module_slug>.json (tables in any order; the import writes parents first):",
    '{ "version": 1, "entities": [',
    ...tables.map((t, i) => `  { "entity": { "table_name": "${t}" }, "records": [ … ] }${i < tables.length - 1 ? "," : ""}`),
    "] }",
    "Every record of a table carries the same columns, the id among them. A column the platform fills is never written.",
    "",
  ];
  for (const m of metas) {
    const never: string[] = [];
    const columns: string[] = [];
    const enums: string[] = [];
    for (const f of writtenFields(m).values()) {
      if (f.field_name === "id") continue;
      if (platformFills(m, f.field_name) || ["id", "audit", "core"].includes(f.ctype)) { never.push(f.field_name); continue; }
      const notes: string[] = [f.format];
      if (isRelationship(f)) {
        if (f.reference_table === "users") notes.push('a user: {"external_id": "…"} from the list below');
        else {
          const target = await metaOf(f.reference_table);
          notes.push(`the id of a record of ${f.reference_table}, such as ${idExample(target)}`);
        }
      }
      const required = f.input_type === "required" && emptyRule(f.input_type_rule) && String(f.default_value ?? "") === "";
      if (required) notes.push("required");
      else if (f.input_type === "required" && emptyRule(f.input_type_rule)) notes.push(`default ${JSON.stringify(f.default_value)}`);
      if (!emptyRule(f.input_type_rule)) notes.push("required in some states (input_type_rule)");
      if (f.format === "parent") notes.push("never null");
      else if (NULLABLE.has(f.format) && !required) notes.push("may be null");
      columns.push(`${f.field_name} (${notes.join(", ")})`);
      if (f.format === "enum") enums.push(`${f.field_name}: ${enumValues(f).join(", ")}`);
    }
    out.push(m.table);
    if (idTypeOf(m) === "is_a" && m.base) out.push(`  a kind of ${m.base.table}: its record carries the ${m.base.table} columns too, and is written here only, never under ${m.base.table}`);
    out.push(`  id: ${idLine(m)}`);
    out.push(`  columns: ${columns.join("; ") || "none besides the id"}`);
    if (enums.length) out.push(`  enum values (write the value, never the label): ${enums.join(" | ")}`);
    out.push(`  never write (the platform fills them): ${never.join(", ") || "nothing"}`);
    const rollups = [...fieldsOf(m).values()].filter((f) => f.ctype === "rollup" && typeof f.rollup?.link_field === "string");
    if (rollups.length) {
      const over = [...new Set(rollups.map((f) => String(f.rollup!.link_field).split(".")[0]))];
      out.push(`  rollups: ${rollups.map((f) => f.field_name).join(", ")} over ${over.join(", ")}: give the records different numbers of those, so the totals differ`);
    }
    for (const rule of rulesOf(m)) {
      const states = keptStates(rule);
      if (!states) continue;
      const col = String(rule.name);
      const approver = fieldsOf(m).get(col)?.reference_table === "users" && rulesOf(m).some(isRequesterStamp) ? ", never the user who seeds" : "";
      out.push(`  stamp: write ${col} on records in ${states.join(", ")}${approver}, and null on the others; the user who seeds needs the module's admin role for such records`);
    }
    out.push("");
  }
  const pairs = statePairs(metas);
  if (pairs.length) {
    out.push("Tables whose states must agree (a parent's state and the states of its child records tell one story):");
    for (const p of pairs) out.push(`  ${p.parent.table} and ${p.child.table} (through ${p.child.table}.${p.field})`);
    out.push("");
  }
  if (usersRead) {
    const [me, rows] = usersRead;
    const users: Row[] = rows ?? [];
    out.push("Users a record may name:");
    for (const u of users) {
      if (!u.external_id) continue;
      out.push(`  {"external_id": ${JSON.stringify(u.external_id)}}  ${u.display_name ?? ""}${String(u.id) === me ? "  (the user who seeds: the requester of every record, so never its approver)" : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

async function currentUserId(): Promise<string> {
  const { code, out, err } = await transport(["semantius", "call", "crud", "getCurrentUser"], "{}");
  if (code !== 0) throw new Error(`getCurrentUser failed (exit ${code}): ${err}`);
  return String(JSON.parse(out).user_id ?? "");
}

// ─────────────────────────────── the file ───────────────────────────────

type FileTable = { table: string; records: Row[]; meta: TableMeta; ids: unknown[] };

/** The tables of a records file that carry records, each with its description and its ids as the host stores them. */
async function readSeedFile(path: string): Promise<FileTable[]> {
  const doc = readJsonFile(path);
  if (!Array.isArray(doc?.entities)) throw new Error(`${path} is not a records file: it has no "entities" list (seed-data.md → "The file")`);
  const out: FileTable[] = [];
  for (const entry of doc.entities) {
    const table = entry?.entity?.table_name;
    const records = Array.isArray(entry?.records) ? entry.records : [];
    if (typeof table !== "string" || !records.length) continue;
    const meta = await metaOf(table);
    const padded = TYPEID_KEYS.has(idTypeOf(meta));
    out.push({ table, records, meta, ids: records.map((r: Row) => (padded ? padSampleId(r.id) : r.id)) });
  }
  return out;
}

/** The stored rows of `ids`, by id. */
async function storedRows(table: string, ids: ReadonlyArray<unknown>, select: ReadonlyArray<string>): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  const columns = [...new Set(["id", ...select])].join(",");
  for (const part of chunk(ids.filter((id) => id !== null && id !== undefined) as Array<string | number>)) {
    for (const row of (await pgRequest("GET", `/${table}?select=${columns}&${inFilter("id", part)}`)) ?? []) out.set(String(row.id), row);
  }
  return out;
}

/** The tables of the file with children before their parents (and an extension before its base). */
function childrenFirst(tables: ReadonlyArray<FileTable>): FileTable[] {
  const names = new Set(tables.map((t) => t.table));
  const parentsOf = (t: FileTable): string[] => [
    ...[...writtenFields(t.meta).values()].filter((f) => isRelationship(f) && f.reference_table !== t.table && names.has(f.reference_table)).map((f) => f.reference_table),
    ...(t.meta.base && names.has(t.meta.base.table) ? [t.meta.base.table] : []),
  ];
  const done: FileTable[] = [];
  const left = [...tables];
  while (left.length) {
    // a table no table still left points at has no children left
    const i = left.findIndex((t) => !left.some((o) => o !== t && parentsOf(o).includes(t.table)));
    done.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return done;
}

// ─────────────────────────────── --emails ───────────────────────────────

const ADDRESS = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * Sample data never reaches a real inbox: every email address in the file, in any column, is at a subdomain of
 * example.com (`support@adobe.example.com`), which receives no mail. Throws with every other address. It reads
 * the file only, so it runs before the import and needs no host.
 */
export function checkEmails(path: string): string {
  const doc = readJsonFile(path);
  if (!Array.isArray(doc?.entities)) throw new Error(`${path} is not a records file: it has no "entities" list (seed-data.md → "The file")`);
  const wrong: string[] = [];
  let seen = 0;
  const walk = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(ADDRESS)) {
        seen++;
        if (!m[1].toLowerCase().endsWith(".example.com")) wrong.push(`${where}: ${m[0]}`);
      }
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, Array.isArray(value) ? where : `${where}.${k}`);
    }
  };
  for (const entry of doc.entities) {
    const table = String(entry?.entity?.table_name ?? "?");
    for (const record of Array.isArray(entry?.records) ? entry.records : []) {
      for (const [column, value] of Object.entries(record ?? {})) {
        if (column !== "id") walk(value, `${table}.${column} of ${JSON.stringify(record.id)}`);
      }
    }
  }
  if (wrong.length) {
    throw new Error(
      `${wrong.length} email address(es) could reach a real inbox; nothing was written:\n${wrong.map((w) => `  - ${w}`).join("\n")}\n` +
      "Write each at a subdomain of example.com, named after the company: support@adobe.example.com, ana.silva@globex.example.com. Never at example.com itself.",
    );
  }
  return `Email addresses: ${seen} checked, all at a subdomain of example.com.`;
}

// ─────────────────────────────── --report ───────────────────────────────

/**
 * After the import: what the host holds of the file, what the platform filled in, and how parent and child
 * states stand. It reports and never blocks: a line under "Look at" is for the final response, not a failure.
 */
export async function reportSeed(path: string): Promise<string> {
  const tables = await readSeedFile(path);
  const out: string[] = [];
  const look: string[] = [];
  const rows = new Map<string, Map<string, Row>>();
  let total = 0;
  let notOnHost = 0;

  for (const t of tables) {
    const filled = [...fieldsOf(t.meta).values()].filter((f) => f.field_name !== "id" && !["audit", "core"].includes(f.ctype) && platformFills(t.meta, f.field_name));
    const state = fieldsOf(t.meta).has("workflow_state") ? ["workflow_state"] : [];
    const relationships = [...writtenFields(t.meta).values()].filter((f) => isRelationship(f) && f.reference_table !== "users").map((f) => f.field_name);
    const stored = await storedRows(t.table, t.ids, [...filled.map((f) => f.field_name), ...state, ...relationships]);
    rows.set(t.table, stored);
    total += stored.size;
    const missing = t.ids.filter((id) => !stored.has(String(id)));
    notOnHost += missing.length;
    if (missing.length) {
      out.push(`✗ ${t.table}: ${stored.size} of ${t.ids.length} records are on the host`);
      look.push(`${t.table}: ${missing.length} record(s) of the file are not on the host (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); run the import again`);
    } else out.push(`✓ ${t.table}: ${stored.size} record${stored.size === 1 ? "" : "s"}`);
    for (const f of filled) {
      const values = [...stored.values()].map((r) => JSON.stringify(r[f.field_name]));
      const distinct = new Set(values);
      if (stored.size < 2) { out.push(`    ${f.field_name}: ${values[0] ?? "no record"} (one record, nothing to compare)`); continue; }
      // the user, the day or the time of the import is one value on every record of one import
      const stamp = JSON.stringify(rulesOf(t.meta).find((r) => r?.name === f.field_name)?.jsonlogic ?? null);
      if (distinct.size === 1 && /"var":"\$(user_id|now|today)"/.test(stamp)) {
        out.push(`    ${f.field_name}: ${values[0]} on every record, as one import writes it`);
        continue;
      }
      out.push(`    ${f.field_name}: ${distinct.size} distinct value(s)`);
      if (distinct.size === 1) look.push(`${t.table}.${f.field_name} holds ${values[0]} on every record: ${f.ctype === "rollup" ? "give the records different numbers of child records" : "check the rule that fills it, or the values it reads"}`);
    }
  }

  for (const p of statePairs(tables.map((t) => t.meta))) {
    const parents = rows.get(p.parent.table);
    const children = rows.get(p.child.table);
    if (!parents || !children) continue;
    const byState = new Map<string, Map<string, number>>();
    const withChildren = new Map<string, number>();
    for (const child of children.values()) {
      const parent = parents.get(String(child[p.field]));
      if (!parent) continue;
      const s = String(parent.workflow_state);
      const counts = byState.get(s) ?? new Map<string, number>();
      counts.set(String(child.workflow_state), (counts.get(String(child.workflow_state)) ?? 0) + 1);
      byState.set(s, counts);
      withChildren.set(String(parent.id), 1);
    }
    out.push(`${p.parent.table} and their ${p.child.table}, by state:`);
    const states = [...new Set([...parents.values()].map((r) => String(r.workflow_state)))];
    for (const s of states) {
      const all = [...parents.values()].filter((r) => String(r.workflow_state) === s);
      const without = all.filter((r) => !withChildren.has(String(r.id))).length;
      const counts = [...(byState.get(s) ?? new Map()).entries()].map(([c, n]) => `${c} ×${n}`).join(", ");
      out.push(`    ${s} (${all.length}): ${counts || `no ${p.child.table}`}${counts && without ? `; ${without} without ${p.child.table}` : ""}`);
    }
  }

  out.push("", `Report finished: ${total} record(s) in ${tables.length} table(s) on the host.`);
  if (look.length) out.push("Look at:", ...look.map((l) => `  - ${l}`));
  if (!notOnHost) forgetSeedRuns(path);
  // What comes next is said here, in the output the agent has just read: the one step with no tool call after it.
  out.push(
    "",
    notOnHost
      ? `Not finished: ${notOnHost} record(s) of the file are not on the host. Run the seed command again; send it as your next tool call.`
      : "This was the last step. Your next response is the final response itself: write it now. " +
        "Any other message sent first (that the records are in, that the handover comes next) ends the turn before the user has the result.",
  );
  return out.join("\n");
}

// ─────────────────────────────── --clear ───────────────────────────────

/**
 * Deletes the file's records, children first. A record with a sample id is the file's own. A record with any
 * other key (a junction's number) is deleted only while it still holds the relationships the file gave it: a
 * difference means the record is not the one the file wrote, and that table is left alone.
 */
export async function clearSeed(path: string): Promise<string> {
  const tables = childrenFirst(await readSeedFile(path));
  const out: string[] = [];
  let deleted = 0;
  for (const t of tables) {
    const relationships = [...writtenFields(t.meta).values()].filter((f) => isRelationship(f) && f.reference_table !== "users");
    const stored = await storedRows(t.table, t.ids, relationships.map((f) => f.field_name));
    if (!stored.size) { out.push(`  ${t.table}: nothing to delete`); continue; }
    if (!TYPEID_KEYS.has(idTypeOf(t.meta))) {
      const padFor = new Map<string, boolean>();
      for (const f of relationships) padFor.set(f.field_name, TYPEID_KEYS.has(idTypeOf(await metaOf(f.reference_table))));
      const other = t.records.filter((r, i) => {
        const row = stored.get(String(t.ids[i]));
        return row && relationships.some((f) => f.field_name in r && String(row[f.field_name]) !== String(padFor.get(f.field_name) ? padSampleId(r[f.field_name]) : r[f.field_name]));
      });
      if (other.length) {
        throw new Error(`${t.table}: ${other.length} record(s) with the file's ids (${other.slice(0, 5).map((r) => r.id).join(", ")}) hold other relationships than the file gave them, so they are not the records it wrote. Nothing was deleted from ${t.table} or the tables after it; ${deleted} record(s) were deleted before. Stop and tell the user.`);
      }
    }
    for (const part of chunk([...stored.keys()])) {
      try { await pgRequest("DELETE", `/${t.table}?${inFilter("id", part)}`); }
      catch (e) {
        throw new Error(`${t.table}: the platform refused the delete (${e instanceof Error ? e.message : e}). ${deleted} record(s) were deleted before it; the tables after ${t.table} still hold theirs. Stop and tell the user.`);
      }
      deleted += part.length;
    }
    out.push(`  ${t.table}: ${stored.size} record(s) deleted`);
  }
  out.push("", `Clear finished: ${deleted} record(s) deleted. Nothing was seeded: import the file again to write them.`);
  return out.join("\n");
}

// ─────────────────────────────── runs ───────────────────────────────

/** The seed command runs this many times for one file without a finished report; the next run is refused. */
export const SEED_RUN_LIMIT = 10;
/** Beside the records file, so a run of another file or another build never counts against this one. */
const runsFileOf = (path: string): string => join(dirname(path), "seed-runs.json");

function readRuns(path: string): Record<string, number> {
  try {
    const doc = JSON.parse(readFileSync(runsFileOf(path), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Counts one run of the seed command for `path` (its first step, `--emails`, starts every run). Returns the text that
 * refuses the run once `SEED_RUN_LIMIT` runs have gone by without a finished report, and null otherwise. A seed that loops
 * (fix the file, run again, the same platform refusal) ends here, in code, whatever the agent makes of the last answer.
 */
export function countSeedRun(path: string): string | null {
  const runs = readRuns(path);
  const key = basename(path);
  const done = Number(runs[key]) || 0;
  if (done >= SEED_RUN_LIMIT) {
    return `SEED STOPPED: the seed command has run ${done} times for ${key} without a finished report, so it runs no more. ` +
      `Do not run it again, and write nothing to the tables by hand. Finish the build, and say in the final response which tables hold records and what stopped the rest ` +
      `(build-module.md → "Final response"). Only the user can allow more runs: they delete ${runsFileOf(path)}.`;
  }
  runs[key] = done + 1;
  try { writeFileSync(runsFileOf(path), JSON.stringify(runs, null, 2)); } catch { /* a count that cannot be kept never blocks a seed */ }
  return null;
}

/** A finished report ends the count of `path`: the seed is complete. */
export function forgetSeedRuns(path: string): void {
  const runs = readRuns(path);
  const key = basename(path);
  if (!(key in runs)) return;
  delete runs[key];
  try {
    if (Object.keys(runs).length) writeFileSync(runsFileOf(path), JSON.stringify(runs, null, 2));
    else rmSync(runsFileOf(path), { force: true });
  } catch { /* nothing to keep */ }
}

// ─────────────────────────────── CLI ───────────────────────────────

if (import.meta.main) {
  const arg = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const describe = arg("--describe");
  const emails = arg("--emails");
  const report = arg("--report");
  const clear = arg("--clear");
  try {
    if (describe) console.log(await describeTables(describe.split(",")));
    else if (emails) {
      const stopped = countSeedRun(emails);
      if (stopped) {
        console.log(stopped);
        process.exit(5);
      }
      console.log(checkEmails(emails));
    }
    else if (report) console.log(await reportSeed(report));
    else if (clear) console.log(await clearSeed(clear));
    else {
      console.error("Usage: bun seed-lib.ts --describe <table>[,<table>…] | --emails <file> | --report <file> | --clear <file>");
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
