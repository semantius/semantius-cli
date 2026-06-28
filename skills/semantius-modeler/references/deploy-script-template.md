# Deploy script template (modeler reference)

_Read this when Stage 4 needs a script — i.e. any deploy with prose-bearing payloads, many writes, or conditional logic over the live catalog (the common case). The stage map is in SKILL.md; the per-stage write rules are in `stage-4-execute.md`. This file shows how to assemble the script around the committed primitives in [`deploy-lib.ts`](./deploy-lib.ts); it does not re-paste them._

## The one rule this file exists to enforce

**A partial deploy must read as a failure, never as success.** The deploy's recovery model is re-run convergence (every write is read-before-write and idempotent; there is no transaction or rollback). That only works if a partial failure is **loud** — the operator sees "incomplete, re-run" and re-runs. The single way it breaks is a script that swallows an error, keeps going, and prints a success-shaped summary over a half-finished catalog. That is the `intgov-inventory` regression: `createEntityIfMissing` / `addFieldIfMissing` helpers that wrapped every call in a bare `catch`, reported success, and were ~40% complete.

## Use the committed primitives — do not re-implement them

The fixed parts (the loud write transport, the exit-code-aware existence check, and the halting harness) are a tested, committed resource: [`deploy-lib.ts`](./deploy-lib.ts). Re-typing them per deploy is exactly the transcription step that shipped the regression, so don't. Copy the file into the scratch dir and import it:

```bash
mkdir -p .tmp_deploy
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/deploy-lib.ts" .tmp_deploy/deploy-lib.ts
# author .tmp_deploy/deploy_<slug>.ts (below), then:
bun run .tmp_deploy/deploy_<slug>.ts
```

`deploy-lib.ts` exports four things; that is the entire surface you need:

| Export | Use for | Guarantee |
|---|---|---|
| `read1(tool, filters)` | read-before-write existence checks | `0` → row, `1` → `null` (the create branch), `2/3/4/5` → **throws**. Never a `try/catch` probe. |
| `readMany(tool, filters)` | live field dumps for the diff, dedup | array (`[]` = none); throws on transport/tool/auth error |
| `write(tool, payload)` | every `create_*` / `update_*` / POST/PATCH | payload over stdin (prose-safe); **throws on any non-zero exit** |
| `runDeploy(fn)` | wrap the whole orchestration | owns the `try/catch`; loud non-zero halt on any throw; success line only on clean resolve |

## Orchestration skeleton (the bespoke part you author)

```typescript
// .tmp_deploy/deploy_<slug>.ts
import { read1, readMany, write, runDeploy } from "./deploy-lib";

runDeploy(async () => {
  // 1. Module + scaffold (idempotent; canonical detail in stage-2-reconcile.md §2a-scaffold):
  //    a. Module: read1("read_module", `module_slug=eq.<slug>`) → write("create_module", <full 4a
  //       provenance payload>) when null, else update_module to converge provenance. Capture the module
  //       id from the read / a re-read after create — never off the create response.
  //    b. Permissions (§8.1) + hierarchy chain + default roles (§9.1 slugs verbatim).
  //    c. Wire the six module-record FK columns — THE STEP MOST OFTEN DROPPED. After (b), resolve
  //       <slug>:manage (+ :admin when access_scope=full) and the §9.1 viewer/manager/admin role slugs
  //       to ids (read1 by natural key), then write("update_module", {id: mod.id, data: {view_permission:
  //       "<slug>:read", manage_permission_id, default_viewer_role_id, default_manager_role_id,
  //       access_scope /* + admin_permission_id, default_admin_role_id when full */}}). Skip it and the
  //       module header shows "user:read" and the default-role dropdowns are empty (Stage 5 flags it).
  // 2. Entities — apply each plan bucket decision (built-in / reuse / same-module / merge / rename / promote).
  //    ✨-New: read1("read_entity", `table_name=eq.<t>`) → write("create_entity", {data: {...}}) when null.
  //    Stamp provenance on that same payload (4c checklist): catalog_entity_code, entity_type,
  //    catalog_owner_module.
  // 3. Fields per entity — readMany("read_field", `table_name=eq.<t>`) once, then per model field:
  //    create when absent, else write("update_field", {id: `<t>.<f>`, data: <only drifted keys>}).
  //    Create-or-diff, NOT create-if-missing (4d "Don't blind-upsert").
  // 4. Rules — computed_fields / validation_rules / select_rule / input_type_rule, after their fields exist.
});
```

`runDeploy` exits non-zero with the loud "INCOMPLETE — re-run" message if anything throws, and prints the success line only when the callback resolves with zero throws. Relay its output verbatim; never print a "model is live" line over a non-zero exit.

## Even with the lib, don't do this

```typescript
// ❌ A try/catch INSIDE the runDeploy callback defeats the whole point — it lets a failed write be
//    swallowed and the deploy continue. The only catch is the one runDeploy owns.
runDeploy(async () => {
  try { await write("create_field", { data: f }); } catch { /* skip */ }   // ← partial deploy, reported clean
});

// ❌ Create-if-missing with no diff — existing fields/entities never get drifted values updated; re-runs
//    silently fail to converge. Read the live row and update the drifted keys (4d).

// ❌ Hand-rolled Bun.spawn at a call site — that is where divergent, error-swallowing handling creeps in.
//    Go through write / read1 / readMany so every call has the same loud, exit-code-aware behavior.
```

Reserve `catch` for one deliberate, narrow case: a single retry of a known-transient exit `3`. Never as control flow, never to continue past a write.

## Cardinal rules (recap)

1. **Read before every write** via `read1` (exit-code-aware), never a `try/catch` existence probe.
2. **Every write is loud** — `write` throws on any non-zero exit.
3. **The script halts on the first failure** — `runDeploy` exits non-zero with the "incomplete, re-run" message. No catch-and-continue inside the callback.
4. **Never print success over a partial deploy** — the success line is reachable only on a clean resolve, and even then the "model is live" line waits for Stage 5.
5. **Provenance on every create** — module per the 4a checklist, entity per the 4c checklist.
6. **Fields and entities are diffed, not skipped** when they already exist (4d).
7. **Wire the module-record scaffold after the creates** — a discrete `update_module` (by numeric `id`) sets `view_permission`, `manage_permission_id`, `default_viewer_role_id`, `default_manager_role_id` (plus `admin_permission_id` / `default_admin_role_id` when `access_scope = full`) and `access_scope`. Easy to drop because it runs *after* permissions and roles; Stage 5's module-scaffold check verifies it (scaffold step 5).

## Where the script lives, and cleanup

Per SKILL.md "Generated artifacts": the bespoke `deploy_<slug>.ts` and the copied `deploy-lib.ts` both live under `<cwd>/.tmp_deploy/`, run with `bun run`. Delete the scratch dir on success; **leave it in place and report its path on failure** so the user can inspect. Never write deploy scratch into the skill folder (it is read-only at runtime) or the model file's directory. The committed `deploy-lib.ts` in the skill folder is the source you copy *from*, never a file you run in place or edit.
