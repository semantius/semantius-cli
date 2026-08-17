#!/usr/bin/env bun
/**
 * deploy-lib.ts — the fixed primitives + halting harness for a Semantius
 * modeler deploy script. These never change across deploys; the per-model
 * orchestration is bespoke and lives in the agent-authored
 * `.tmp_deploy/deploy_<slug>.ts` that IMPORTS this file.
 *
 * Why this is a committed resource and not code pasted into each deploy script:
 * the transport (`write`) and the read-before-write check (`read1`) are
 * identical every time, and an agent re-typing them from a markdown fence is
 * exactly how the `intgov-inventory` partial deploy shipped — bare `catch`
 * blocks that swallowed errors and reported success over a ~40%-complete
 * catalog. Copy this file into the scratch dir and import it; never
 * re-implement it.
 *
 * The contract this enforces (all four already in the modeler SKILL.md):
 *   - Failure is loud and halting: `write` throws on any non-zero exit, and
 *     `runDeploy` turns any thrown error into a non-zero process exit with an
 *     "INCOMPLETE — re-run" message. There is no swallow-and-continue path.
 *   - Read before writing: `read1` is exit-code-aware (0 = row, 1 = absent,
 *     2/3/4/5 = real error → throw), never a try/catch existence probe.
 *   - Success is never printed over a partial deploy: the success line is
 *     reachable only when the orchestration callback resolves with zero throws.
 *   - Batch: whenever more than one record of the same kind is pending (the
 *     entities of a spec, the fields of an entity, the baseline permissions of a
 *     module, the seed rows of a table), it goes out as ONE array call — never a
 *     loop of single-record calls. `createMany` / `ensureMany` / `ensurePairs`
 *     (Layer 1, `create_*` with an array `data`) and `postMany` /
 *     `seedEnsureMany` (Layer 2, `postgrestRequest` with an array `body`) are the
 *     primitives; `BATCH_SIZE` (100) caps one call. A failed bulk call landed
 *     NOTHING (one request, one transaction, all-or-nothing) and is never retried
 *     row-by-row: fix the cause and re-run, the read-before-write converges.
 *
 * Not a CLI — import it:
 *   import { read1, readMany, readIn, write, ensure, ensureMany, ensurePairs,
 *            createMany, updateEntity, postMany, seedEnsureMany, runDeploy } from "./deploy-lib";
 */

let writeCount = 0;

/** Count of successful mutating write CALLS so far (a bulk call counts once; feeds the halt / success summary). */
export const writes = (): number => writeCount;

/**
 * Loud mutating call (`create_*` / `update_*` / `delete_*` / `postgrestRequest`
 * POST/PATCH/DELETE). The payload goes over stdin, so no shell quoting layer
 * ever sees the model's prose (backticks, apostrophes, Unicode all travel
 * intact). THROWS on any non-zero exit — a failed write must halt the script.
 * `label` names the call in that error (bulk callers pass the chunk's natural
 * keys); it defaults to the tool name. `--single` is never added here: bulk
 * payloads (array `data` / `id` / `table_name`) return arrays and the CLI rejects
 * `--single` for them.
 */
export async function write(tool: string, payload: unknown, label = tool): Promise<any> {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`write ${label} failed (exit ${code}): ${err}`);
  writeCount++;
  return out.trim() ? JSON.parse(out) : null;
}

/**
 * Read-before-write existence check. Passes `--single` and branches on the
 * EXIT CODE per use-semantius "Response handling":
 *   0 → exactly one row (return it)   1 → none (return null, the create branch)
 *   2 → ambiguous   3 → transport   4 → tool   5 → auth   → THROW (never "not found").
 * `filters` are natural keys (slugs, table_names, permission codes); Bun.spawn
 * with an arg array bypasses the shell, so the inline JSON is safe.
 * Multiple conditions join with `&` (PostgREST AND across columns), e.g.
 * `role_id=eq.1&permission_id=eq.2` — a comma is NOT an AND separator and
 * silently matches nothing (reads as "not found", then a duplicate create).
 */
export async function read1(tool: string, filters: string): Promise<any | null> {
  const proc = Bun.spawn(
    ["semantius", "call", "crud", tool, "--single", JSON.stringify({ filters })],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code === 0) return JSON.parse(out);   // exactly one row
  if (code === 1) return null;              // not found — the normal create branch
  throw new Error(`read1 ${tool} failed (exit ${code}): ${err}`);  // 2/3/4/5 — halt
}

/**
 * Read-before-write create that returns the AUTHORITATIVE row. The contract:
 * never trust a `create_*` response to carry the new row's `id` / natural key
 * (the PostgREST representation a create echoes is not a contract you can build
 * FK resolution on — the `module_id`-null-on-permission-create failures came
 * from exactly that assumption). Instead: `read1` by natural key first (idempotent
 * re-run returns the existing row), `write` only when absent, then `read1` AGAIN
 * so the caller always gets a real row with its real `id`. Throws loud if the
 * post-create read still finds nothing (a silent partial failure).
 *
 *   const mod  = await ensure("read_module", `module_slug=eq.${slug}`, "create_module", moduleData);
 *   const perm = await ensure("read_permission", `permission_name=eq.${code}`, "create_permission",
 *                             { ...permData, module_id: mod.id });   // mod.id came from a READ, not the create
 */
export async function ensure(
  readTool: string, filters: string,
  writeTool: string, data: unknown,
): Promise<any> {
  const existing = await read1(readTool, filters);
  if (existing) return existing;
  await write(writeTool, { data });
  const created = await read1(readTool, filters);
  if (!created) {
    throw new Error(
      `ensure: ${writeTool} reported success but ${readTool} (${filters}) still returns no row`,
    );
  }
  return created;
}

/**
 * `update_entity` shape, OWNED — same philosophy as `post()` owning the PostgREST
 * `body`. `update_entity` is the one catalog write whose envelope is neither
 * `{data}` (every `create_*`) nor a numeric/string `id` (`update_module` /
 * `update_field`): it is keyed by `table_name` at the TOP level with the changed
 * columns under `data` — `{"table_name": "tickets", "data": {...}}`. Hand-rolling
 * that is exactly where deploys fumbled (table_name buried inside `data`, or the
 * patch double-wrapped to `{data:{data:...}}`). Call sites pass the table name and
 * the partial column patch; this owns the envelope so the shape can't be got wrong:
 *     await updateEntity("tickets", { select_rule: {...} });
 *     await updateEntity("subscriptions", { module_id: masterId });   // promote / move
 * Goes through `write`, so it is loud (throws on non-zero) and counts as a write.
 * It is a blind PATCH — pair it with a `read1`/`readMany` diff for create-or-diff
 * paths; `ensure` is the create-if-missing helper, this is the update half.
 */
export async function updateEntity(
  tableName: string, data: Record<string, unknown>,
): Promise<any> {
  return write("update_entity", { table_name: tableName, data });
}

/** Zero-or-many read (live field dumps for the diff, dedup checks). Returns an array (`[]` = none). */
export async function readMany(tool: string, filters: string): Promise<any[]> {
  const proc = Bun.spawn(
    ["semantius", "call", "crud", tool, JSON.stringify({ filters })],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`readMany ${tool} failed (exit ${code}): ${err}`);
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ───────────────────────────── bulk (array) primitives ────────────────────────
//
// The crud server's typed `create_*` tools take `data` as ONE object or a
// non-empty ARRAY of objects (one request, one transaction, all-or-nothing;
// items may have DIFFERENT keys — the server sends `?columns=<union>` with
// `Prefer: missing=default`, so an omitted key takes the column default), and
// `update_*` / `delete_*` take `id` (or `table_name` for entities) as one value
// or an array (`id=in.(...)`, the same `data` applied to every id). The response
// is always an array. The rule these helpers implement: more than one record of
// the same kind pending → ONE call. Never `for (…) await write("create_x", …)`.

/** Rows / keys per call. 100 keeps `in.()` filters short and one DDL-heavy `create_entity` / `create_field` transaction bounded. */
export const BATCH_SIZE = 100;

/** Split `rows` into consecutive slices of `size` (an empty input yields NO chunk, so callers issue no call). */
export function chunk<T>(rows: ReadonlyArray<T>, size = BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk: size must be a positive integer (got ${size})`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const preview = (keys: ReadonlyArray<string>, n = 20): string =>
  keys.slice(0, n).join(", ") + (keys.length > n ? `, … +${keys.length - n} more` : "");

/** PostgREST `in.()` value quoting — the same rule the crud server applies to array keys: plain when safe, else double-quoted with `\` and `"` escaped. */
const PG_PLAIN = /^[A-Za-z0-9_$.\-:@]+$/;
export const pgQuote = (v: string | number): string => {
  const s = String(v);
  return PG_PLAIN.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/**
 * `col=in.(v1,v2,…)` for a multi-key read. Values are quoted per `pgQuote`, then
 * percent-encoded so a `&`, `+`, `#`, `%` or space inside a value (seed keys are
 * arbitrary strings) can never break the query string. Throws on an empty list —
 * an empty `in.()` is never what a caller meant.
 */
export function inFilter(column: string, values: ReadonlyArray<string | number>): string {
  if (!values.length) throw new Error(`inFilter ${column}: empty value list`);
  return `${column}=in.(${values.map((v) => encodeURIComponent(pgQuote(v))).join(",")})`;
}

/**
 * Multi-key read: ONE `readMany` per ≤`size` distinct keys (`column=in.(…)`,
 * AND-joined with `extraFilter` when given), concatenated. Rows come back in DB
 * order — not input order and not one-per-key — so index the result by key,
 * never zip it by position. Empty `values` → `[]` with no call. This is the
 * read-before-write sweep for a bulk create; `read1` (`--single`) cannot do it
 * (an `in.()` that matches several rows exits 2, "ambiguous").
 */
export async function readIn(
  tool: string, column: string, values: ReadonlyArray<string | number>,
  extraFilter?: string, size = BATCH_SIZE,
): Promise<any[]> {
  const keys = [...new Set(values.map(String))];
  const out: any[] = [];
  for (const part of chunk(keys, size)) {
    const f = inFilter(column, part);
    out.push(...(await readMany(tool, extraFilter ? `${extraFilter}&${f}` : f)));
  }
  return out;
}

/**
 * Bulk create: ONE `write(tool, {data: chunk})` per ≤`size` rows — one request,
 * one transaction, all-or-nothing per chunk. Pass RAW rows (the `{data}` envelope
 * is added here, exactly like `ensure`). Returns the concatenated array response
 * as a RECEIPT (the row count is asserted), NOT as an id source — catalog ids are
 * still resolved by a re-read (`ensureMany` does that). Throws on the first
 * failed chunk, naming its natural keys via `keyOf`; there is deliberately NO
 * per-row fallback: nothing from a failed call landed, so fix the cause and
 * re-run (the landed chunks read back as existing). Counts one write per chunk.
 */
export async function createMany(
  tool: string, rows: ReadonlyArray<Record<string, unknown>>,
  keyOf: (row: any) => string | number = (r) => JSON.stringify(r).slice(0, 60),
  size = BATCH_SIZE,
): Promise<any[]> {
  const parts = chunk(rows, size);
  const out: any[] = [];
  for (const [i, part] of parts.entries()) {
    const label = `${tool} chunk ${i + 1}/${parts.length} (${part.length} rows: ${preview(part.map((r) => String(keyOf(r))))})`;
    const res = await write(tool, { data: part }, label);
    if (!Array.isArray(res) || res.length !== part.length) {
      throw new Error(
        `createMany ${label}: expected ${part.length} row(s) back, got ${Array.isArray(res) ? res.length : typeof res}`,
      );
    }
    out.push(...res);
    console.log(`  ✓ ${tool}: ${part.length} row(s) in one call`);
  }
  return out;
}

/**
 * Bulk twin of `ensure()` — the create-if-missing for a whole SET of records of
 * one kind: `readIn` the natural keys → `createMany` ONLY the missing rows →
 * `readIn` AGAIN → return `Map<key, liveRow>` (the authoritative rows, ids from
 * the read, never from the create response). `keyOf` must work on BOTH an input
 * row and a live row (keys are compared as strings); `keyColumn` is the live
 * column the `in.()` filter targets; `extraFilter` scopes it (e.g. one entity's
 * fields: `keyColumn: "field_name"`, `extraFilter: "table_name=eq.tickets"`;
 * fields across entities: `keyColumn: "id"`, `keyOf: r => \`${r.table_name}.${r.field_name}\``).
 * Duplicate input keys are rejected up front (they would 409 inside the one
 * transaction and fail the whole chunk). Throws loud when a created key still
 * reads back missing (silent partial failure — never retried in-run).
 *
 *   const entities = await ensureMany("read_entity", "table_name", (r) => r.table_name,
 *                                     "create_entity", entityRows);          // ONE create_entity call
 *   const mod = entities.get("tickets");                                     // live row, real id
 */
export async function ensureMany(
  readTool: string, keyColumn: string, keyOf: (row: any) => string | number,
  writeTool: string, rows: ReadonlyArray<Record<string, unknown>>, extraFilter?: string,
): Promise<Map<string, any>> {
  const wanted = rows.map((r) => String(keyOf(r)));
  const dup = [...new Set(wanted.filter((k, i) => wanted.indexOf(k) !== i))];
  if (dup.length) throw new Error(`ensureMany ${writeTool}: duplicate natural key(s) in the input: ${preview(dup)}`);
  const index = async (): Promise<Map<string, any>> =>
    new Map((await readIn(readTool, keyColumn, wanted, extraFilter)).map((r) => [String(keyOf(r)), r] as const));
  let live = await index();
  const missing = rows.filter((r) => !live.has(String(keyOf(r))));
  if (missing.length) {
    await createMany(writeTool, missing, keyOf);
    live = await index();
    const still = wanted.filter((k) => !live.has(k));
    if (still.length) {
      throw new Error(
        `ensureMany: ${writeTool} reported success but ${readTool} (${keyColumn}) still returns no row for ` +
        `${still.length} of ${missing.length} created key(s): ${preview(still)} — silent partial failure, NOT retrying`,
      );
    }
  }
  return live;
}

/**
 * Composite-key twin of `ensureMany` for link rows keyed by a PAIR of columns
 * (`permission_hierarchy` including/included, `role_permissions` role/permission,
 * `user_roles` user/role): read the superset by `colA=in.(…)`, match `(colA,colB)`
 * pairs locally, `createMany` the missing pairs in ONE call, re-read, throw if any
 * pair is still absent. Rows are the raw `create_*` payloads (they may carry extra
 * columns such as `origin`).
 */
export async function ensurePairs(
  readTool: string, colA: string, colB: string,
  writeTool: string, rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const key = (r: any): string => `${r[colA]}>${r[colB]}`;
  const wanted = rows.map(key);
  if (new Set(wanted).size !== wanted.length) throw new Error(`ensurePairs ${writeTool}: duplicate (${colA}, ${colB}) pairs in the input`);
  const liveKeys = async (): Promise<Set<string>> =>
    new Set((await readIn(readTool, colA, rows.map((r) => r[colA] as string | number))).map(key));
  const before = await liveKeys();
  const missing = rows.filter((r) => !before.has(key(r)));
  if (!missing.length) return;
  await createMany(writeTool, missing, key);
  const after = await liveKeys();
  const still = wanted.filter((k) => !after.has(k));
  if (still.length) {
    throw new Error(`ensurePairs: ${writeTool} reported success but ${still.length} pair(s) still read back absent: ${preview(still)}`);
  }
}

/**
 * Layer-2 (PostgREST) call via the `postgrestRequest` crud tool — the loud
 * transport for business-record reads/writes (the seed script's insert path).
 * NOTE: postgrestRequest's payload field is **`body`**, NOT `data` (`data` is the
 * Layer-1 crud-tool shape; mixing them up is a common trap — this helper owns the
 * difference so call sites never hand-roll `{method, path, data}`). Loud: throws
 * on any non-zero exit. `single` adds `--single` so a POST insert returns the
 * inserted row as a bare object and the CLI fails loudly on the wrong cardinality.
 * Returns parsed JSON (an array without `single`, the bare object with it).
 * `single` is only for a single-row body: the CLI rejects `--single` when `body`
 * is an array (a bulk insert always answers with an array) — use `postMany`.
 */
export async function pgRequest(
  method: string, path: string, body?: unknown, single = false,
): Promise<any> {
  if (single && Array.isArray(body)) {
    throw new Error(
      `pgRequest ${method} ${path}: --single cannot be combined with an array body ` +
      `(the CLI rejects it, SINGLE_ARRAY_INPUT); use postMany() for a bulk insert`,
    );
  }
  const argv = single
    ? ["semantius", "--single", "call", "crud", "postgrestRequest"]
    : ["semantius", "call", "crud", "postgrestRequest"];
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const payload: Record<string, unknown> = { method, path };
  if (body !== undefined) payload.body = body;
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`pgRequest ${method} ${path} failed (exit ${code}): ${err}`);
  return out.trim() ? JSON.parse(out) : null;
}

/** Insert ONE Layer-2 row and return it WITH its id (uses `body` + `--single`). For a genuine single row only — a table that gets several rows goes through `postMany` / `seedEnsureMany`, never a loop of `post()`. */
export async function post(path: string, body: Record<string, unknown>): Promise<any> {
  return pgRequest("POST", path, body, true);
}

/**
 * Idempotent Layer-2 insert: read by a NATURAL KEY before inserting, so a re-run
 * CONVERGES instead of appending a second copy. `post()` is a bare INSERT — running
 * a seed script twice inserts a whole second set of rows, and `assertSeedCounts`
 * cannot catch it (it tallies only THIS run's inserts, so it passes while the table
 * silently holds 2×target). seedEnsure closes that hole the way `ensure` does for
 * catalog rows: GET by the unique key, return the existing row if present, POST only
 * when absent. Use it INSTEAD of `post` whenever a seed script might be re-run, keyed
 * on a column that is unique per row and stable across runs — i.e. a `unique_value`
 * field driven by `uniq(base, i)`, since the same `i` regenerates the same key and
 * the read finds the prior row:
 *     await seedEnsure("/leads", row, "email");   // row.email === uniq(...)
 * `keyField` must be a column on `body` with a non-empty value. Returns the row WITH
 * its id either way, so FK capture works exactly like `post`.
 */
export async function seedEnsure(
  path: string, body: Record<string, unknown>, keyField: string,
): Promise<any> {
  const key = body[keyField];
  if (key === undefined || key === null || key === "") {
    throw new Error(`seedEnsure ${path}: key field "${keyField}" is empty on the row`);
  }
  const table = path.split("?")[0];
  const existing = await pgRequest(
    "GET", `${table}?${keyField}=eq.${encodeURIComponent(String(key))}&limit=1`,
  );
  if (Array.isArray(existing) && existing.length) return existing[0];
  return post(table, body);
}

/**
 * Layer-2 BULK insert — the seed-script default when a table gets more than one
 * row: ONE `postgrestRequest` POST with an array `body` per ≤`size` rows, never
 * `--single`. `postgrestRequest` is the RAW PostgREST path (no `?columns=`, no
 * `missing=default`), so every row MUST carry the SAME key set: send `null` for
 * a nullable column (`reference` / `date` / `date-time`), `""` / `0` for a NOT
 * NULL text / number, never omit a key on some rows and never leave it
 * `undefined` (a conditional spread does exactly that). The shape is asserted
 * up front, naming the odd row. Returns the inserted rows WITH their ids
 * (PostgREST `return=representation`; the ordinary Layer-2 id contract, same as
 * `post()`) — in practice input order, but treat it as an FK POOL or key it by a
 * natural key, not as a positional promise. Loud: throws on any non-zero exit
 * and on a short RETURNING (RLS hid rows or the insert was partial). Nothing
 * from a failed call landed. Bare INSERT: a re-run appends a second set — use
 * `seedEnsureMany` when a re-run is plausible.
 *
 *   const campaigns = await postMany("/campaigns", campaignRows);   // rows built in a loop, one call
 */
export async function postMany(
  path: string, rows: ReadonlyArray<Record<string, unknown>>, size = BATCH_SIZE,
): Promise<any[]> {
  if (!rows.length) return [];
  const table = path.split("?")[0];
  const shapeOf = (r: Record<string, unknown>): string =>
    Object.keys(r).filter((k) => r[k] !== undefined).sort().join(",");
  const shape = shapeOf(rows[0]);
  rows.forEach((r, i) => {
    const s = shapeOf(r);
    if (s !== shape) {
      throw new Error(
        `postMany ${table}: row ${i} keys [${s}] differ from row 0 [${shape}] — a raw PostgREST bulk insert ` +
        `needs identical keys on every row (send null / "" / 0 explicitly; never omit a key or leave it undefined)`,
      );
    }
  });
  const out: any[] = [];
  for (const part of chunk(rows, size)) {
    const res = await pgRequest("POST", table, part);   // array body → array response; --single is impossible here
    if (!Array.isArray(res) || res.length !== part.length) {
      throw new Error(
        `postMany ${table}: sent ${part.length} row(s), PostgREST returned ` +
        `${Array.isArray(res) ? res.length : typeof res} (RETURNING suppressed by RLS, or a partial insert) — halting`,
      );
    }
    out.push(...res);
    console.log(`  ✓ POST ${table}: ${part.length} row(s) in one call`);
  }
  return out;
}

/**
 * Re-run-safe bulk seed — `seedEnsure` for a whole table: GET the rows whose
 * `keyField` is already present (`?keyField=in.(…)`, chunked), `postMany` ONLY
 * the missing rows, and return ALL rows WITH ids in INPUT order (so FK capture
 * and per-table counts work exactly like `postMany`). `keyField` must be a
 * unique, stable-across-runs column present on every row (a `unique_value`
 * field built with `uniq(base, i)` / `combine(...)`); empty or duplicate keys are
 * rejected. Same uniform-keys rule as `postMany`.
 *
 *   const leads = await seedEnsureMany("/leads", leadRows, "email");
 */
export async function seedEnsureMany(
  path: string, rows: ReadonlyArray<Record<string, unknown>>, keyField: string,
): Promise<any[]> {
  const table = path.split("?")[0];
  const keys = rows.map((r, i) => {
    const k = r[keyField];
    if (k === undefined || k === null || k === "") throw new Error(`seedEnsureMany ${table}: row ${i} has an empty "${keyField}"`);
    return String(k);
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`seedEnsureMany ${table}: duplicate "${keyField}" values in the input — build the key with uniq() / combine()`);
  }
  const byKey = new Map<string, any>();
  for (const part of chunk(keys)) {
    for (const r of await pgRequest("GET", `${table}?${inFilter(keyField, part)}`)) byKey.set(String(r[keyField]), r);
  }
  const missing = rows.filter((_, i) => !byKey.has(keys[i]));
  for (const r of await postMany(table, missing)) byKey.set(String(r[keyField]), r);
  const still = keys.filter((k) => !byKey.has(k));
  if (still.length) {
    throw new Error(`seedEnsureMany ${table}: ${still.length} row(s) neither found nor returned by the insert: ${preview(still)}`);
  }
  return keys.map((k) => byKey.get(k));
}

/**
 * Index-cycling pick: `pool[i % pool.length]`. The seed-factory primitive — drive each row's values
 * off the row index so a `for (let i = 0; i < target; i++)` loop both hits the count STRUCTURALLY and
 * gives even coverage (every §5 enum value and every pool entry appears in turn). Prefer this over
 * `Math.random()` picking, which can miss enum values and makes coverage non-deterministic.
 */
export const pick = <T>(pool: T[], i: number): T => pool[i % pool.length];

/**
 * Mixed-radix pick across several pools so the row index visits every COMBINATION, not lockstep.
 * `combine(i, [firstNames, lastNames])` → `[ firstNames[i % F], lastNames[⌊i/F⌋ % L] ]`, giving F×L
 * distinct tuples from two small pools (vs. only max(F,L) when both share the same `i`). Compose enough
 * pools that the product of their lengths >= target, and every row's tuple is distinct. Destructure the
 * result: `const [fn, ln] = combine(i, [firstNames, lastNames]);`.
 */
export const combine = <T>(i: number, pools: T[][]): T[] => {
  const out: T[] = [];
  let q = i;
  for (const p of pools) { out.push(p[q % p.length]); q = Math.floor(q / p.length); }
  return out;
};

/**
 * Collision-proof token for a `unique_value` / DB-UNIQUE field (email, code, external id): a base string
 * plus the strictly-increasing row index (and optional suffix). `uniq("ACCT-", i)` → "ACCT-0", "ACCT-1", …;
 * `uniq("ava.chen", i, "@example.com")` → "ava.chen0@example.com", … Never collides because `i` is unique
 * per row. A repeat in a `unique_value` field makes the insert fail with 409 and ABORTS the seed run before
 * the count guard runs — so compose such fields with `uniq` (or `combine` with product >= target), never a
 * bare `pick`.
 */
export const uniq = (base: string, i: number, suffix = ""): string => `${base}${i}${suffix}`;

/**
 * Seed-count guard (the mechanized form of the Stage 6 "the count is not optional"
 * contract). Each seeded table must hit its RESOLVED target: `defaultTarget` for
 * most, or a per-table override in `perEntity`. Overrides cover BOTH directions and
 * both sources:
 *   - a user-named per-table count   →  { customers: { target: 20 } }
 *     (from a reply like "12 each but 20 customers": defaultTarget=12, override on customers)
 *   - required-FK-id scarcity (fewer than target real ids for a required FK)
 *                                    →  { approvals: { target: 4, reason: "only 4 users exist" } }
 * The check is driven by `tables` — the full list of ELIGIBLE (newly-created) tables
 * that MUST be seeded — NOT by whatever the agent happened to tally. That is
 * load-bearing: a counts-only loop cannot see a table the agent seeded ZERO times
 * (forgot entirely), so "every new table gets N" had no backstop; driving off
 * `tables` catches the omission (a missing table reads as 0 → fails). Prints a
 * per-table receipt and **exits non-zero** (halting the seed script) if any eligible
 * table missed its target (including a table never seeded), or if an override or a
 * tally names a table not in `tables` (a typo). This is what makes the count
 * un-skippable — agents kept eyeballing row arrays and under-seeding (18 vs 50,
 * 2-3 per entity), or silently skipping a whole table.
 */
export function assertSeedCounts(
  counts: Record<string, number>,
  defaultTarget: number,
  perEntity: Record<string, { target: number; reason?: string }>,
  tables: string[],
): void {
  const fails: string[] = [];
  // Every ELIGIBLE table must hit its resolved target (a table missing from `counts`
  // reads as 0 → fails; this is the omitted-table check a counts-only loop can't do).
  for (const name of tables) {
    const o = perEntity[name];
    const want = o ? o.target : defaultTarget;
    const tag = o ? ` (override ${o.target}${o.reason ? `: ${o.reason}` : ""})` : "";
    const n = counts[name] ?? 0;
    if (n === want) console.log(`  ✓ ${name}: ${n}${tag}`);
    else fails.push(`${name} seeded ${n}, expected ${want}${tag}${name in counts ? "" : " — table never seeded"}`);
  }
  // Author errors: an override or a tally for a table that isn't in the eligible set.
  for (const name of Object.keys(perEntity)) {
    if (!tables.includes(name)) fails.push(`${name} has an override (${perEntity[name].target}) but is not in the eligible-table list`);
  }
  for (const name of Object.keys(counts)) {
    if (!tables.includes(name)) fails.push(`${name} was seeded but is not in the eligible-table list (typo?)`);
  }
  if (fails.length) {
    console.error(`\nSEED COUNT FAILURE — ${fails.length} problem(s):`);
    for (const m of fails) console.error(`  🛑 ${m}`);
    console.error("Seed every eligible table to its resolved target, then re-run.");
    process.exit(1);
  }
  console.log(`\nAll ${tables.length} eligible table(s) seeded to target.`);
}

/**
 * Halting harness. Run the bespoke orchestration inside this; it OWNS the
 * try/catch so the agent's script can't add a swallow-and-continue one. On
 * success: a summary line plus a reminder that the "model is live" line waits
 * for Stage 5 verification. On any thrown error: the loud halt message and a
 * NON-ZERO process exit, so the operator sees the failure and re-runs. Never
 * prints a success-shaped result over a partial deploy.
 */
export async function runDeploy(orchestration: () => Promise<void>): Promise<void> {
  try {
    await orchestration();
    console.log(
      `\n${writeCount} write call(s) applied with no errors (a bulk call counts once). ` +
      "Run Stage 5 verification before reporting the model live.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nDEPLOY HALTED after ${writeCount} write call(s): ${msg}`);
    console.error(
      "The deploy is INCOMPLETE. Fix the cause and re-run — every op is idempotent, " +
      "so re-running never double-creates and reconciles forward from where it stopped.",
    );
    process.exit(1);
  }
}
