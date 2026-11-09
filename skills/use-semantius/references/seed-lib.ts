#!/usr/bin/env bun
/**
 * seed-lib.ts — the fixed helpers for a sample-data seed script. Copy it next to the
 * script and import it; never retype it (`references/seed-data.md` shows how).
 *
 * What it enforces:
 *   - Failure is loud: a non-zero exit from `semantius`, a short RETURNING, a row with
 *     different keys than its siblings, a wrong count or a child that names the wrong
 *     parent all THROW, and `runSeed` turns any thrown error into a non-zero exit.
 *   - Ids are never typed and never taken from an insert response by position: a parent
 *     is re-read by its natural key (`idsByKey`) and a child names its parent by label.
 *     `assertParents` then reads every child back with its `<fk>_label` and compares it
 *     with the parent the script meant.
 *   - Numbers fit the rows: `assertItemized` halts before the first write on a stored figure out of scale with
 *     its child rows, and `assertComputedVary` halts on a computed or rollup column with one value on every row.
 *   - One call per table: `postMany` sends a whole table in one `postgrestRequest` POST
 *     (array `body`, at most `BATCH_SIZE` rows per call). A failed call landed nothing.
 *
 * Check run: `bun run <script> --check` (or `SEED_CHECK=1`) runs the whole script with
 * every write recorded but never sent. Reads still go to the live host: before a table's
 * insert, one read with `limit=0` proves the table and every column of the first row
 * exist. The rows a write would have added are returned by later reads that match them
 * (`eq.`, `in.()` and `is.null` filters), so `idsByKey` and the next table behave as on a
 * real run. The platform still validates VALUES (enums, NOT NULL, rules) only on the real
 * run, and relationship labels exist only there, so `assertParents` checks them on the
 * real run.
 *
 *   - Sample email addresses never reach a real inbox: `postMany` refuses any address that is not at a
 *     subdomain of example.com.
 *
 * Not a CLI — import it:
 *   import { postMany, seedEnsureMany, idsByKey, assertParents, assertJunction, assertItemized, assertComputedVary, assertSeedCounts, assertSeedDistinct,
 *            rng, days, uniq, slugify, exampleDomain, patchById, clearSeeded, runSeed } from "./seed-lib";
 */

type Row = Record<string, unknown>;

let writeCount = 0;
let clearStarted = false;   // this script called clearSeeded
let rowsInserted = false;   // this script sent an insert

/** Count of write calls so far (a bulk call counts once). */
export const writes = (): number => writeCount;

/** True with the `--check` argument or `SEED_CHECK=1`: writes are recorded, never sent. */
export const isCheckRun = (): boolean => process.env.SEED_CHECK === "1" || process.argv.slice(2).includes("--check");

/** Prefix for a success line, so a check run never reads like a seeded table. */
const tag = (): string => (isCheckRun() ? "[check run] " : "");

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
export const setTransport = (t: Transport | null): void => { transport = t ?? spawnTransport; };

// ─────────────────────────────── check run ───────────────────────────────

const dryRows = new Map<string, any[]>();   // `pg:/<table>` → rows a check run "inserted"
let dryId = 0;
const dryWarned = new Set<string>();

/** Clears what a check run recorded (tests only). */
export const resetCheckRun = (): void => { dryRows.clear(); dryWarned.clear(); dryId = 0; writeCount = 0; clearStarted = false; rowsInserted = false; };

/** `col=op.value` triples of a PostgREST query string (`select`, `order`, `limit`, `offset` dropped); `null` when a part is not of that form. */
function parseFilters(query: string): Array<[string, string, string]> | null {
  const out: Array<[string, string, string]> = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const col = part.slice(0, eq);
    if (["select", "order", "limit", "offset"].includes(col)) continue;
    const rest = part.slice(eq + 1);
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    out.push([col, rest.slice(0, dot), rest.slice(dot + 1)]);
  }
  return out;
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
const unquote = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);

/** Rows the check run recorded under `key` that match `query`. An unsupported operator matches nothing (warned once). */
function dryMatch(key: string, query: string): any[] {
  const rows = dryRows.get(key) ?? [];
  if (!rows.length) return [];
  const warn = (what: string): any[] => {
    if (!dryWarned.has(what)) { dryWarned.add(what); console.warn(`  [check run] ${what}: rows this check run created are not matched`); }
    return [];
  };
  const triples = parseFilters(query);
  if (!triples) return warn(`unparsed filter "${query}"`);
  const tests: Array<(r: any) => boolean> = [];
  for (const [col, op, raw] of triples) {
    if (op === "eq") { const v = unquote(decode(raw)); tests.push((r) => String(r[col]) === v); }
    else if (op === "in") {
      const set = new Set(raw.replace(/^\(|\)$/g, "").split(",").map((v) => unquote(decode(v))));
      tests.push((r) => set.has(String(r[col])));
    } else if (op === "is" && raw === "null") tests.push((r) => r[col] === null || r[col] === undefined);
    else return warn(`operator ${op}. on ${col}`);
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

// ─────────────────────────────── query helpers ───────────────────────────────

export const BATCH_SIZE = 100;

/** Splits `rows` into groups of at most `size`. */
export function chunk<T>(rows: ReadonlyArray<T>, size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const preview = (keys: ReadonlyArray<string>, n = 20): string =>
  keys.slice(0, n).join(", ") + (keys.length > n ? `, … +${keys.length - n} more` : "");

/** PostgREST `in.()` value quoting: plain when safe, else double-quoted with `\` and `"` escaped. */
const PG_PLAIN = /^[A-Za-z0-9_$.\-:@]+$/;
export const pgQuote = (v: string | number): string => {
  const s = String(v);
  return PG_PLAIN.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/**
 * `col=in.(v1,v2,…)` for a multi-key read. Values are quoted per `pgQuote`, then percent-encoded, so a
 * `&`, `,`, `+`, `#`, `%`, quote or space inside a value ("AT&T", "Salesforce, Inc.") never breaks the
 * query string. Throws on an empty list.
 */
export function inFilter(column: string, values: ReadonlyArray<string | number>): string {
  if (!values.length) throw new Error(`inFilter ${column}: empty value list`);
  return `${column}=in.(${values.map((v) => encodeURIComponent(pgQuote(v))).join(",")})`;
}

const tableOf = (path: string): string => {
  const t = path.split("?")[0];
  return t.startsWith("/") ? t : `/${t}`;
};

/** The natural keys of `rows` as strings; throws on an empty or repeated key. */
function keysOf(who: string, table: string, keyField: string, rows: ReadonlyArray<Row>): string[] {
  const keys = rows.map((r, i) => {
    const k = r[keyField];
    if (k === undefined || k === null || k === "") throw new Error(`${who} ${table}: row ${i} has an empty "${keyField}"`);
    return String(k);
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${who} ${table}: "${keyField}" repeats among the rows; every seeded row needs its own ${keyField}`);
  }
  return keys;
}

// ─────────────────────────────── postgrestRequest ───────────────────────────────

/**
 * Loud `postgrestRequest` call: reads and writes of business records. The payload field is `body`, not
 * `data` (`data` is the typed-tool shape); this helper owns that difference. Throws on any non-zero exit.
 * `single` adds `--single` (one-row body only: the CLI rejects it for an array body, use `postMany`).
 * Returns parsed JSON: an array, or the bare object with `single`.
 */
export async function pgRequest(method: string, path: string, body?: unknown, single = false): Promise<any> {
  if (single && Array.isArray(body)) {
    throw new Error(`pgRequest ${method} ${path}: --single cannot be combined with an array body (SINGLE_ARRAY_INPUT); use postMany() for a bulk insert`);
  }
  const [table, query = ""] = path.split("?");
  const key = `pg:${table}`;
  if (isCheckRun() && method !== "GET") {
    let out: any[] = [];
    if (method === "POST") {
      out = (Array.isArray(body) ? body : [body]).map((r: any) => ({ ...r, id: r?.id ?? -(++dryId) }));
      dryRows.set(key, [...(dryRows.get(key) ?? []), ...out]);
    } else {
      out = dryMatch(key, query);
      if (method === "PATCH") {
        for (const r of out) Object.assign(r, body);
        const id = parseFilters(query)?.find(([c, op]) => c === "id" && op === "eq")?.[2];
        if (!out.length && id !== undefined) out = [{ ...(body as object), id: decode(id) }];   // a live row
      } else dryRows.set(key, (dryRows.get(key) ?? []).filter((r) => !out.includes(r)));
    }
    writeCount++;
    console.log(`  [check run] ${method} ${table}: ${out.length} row(s), not sent`);
    return single ? out[0] ?? null : out;
  }
  const argv = single
    ? ["semantius", "--single", "call", "crud", "postgrestRequest"]
    : ["semantius", "call", "crud", "postgrestRequest"];
  const payload: Row = { method, path };
  if (body !== undefined) payload.body = body;
  const { code, out, err } = await transport(argv, JSON.stringify(payload));
  if (isCheckRun()) {   // a GET: live rows plus the rows this check run inserted
    if (code !== 0) throw new Error(`pgRequest ${method} ${path} failed (exit ${code}): ${err}`);
    const live = out.trim() ? JSON.parse(out) : [];
    return [...(Array.isArray(live) ? live : [live]), ...dryMatch(key, query)];
  }
  if (code !== 0) throw new Error(`pgRequest ${method} ${path} failed (exit ${code}): ${err}`);
  if (method !== "GET") writeCount++;
  return out.trim() ? JSON.parse(out) : null;
}

const EMAIL_IN_TEXT = /[^\s@<>"',;:()[\]]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * Every email address in a seeded row sits at a subdomain of example.com (`exampleDomain("Adobe")` →
 * "adobe.example.com"), whatever company the row names, so a sample address can never reach a real inbox.
 * Throws naming the row, the column and the address. Looks inside every text value, notes included.
 */
export function assertExampleEmails(table: string, rows: ReadonlyArray<Row>): void {
  const bad: string[] = [];
  rows.forEach((row, i) => {
    for (const [col, v] of Object.entries(row)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(EMAIL_IN_TEXT)) {
        if (!m[1].toLowerCase().endsWith(".example.com")) bad.push(`row ${i} ${col}: ${m[0]}`);
      }
    }
  });
  if (bad.length) {
    throw new Error(
      `${table}: ${bad.length} email address(es) not at a subdomain of example.com:\n  - ${bad.join("\n  - ")}\n` +
      `Build each one with exampleDomain(company), e.g. \`support@\${exampleDomain("Adobe")}\` → support@adobe.example.com.`,
    );
  }
}

/**
 * Bulk insert: ONE POST with an array `body` per at most `size` rows. `postgrestRequest` is the raw PostgREST
 * path, so every row MUST carry the same keys: a column you send on one row you send on every row. Only
 * `reference`, `date` and `date-time` accept `null`; every other format is NOT NULL, so an empty one is
 * `""` (text, email, url, ...) or `0` (numbers), required or not. Never leave a key `undefined`. The shape
 * is asserted up front, naming the odd row, and so is every email address (`assertExampleEmails`). In a check
 * run, one live read with `limit=0` first proves the table and the columns exist. Returns the inserted rows
 * with their ids. Treat that array as a count and a pool, not as a map from your rows to ids: a parent's id
 * comes from `idsByKey`. Throws on a short RETURNING.
 * Bare INSERT: a re-run appends a second set. Use it only for a table with no column that differs on every
 * row (a connecting record); every other table goes through `seedEnsureMany`.
 */
export async function postMany(path: string, rows: ReadonlyArray<Row>, size = BATCH_SIZE): Promise<any[]> {
  if (!rows.length) return [];
  const table = tableOf(path);
  assertExampleEmails(table, rows);
  rowsInserted = true;
  if (isCheckRun()) {
    const columns = Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined);
    await pgRequest("GET", `${table}?select=${columns.join(",")}&limit=0`);   // a missing table or column fails here, before the real run
  }
  const shapeOf = (r: Row): string => Object.keys(r).filter((k) => r[k] !== undefined).sort().join(",");
  const shape = shapeOf(rows[0]);
  rows.forEach((r, i) => {
    const s = shapeOf(r);
    if (s !== shape) {
      throw new Error(
        `postMany ${table}: row ${i} keys [${s}] differ from row 0 [${shape}]; a bulk insert needs identical keys ` +
        `on every row (send null / "" / 0 explicitly; never omit a key or leave it undefined)`,
      );
    }
  });
  const out: any[] = [];
  for (const part of chunk(rows, size)) {
    const res = await pgRequest("POST", table, part);
    if (!Array.isArray(res) || res.length !== part.length) {
      throw new Error(
        `postMany ${table}: sent ${part.length} row(s), PostgREST returned ${Array.isArray(res) ? res.length : typeof res} ` +
        `(RETURNING suppressed by RLS, or a partial insert); halting`,
      );
    }
    out.push(...res);
    if (!isCheckRun()) console.log(`  ✓ POST ${table}: ${part.length} row(s) in one call`);
  }
  return out;
}

/**
 * The default insert for a table. Reads the rows whose `keyField` is already present (`in.()`, chunked), posts
 * only the missing rows, and returns ALL rows with ids in INPUT order, found by key, so a re-run after a halt
 * converges instead of appending a second set. `keyField` is the column that differs on every row (the label
 * column, or a code), present on every row and stable across runs; the database need not enforce it. Use it
 * only on entities the build just created: a row that already exists under that key is reused, not replaced.
 * Never an upsert.
 */
export async function seedEnsureMany(path: string, rows: ReadonlyArray<Row>, keyField: string): Promise<any[]> {
  const table = tableOf(path);
  const keys = keysOf("seedEnsureMany", table, keyField, rows);
  const byKey = new Map<string, any>();
  for (const part of chunk(keys)) {
    for (const r of await pgRequest("GET", `${table}?${inFilter(keyField, part)}`)) byKey.set(String(r[keyField]), r);
  }
  const missing = rows.filter((_, i) => !byKey.has(keys[i]));
  for (const r of await postMany(table, missing)) byKey.set(String(r[keyField]), r);
  const still = keys.filter((k) => !byKey.has(k));
  if (still.length) throw new Error(`seedEnsureMany ${table}: ${still.length} row(s) neither found nor returned by the insert: ${preview(still)}`);
  return keys.map((k) => byKey.get(k));
}

/** Updates ONE record by id: `PATCH <table>?id=eq.<id>` with `body`. Throws unless exactly one row came back. */
export async function patchById(table: string, id: string | number, body: Row): Promise<any> {
  const res = await pgRequest("PATCH", `${tableOf(table)}?id=eq.${encodeURIComponent(String(id))}`, body);
  if (!Array.isArray(res) || res.length !== 1) {
    throw new Error(`patchById ${table}: expected 1 row back, got ${Array.isArray(res) ? res.length : typeof res}`);
  }
  return res[0];
}

/**
 * Empties tables this build seeded, so a changed script can seed them again: `seedEnsureMany` never changes a row
 * that is already there. `tables` is in delete order, children first, each with the row count it holds:
 *   await clearSeeded([["/contracts", 4], ["/vendors", 3]]);
 * Every table is counted before the first delete, and a count that differs halts with nothing deleted, because
 * the other rows are not the seed's. Deletes by id, at most `BATCH_SIZE` per call. In a check run the counts are
 * read and the deletes are recorded, never sent. Use it only on entities the build created.
 */
export async function clearSeeded(tables: ReadonlyArray<readonly [path: string, expected: number]>): Promise<void> {
  clearStarted = true;
  const ids = new Map<string, Array<string | number>>();
  const wrong: string[] = [];
  for (const [path, expected] of tables) {
    const table = tableOf(path);
    const rows: any[] = await pgRequest("GET", `${table}?select=id`);
    if (rows.length !== expected) wrong.push(`${table} holds ${rows.length} row(s), expected ${expected}`);
    ids.set(table, rows.map((r) => r.id));
  }
  if (wrong.length) {
    throw new Error(
      `clearSeeded: nothing deleted, ${wrong.length} table(s) do not hold the expected rows:\n  - ${wrong.join("\n  - ")}\n` +
      `The other rows are not the seed's. Stop and tell the user; do not copy these numbers into the script.`,
    );
  }
  for (const [table, rowIds] of ids) {
    for (const part of chunk(rowIds)) {
      const res = await pgRequest("DELETE", `${table}?${inFilter("id", part)}`);
      if (!isCheckRun() && (!Array.isArray(res) || res.length !== part.length)) {
        throw new Error(
          `clearSeeded ${table}: asked to delete ${part.length} row(s), PostgREST returned ${Array.isArray(res) ? res.length : typeof res} ` +
          `(a parent listed before its child, or RLS); halting`,
        );
      }
    }
    console.log(`  ${tag()}✓ ${table}: ${rowIds.length} row(s) ${isCheckRun() ? "to delete" : "deleted"}`);
  }
}

// ─────────────────────────────── relationships ───────────────────────────────

/**
 * Turns a parent's natural key (its label) into its id. Re-reads the parent table once per at most
 * `BATCH_SIZE` keys (`select=id,<keyField>` with an `in.()` filter) and returns a function:
 *   const vendorId = await idsByKey("/vendors", "vendor_name", vendorRows);
 *   vendor_id: vendorId("Adobe")
 * The function throws on a label that was not seeded, so a typo is a halt, not a wrong id. Throws here when
 * a seeded label is absent from the table or matches more than one row (a repeated label from an earlier run).
 */
export async function idsByKey(
  path: string, keyField: string, rows: ReadonlyArray<Row>,
): Promise<(key: string) => string | number> {
  const table = tableOf(path);
  const keys = keysOf("idsByKey", table, keyField, rows);
  const found = new Map<string, any[]>();
  for (const part of chunk(keys)) {
    for (const r of await pgRequest("GET", `${table}?select=id,${keyField}&${inFilter(keyField, part)}`)) {
      const k = String(r[keyField]);
      found.set(k, [...(found.get(k) ?? []), r]);
    }
  }
  const absent = keys.filter((k) => !found.has(k));
  if (absent.length) throw new Error(`idsByKey ${table}: ${absent.length} seeded ${keyField} value(s) not found on read-back: ${preview(absent)}`);
  const repeated = keys.filter((k) => found.get(k)!.length > 1);
  if (repeated.length) throw new Error(`idsByKey ${table}: ${keyField} matches more than one row for ${preview(repeated)}; clear the earlier rows with clearSeeded or rename`);
  return (key: string) => {
    const hit = found.get(key);
    if (!hit) throw new Error(`idsByKey ${table}: no seeded ${keyField} "${key}"; seeded: ${preview(keys)}`);
    return hit[0].id;
  };
}

const SPINE = " › ";

/**
 * Reads the child rows back with their `<fkField>_label` and compares each with the parent label the script
 * meant. `rows` are the child rows as sent (each carries `keyField`, a column unique across them: the label
 * column or a code); `parentLabels[i]` is the label of the parent intended for `rows[i]`, or `null` for a row
 * whose optional relationship is meant to be empty. A composed label shows ancestors first
 * ("Region › Vendor"); a label that ends with the intended one after " › " matches.
 * Throws naming every wrong row. On a real run only: the label columns exist on the live host.
 */
export async function assertParents(
  path: string, keyField: string, fkField: string,
  rows: ReadonlyArray<Row>, parentLabels: ReadonlyArray<string | null>,
): Promise<void> {
  const table = tableOf(path);
  if (rows.length !== parentLabels.length) {
    throw new Error(`assertParents ${table}.${fkField}: ${rows.length} row(s) but ${parentLabels.length} intended parent label(s)`);
  }
  const keys = keysOf("assertParents", table, keyField, rows);
  parentLabels.forEach((l, i) => {
    if (l === "") throw new Error(`assertParents ${table}.${fkField}: row ${i} has no intended parent label (null means the relationship is meant to be empty)`);
  });
  if (isCheckRun()) {
    console.log(`  [check run] ${table}.${fkField}: parent labels are read back on the real run`);
    return;
  }
  const column = `${fkField}_label`;
  const stored = new Map<string, string>();
  for (const part of chunk(keys)) {
    for (const r of await pgRequest("GET", `${table}?select=${keyField},${column}&${inFilter(keyField, part)}`)) {
      stored.set(String(r[keyField]), String(r[column] ?? ""));
    }
  }
  const wrong: string[] = [];
  keys.forEach((k, i) => {
    const got = stored.get(k);
    const want = parentLabels[i];
    const matches = want === null ? got === "" : got === want || (got ?? "").endsWith(`${SPINE}${want}`);
    if (got === undefined || !matches) {
      wrong.push(`${k}: intended ${want === null ? "no parent" : `parent "${want}"`}, stored "${got ?? "(row not found)"}"`);
    }
  });
  if (wrong.length) {
    throw new Error(
      `assertParents ${table}.${fkField}: ${wrong.length} of ${keys.length} row(s) name the wrong parent:\n  - ${wrong.join("\n  - ")}\n` +
      `Fix each with patchById (or clearSeeded and seed again), then check again.`,
    );
  }
  console.log(`  ✓ ${table}.${fkField}: all ${keys.length} row(s) name the intended parent`);
}

/**
 * Checks a connecting record (junction) table, which has no column that differs on every row, so
 * `assertParents` cannot key it. Reads every row of the table back with both `<fkA>_label` and `<fkB>_label`
 * and compares them with the pairs the script meant, as a set of rows: every intended pair must be there and
 * nothing else (a pair that is missing, wrong or left over from an earlier run halts, named). Meant for a
 * table this script just created, which holds at most the 20 seeded rows. Real run only, like `assertParents`.
 *   await assertJunction("/seats", "application_id", "user_id", [["Slack", "Maria Lopez"], ["Figma", "Tom Becker"]]);
 */
export async function assertJunction(
  path: string, fkA: string, fkB: string, pairs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const table = tableOf(path);
  pairs.forEach(([a, b], i) => { if (!a || !b) throw new Error(`assertJunction ${table}: pair ${i} has an empty label`); });
  if (isCheckRun()) {
    console.log(`  [check run] ${table}.${fkA}/${fkB}: pairs are read back on the real run`);
    return;
  }
  const [colA, colB] = [`${fkA}_label`, `${fkB}_label`];
  const stored: Array<{ a: string; b: string }> = (await pgRequest("GET", `${table}?select=${colA},${colB}`))
    .map((r: Row) => ({ a: String(r[colA] ?? ""), b: String(r[colB] ?? "") }));
  const same = (got: string, want: string) => got === want || got.endsWith(`${SPINE}${want}`);
  const missing: string[] = [];
  for (const [a, b] of pairs) {
    const at = stored.findIndex((s) => same(s.a, a) && same(s.b, b));
    if (at < 0) missing.push(`${a} + ${b}`); else stored.splice(at, 1);
  }
  if (missing.length || stored.length) {
    throw new Error(
      `assertJunction ${table}.${fkA}/${fkB}:` +
      (missing.length ? `\n  - ${missing.length} intended pair(s) not stored: ${missing.join("; ")}` : "") +
      (stored.length ? `\n  - ${stored.length} stored row(s) not intended: ${stored.map((s) => `${s.a} + ${s.b}`).join("; ")}` : "") +
      `\nFix with patchById (or clearSeeded and seed again), then check again.`,
    );
  }
  console.log(`  ✓ ${table}.${fkA}/${fkB}: all ${pairs.length} row(s) name the intended parents`);
}

// ─────────────────────────────── generators ───────────────────────────────

/**
 * Seeded random generator, one per table: `const r = rng("contracts")`. The seed is fixed (42) and the table
 * name gives each table its own sequence, so a re-run of the UNCHANGED script draws the same values (dates
 * from `days()` are relative to the run day). Never `Math.random()`.
 *   - `r.pick(pool)`         one random entry; repeats are fine (job title, email local part)
 *   - `r.int(min, max)`      an integer in [min, max] (house number, quantity, amount, day offset)
 *   - `r.chance(p)`          true with probability p (booleans with a realistic mix)
 *   - `r.deal(pool, n)`      n entries, shuffled, every pool entry once before any repeats: enum values (each
 *                            value appears once n >= the value count; repeat a value in the pool to weight
 *                            it), parents dealt to children, places
 *   - `r.distinct(pool, n)`  n DIFFERENT entries; throws when the pool has fewer than n (names, labels)
 *   - `r.tuples(n, pools)`   n DISTINCT combinations, each part dealt (first + last name, two-word names);
 *                            throws when the pools cannot give n combinations
 */
export function rng(stream: string, seed = 42) {
  let s = seed >>> 0;
  for (let k = 0; k < stream.length; k++) s = Math.imul(s ^ stream.charCodeAt(k), 0x01000193) >>> 0;
  const next = (): number => {   // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nonEmpty = (pool: readonly unknown[], what: string) => {
    if (!pool.length) throw new Error(`rng("${stream}").${what}: empty pool`);
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const chance = (p: number): boolean => next() < p;
  const pick = <T>(pool: readonly T[]): T => {
    nonEmpty(pool, "pick");
    return pool[Math.floor(next() * pool.length)];
  };
  const deal = <T>(pool: readonly T[], n: number): T[] => {
    nonEmpty(pool, "deal");
    const out: T[] = [];
    while (out.length < n) {
      const round = [...pool];
      for (let k = round.length - 1; k > 0; k--) {
        const j = Math.floor(next() * (k + 1));
        [round[k], round[j]] = [round[j], round[k]];
      }
      out.push(...round);
    }
    return out.slice(0, n);
  };
  const distinct = <T>(pool: readonly T[], n: number): T[] => {
    const values = [...new Set(pool)];
    if (values.length < n) {
      throw new Error(`rng("${stream}").distinct: ${n} different entries asked, the pool has ${values.length}; build them with r.tuples`);
    }
    return deal(values, n);
  };
  const tuples = <T>(n: number, pools: ReadonlyArray<readonly T[]>): T[][] => {
    pools.forEach((p) => nonEmpty(p, "tuples"));
    const sets = pools.map((p) => [...new Set(p)]);   // a repeated pool entry is not a second value
    const space = sets.reduce((acc, p) => acc * p.length, 1);
    if (space < n) {
      throw new Error(`rng("${stream}").tuples: ${n} distinct combinations asked, the pools give only ${space}; add pool entries`);
    }
    const key = (t: T[]) => JSON.stringify(t);
    const seen = new Set<string>();
    const firstFree = (): T[] => {   // near exhaustion: walk the combinations in order
      for (let idx = 0; ; idx++) {
        let q = idx;
        const t = sets.map((p) => { const v = p[q % p.length]; q = Math.floor(q / p.length); return v; });
        if (!seen.has(key(t))) return t;
      }
    };
    const columns = sets.map((p) => deal(p, n));
    const out: T[][] = [];
    for (let k = 0; k < n; k++) {
      let t = columns.map((c) => c[k]);
      for (let tries = 0; seen.has(key(t)) && tries < 100; tries++) t = sets.map((p) => pick(p));
      if (seen.has(key(t))) t = firstFree();
      seen.add(key(t));
      out.push(t);
    }
    return out;
  };
  return { next, int, chance, pick, deal, distinct, tuples };
}

const LATIN: Record<string, string> = { "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };

/**
 * Lowercase ASCII token for email local parts and domains: letters without a decomposed form transliterated
 * (ø → o, æ → ae, ß → ss, ł → l, đ → d), accents stripped, everything but a-z / 0-9 dropped.
 * `slugify("Søren Østergaard")` → "sorenostergaard". Throws when nothing Latin is left (`李伟`): such a name
 * carries a Latin form for its email.
 */
export function slugify(s: string): string {
  const out = s.toLowerCase()
    .replace(/[øæœßłđðþı]/g, (c) => LATIN[c])
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (!out) throw new Error(`slugify("${s}"): no Latin letters left; give the name a Latin form for its email`);
  return out;
}

/** Email / web domain for an invented company: `exampleDomain("Beacon Foods")` → "beaconfoods.example.com". Subdomains of example.com are reserved and never receive mail. */
export const exampleDomain = (companyName: string): string => `${slugify(companyName)}.example.com`;

/** Collision-proof token for a CODE-LIKE `unique_value` field (account code, SKU, invoice number): `uniq("ACCT-", i)` → "ACCT-0", "ACCT-1", … Never on a field a person reads as a name. */
export const uniq = (base: string, i: number, suffix = ""): string => `${base}${i}${suffix}`;

/** A date `d` days from today (negative for the past) as `YYYY-MM-DD`: `days(-30)`, `days(rng.int(60, 400))`. */
export const days = (d: number): string => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

// ─────────────────────────────── guards ───────────────────────────────

/** Every table landed but the numbers must change, so a plain re-run keeps the old rows. */
class SeedPlanError extends Error {}

/**
 * Scale guard, before the first write: a parent's stored figure that its child rows itemize (seats purchased over
 * seat rows) stays between the number of those rows and twice that, because a small dataset cannot carry a real
 * company's numbers. Each entry is the parent's label, its figure and its number of child rows:
 *   assertItemized("subscriptions.seats_purchased", plan.map((p) => [p.name, p.seats_purchased, p.seats.length]));
 * Throws naming every parent outside the range. It reads nothing, so a check run applies it the same way.
 */
export function assertItemized(column: string, parents: ReadonlyArray<readonly [label: string, figure: number, children: number]>): void {
  if (!parents.length) throw new Error(`assertItemized ${column}: no parents given`);
  const wrong = parents
    .filter(([, figure, children]) => !(figure >= children && figure <= children * 2))
    .map(([label, figure, children]) => `${label}: ${figure} over ${children} child row(s), expected ${children} to ${children * 2}`);
  if (wrong.length) {
    throw new Error(
      `SEED SCALE FAILURE, ${column}: ${wrong.length} of ${parents.length} parent(s) out of scale:\n  - ${wrong.join("\n  - ")}\n` +
      `Set each figure from the parent's child rows in the plan.`,
    );
  }
  console.log(`  ${tag()}✓ ${column}: ${parents.length} parent(s) at the scale of their child rows`);
}

/**
 * Read-back guard for `computed` and `rollup` columns: the platform writes them, so only a read shows them. Reads
 * `columns` for the seeded `rows` (`keyField` is a column unique across them) and halts when a column holds one
 * value on every row, which means its inputs do not differ between the rows. Call it at the very end of the script,
 * before `assertSeedCounts`. A check run only proves the columns exist: the values appear on the real run.
 */
export async function assertComputedVary(
  path: string, keyField: string, rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>,
): Promise<void> {
  const table = tableOf(path);
  const keys = keysOf("assertComputedVary", table, keyField, rows);
  if (!columns.length) throw new Error(`assertComputedVary ${table}: no columns named`);
  const select = [keyField, ...columns].join(",");
  if (isCheckRun()) {
    await pgRequest("GET", `${table}?select=${select}&limit=0`);   // a missing column fails here, before the real run
    console.log(`  [check run] ${table}: ${columns.join(", ")} are read back on the real run`);
    return;
  }
  const stored = new Map<string, any>();
  for (const part of chunk(keys)) {
    for (const r of await pgRequest("GET", `${table}?select=${select}&${inFilter(keyField, part)}`)) stored.set(String(r[keyField]), r);
  }
  const absent = keys.filter((k) => !stored.has(k));
  if (absent.length) throw new Error(`assertComputedVary ${table}: ${absent.length} seeded ${keyField} value(s) not found on read-back: ${preview(absent)}`);
  if (keys.length < 2) {
    console.log(`  ${table}: one row, so ${columns.join(", ")} cannot be compared`);
    return;
  }
  const fails: string[] = [];
  for (const c of columns) {
    const values = new Set(keys.map((k) => String(stored.get(k)[c] ?? "")));
    if (values.size > 1) console.log(`  ✓ ${table}.${c}: ${values.size} distinct value(s) across ${keys.length} row(s)`);
    else fails.push(`${table}.${c}: "${[...values][0]}" on all ${keys.length} row(s)`);
  }
  if (fails.length) {
    throw new SeedPlanError(
      `SEED COMPUTED VALUE FAILURE, ${fails.length} column(s) hold one value on every row:\n  - ${fails.join("\n  - ")}\n` +
      `Give the rows different inputs in the plan (for a rollup that counts children, different numbers of children), then ` +
      `clearSeeded and seed again. Never drop the column and never patch it: the platform writes it.`,
    );
  }
}

/**
 * Count guard. `expected` is the per-table count the sample-data question named; `counts` is what the script
 * tallied from its own inserts (`counts.vendors = vendors.length`). Throws when a table missed its count
 * (including a table never seeded) or when a table was tallied that `expected` does not name (a typo).
 */
export function assertSeedCounts(counts: Record<string, number>, expected: Record<string, number>): void {
  const fails: string[] = [];
  for (const [table, want] of Object.entries(expected)) {
    const n = counts[table] ?? 0;
    if (n === want) console.log(`  ${tag()}✓ ${table}: ${n}`);
    else fails.push(`${table} seeded ${n}, expected ${want}${table in counts ? "" : " (table never seeded)"}`);
  }
  for (const table of Object.keys(counts)) {
    if (!(table in expected)) fails.push(`${table} was seeded but is not in the expected counts (typo?)`);
  }
  if (fails.length) throw new Error(`SEED COUNT FAILURE, ${fails.length} problem(s):\n  - ${fails.join("\n  - ")}`);
  console.log(`\n${tag()}All ${Object.keys(expected).length} table(s) at target${isCheckRun() ? " (nothing was sent)" : ""}.`);
}

/**
 * Distinctness guard: a count proves the table is full, not that every row carries the same surname, company
 * or a one-word label. Fails when a human-facing column has fewer than `minDistinct` different values
 * (default: the smaller of the row count and 8). Empty strings and nulls are not counted. Call it only on
 * columns where variety is expected, with a part that lives inside a combined value passed as its own column.
 */
export function assertSeedDistinct(
  table: string, rows: ReadonlyArray<Row>, fields: ReadonlyArray<string>, minDistinct = Math.min(rows.length, 8),
): void {
  const fails: string[] = [];
  for (const f of fields) {
    const values = rows.map((r) => r[f]).filter((v) => v !== "" && v !== null && v !== undefined);
    const distinct = new Set(values.map((v) => String(v))).size;
    if (distinct >= Math.min(minDistinct, values.length)) console.log(`  ${tag()}✓ ${table}.${f}: ${distinct} distinct`);
    else fails.push(`${table}.${f}: ${distinct} distinct value(s) across ${rows.length} row(s), expected >= ${minDistinct}`);
  }
  if (fails.length) throw new Error(`SEED DISTINCTNESS FAILURE, ${fails.length} problem(s):\n  - ${fails.join("\n  - ")}\nDeal the field from a larger pool (r.deal / r.tuples).`);
}

/**
 * Halting harness: runs the seed script's body, owns the try/catch, and exits non-zero on any thrown error.
 * Success is printed only when the body resolved with no throw. After a halt, the tables written before the
 * failing call have landed; a re-run converges only for tables seeded with `seedEnsureMany`. A script that only
 * clears ends `Clear finished`, never `Seed finished`.
 */
export async function runSeed(body: () => Promise<void>): Promise<void> {
  try {
    await body();
    const clearOnly = clearStarted && !rowsInserted;
    console.log(
      isCheckRun()
        ? clearOnly
          ? `\nCHECK RUN passed: ${writeCount} delete call(s) checked, none sent, nothing cleared. Run the script again without --check to clear.`
          : `\nCHECK RUN passed: ${writeCount} write call(s) checked, none sent, nothing seeded. Run the script again without --check to seed.`
        : clearOnly
          ? `\nClear finished: ${writeCount} delete call(s) applied with no errors. Nothing was seeded: run the seed script next.`
          : `\nSeed finished: ${writeCount} write call(s) applied with no errors.`,
    );
  } catch (err) {
    console.error(`\nSEED HALTED after ${writeCount} write call(s): ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      isCheckRun()
        ? "Nothing was sent. Fix the script and check-run it again."
        : err instanceof SeedPlanError
          ? "Every table landed, so a plain re-run changes nothing. Fix the plan, run clearSeeded, then seed again."
          : clearStarted && !rowsInserted
            ? writeCount
              ? "The clear is INCOMPLETE: the tables listed before the failing one are already empty. Stop and tell the user."
              : "Nothing was deleted. Stop and tell the user."
            : "The seed is INCOMPLETE. Tables written before this call have landed. Inspect them before a re-run: only a table seeded with seedEnsureMany converges.",
    );
    process.exit(1);
  }
}
