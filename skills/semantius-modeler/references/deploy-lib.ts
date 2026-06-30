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
 * The contract this enforces (all three already in the modeler SKILL.md):
 *   - Failure is loud and halting: `write` throws on any non-zero exit, and
 *     `runDeploy` turns any thrown error into a non-zero process exit with an
 *     "INCOMPLETE — re-run" message. There is no swallow-and-continue path.
 *   - Read before writing: `read1` is exit-code-aware (0 = row, 1 = absent,
 *     2/3/4/5 = real error → throw), never a try/catch existence probe.
 *   - Success is never printed over a partial deploy: the success line is
 *     reachable only when the orchestration callback resolves with zero throws.
 *
 * Not a CLI — import it:
 *   import { read1, readMany, write, runDeploy } from "./deploy-lib";
 */

let writeCount = 0;

/** Count of successful mutating writes so far (feeds the halt / success summary). */
export const writes = (): number => writeCount;

/**
 * Loud mutating call (`create_*` / `update_*` / `delete_*` / `postgrestRequest`
 * POST/PATCH/DELETE). The payload goes over stdin, so no shell quoting layer
 * ever sees the model's prose (backticks, apostrophes, Unicode all travel
 * intact). THROWS on any non-zero exit — a failed write must halt the script.
 */
export async function write(tool: string, payload: unknown): Promise<any> {
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
  if (code !== 0) throw new Error(`write ${tool} failed (exit ${code}): ${err}`);
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

/**
 * Layer-2 (PostgREST) call via the `postgrestRequest` crud tool — the loud
 * transport for business-record reads/writes (the seed script's insert path).
 * NOTE: postgrestRequest's payload field is **`body`**, NOT `data` (`data` is the
 * Layer-1 crud-tool shape; mixing them up is a common trap — this helper owns the
 * difference so call sites never hand-roll `{method, path, data}`). Loud: throws
 * on any non-zero exit. `single` adds `--single` so a POST insert returns the
 * inserted row as a bare object and the CLI fails loudly on the wrong cardinality.
 * Returns parsed JSON (an array without `single`, the bare object with it).
 */
export async function pgRequest(
  method: string, path: string, body?: unknown, single = false,
): Promise<any> {
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

/** Insert one Layer-2 row and return it WITH its id (uses `body` + `--single`). The seed-script default. */
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
      `\n${writeCount} write(s) applied with no errors. ` +
      "Run Stage 5 verification before reporting the model live.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nDEPLOY HALTED after ${writeCount} write(s): ${msg}`);
    console.error(
      "The deploy is INCOMPLETE. Fix the cause and re-run — every op is idempotent, " +
      "so re-running never double-creates and reconciles forward from where it stopped.",
    );
    process.exit(1);
  }
}
