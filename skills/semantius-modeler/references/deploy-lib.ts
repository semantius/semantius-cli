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
