# Deploy script template (modeler reference)

_Read this when Stage 4 needs a script — i.e. any deploy with prose-bearing payloads, many writes, or conditional logic over the live catalog (the common case). The stage map is in SKILL.md; the per-stage write rules are in `stage-4-execute.md`. This file shows how to assemble the script around the committed primitives in [`deploy-lib.ts`](./deploy-lib.ts); it does not re-paste them._

## The one rule this file exists to enforce

**A partial deploy must read as a failure, never as success.** The deploy's recovery model is re-run convergence (every write is read-before-write and idempotent; there is no transaction or rollback). That only works if a partial failure is **loud** — the operator sees "incomplete, re-run" and re-runs. The single way it breaks is a script that swallows an error, keeps going, and prints a success-shaped summary over a half-finished catalog. That is the `intgov-inventory` regression: `createEntityIfMissing` / `addFieldIfMissing` helpers that wrapped every call in a bare `catch`, reported success, and were ~40% complete.

## Use the committed primitives — do not re-implement them

There are **two committed resources** — copy both into the scratch dir and import them; re-typing either per deploy is the transcription step that shipped the `intgov-inventory` regression:

- [`deploy-lib.ts`](./deploy-lib.ts) — the schema-AGNOSTIC primitives (loud `write`, exit-code-aware `read1` / `readMany`, the create-or-read `ensure`, the halting `runDeploy`). Knows no column names, so it never changes.
- [`scaffold-lib.ts`](./scaffold-lib.ts) — the schema-COUPLED, version-stamped baseline-scaffold builder (`scaffoldModule`) + a live-schema `preflightSchemas` guard. Bakes in module / permission / role column names, so it is bumped in lockstep with the platform.

```bash
mkdir -p .tmp_deploy
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/deploy-lib.ts"   .tmp_deploy/deploy-lib.ts
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/scaffold-lib.ts" .tmp_deploy/scaffold-lib.ts
# author .tmp_deploy/deploy_<slug>.ts (below), then:
bun run .tmp_deploy/deploy_<slug>.ts
```

`deploy-lib.ts` is the schema-agnostic surface:

| Export | Use for | Guarantee |
|---|---|---|
| `read1(tool, filters)` | read-before-write existence checks | `0` → row, `1` → `null` (the create branch), `2/3/4/5` → **throws**. Never a `try/catch` probe. |
| `readMany(tool, filters)` | live field dumps for the diff, dedup | array (`[]` = none); throws on transport/tool/auth error |
| `write(tool, payload)` | every `create_*` / `update_*` / POST/PATCH | payload over stdin (prose-safe); **throws on any non-zero exit** |
| `ensure(readTool, filters, writeTool, data)` | create-if-missing that returns the real row (with its id) | re-reads by natural key; never trusts a create response for the id |
| `runDeploy(fn)` | wrap the whole orchestration | owns the `try/catch`; loud non-zero halt on any throw; success line only on clean resolve |

`scaffold-lib.ts` adds the schema-coupled layer (version-stamped; bumped with the platform):

| Export | Use for | Guarantee |
|---|---|---|
| `scaffoldModule(cfg)` | the entire baseline scaffold (module + permissions + hierarchy + roles + the six FK wires + provenance) in one idempotent call | self-preflights its tools' field names; returns the resolved `{moduleId, permissionIds, roleIds}`; `scope: "basic"` skips the admin tier |
| `preflightSchemas({tool: [keys]})` | assert your hand-authored payloads' field names against the LIVE tool schema before writing | throws naming the available keys (kills the `name`-vs-`role_name` class) |
| `verifyScaffold(cfg)` | the executable self-audit — re-reads live and asserts the Stage 5 scaffold checks as code | returns findings for the report; **throws on any drift**, so run as the last step inside `runDeploy` and a failed audit halts the deploy |

## Orchestration skeleton (the bespoke part you author)

```typescript
// .tmp_deploy/deploy_<slug>.ts
import { read1, readMany, write, ensure, runDeploy } from "./deploy-lib";
import { scaffoldModule, verifyScaffold, preflightSchemas } from "./scaffold-lib";

runDeploy(async () => {
  // 0. Preflight the tools THIS script hand-authors (scaffoldModule preflights its own). Fails loud on a
  //    stale field name (e.g. `name` vs `role_name`) BEFORE any write. List EVERY key your payloads send so
  //    a stray one is caught — and NEVER list `required` (mandatory is `input_type: "required"`, not a
  //    `required` column — the #1 from-memory trap) or `is_nullable` (platform-computed from `format`).
  await preflightSchemas({
    create_entity: ["table_name", "singular_label", "module_id", "view_permission", "edit_permission"],
    create_field:  ["table_name", "field_name", "format", "reference_table", "width", "input_type"],
  });

  // 1. Baseline module scaffold — module (+ provenance) + permissions + hierarchy + roles + the six FK
  //    wires, all idempotent. Replaces hand-rolling §2a-scaffold steps 1-5 (where orphan roles, null
  //    module FKs, and missing provenance kept creeping in). Pass parsed §8.1 baseline descriptions,
  //    §9.1 role slugs, and the Stage-2.5 scope; "basic" auto-skips the admin tier:
  const cfg = {
    module: { module_slug: "<slug>", module_name: "<System Name>", description: "<tagline>",
              catalog_module_code: "<code>", domain_code: "<DOMAIN>", icon_name: "<icon>",
              settings: { module_kind: "<kind>", naming_mode: "<mode>", catalog_snapshot: "<iso>" } },
    scope: "full" as const,   // "basic" | "full"
    permissions: { read: "<§8.1 read desc>", manage: "<§8.1 manage desc>" /*, admin: "<desc>" when full */ },
    roles: {
      viewer:  { slug: "<§9.1 viewer slug>",  role_name: "<…>", description: "<…>" },
      manager: { slug: "<§9.1 manager slug>", role_name: "<…>", description: "<…>" },
      // admin: { … } only when the module has an admin tier AND scope is "full"
    },
  };
  const { moduleId, permissionIds, roleIds } = await scaffoldModule(cfg);
  // moduleId / permissionIds / roleIds are resolved for the entity creates below.

  // 2. Non-baseline RBAC (if any) — workflow-gate §8.1 permissions, extra §9.1 hierarchy edges, persona /
  //    RACI roles, and the cosmetic logo_color fallback. scaffoldModule covers ONLY the baseline tiers;
  //    these stay here via ensure / write per stage-4.
  // 3. Entities — apply each plan bucket decision (built-in / reuse / same-module / merge / rename / promote).
  //    ✨-New: `const e = await ensure("read_entity", `table_name=eq.<t>`, "create_entity", {..., module_id: moduleId});`
  //    ensure() returns the row WITH its id (never read the id off a create response — that logs id=undefined).
  //    Stamp provenance on that payload (4c checklist); defer label_parent to the Spine pass. ♻️ same-module /
  //    🛑 merge need create-OR-DIFF (read live, update drifted keys) — ensure() is create-if-missing only, so
  //    there use read1 + update_entity (keyed by `table_name`, NOT `id`).
  // 4. Fields per entity — readMany("read_field", `table_name=eq.<t>`) once, create-or-diff (4d, not create-if-missing).
  // 5. Rules + Spine pass — computed_fields / validation_rules / select_rule / input_type_rule and
  //    label_parent, all after their fields exist.

  // 6. Self-audit (un-skippable, the last step). Re-reads live and asserts the scaffold matches cfg;
  //    THROWS on any drift, so runDeploy halts and the success line cannot print over a broken scaffold.
  //    The returned findings feed the Stage 5 report (entities/fields stay Stage 5's manual check).
  const audit = await verifyScaffold(cfg);
  for (const x of audit) console.log(`${x.severity === "warn" ? "🟡" : "✓"} ${x.check} — ${x.detail}`);
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
7. **Use `scaffoldModule()` for the baseline scaffold** — it builds the module, permissions, hierarchy, roles, and (the step most often hand-dropped) the six module-record FK wires + `access_scope` in one idempotent call, and self-preflights its field names. Hand-rolling §2a-scaffold steps 1-5 is what produced orphan roles (`origin: "user"`, null `module_id`) and a `user:read` module header across past deploys. Stage 5 still verifies the result.
8. **End with `verifyScaffold(cfg)`** — the mechanized self-audit re-reads live and asserts the scaffold, and **throws on drift so a failed audit halts the deploy exactly like a failed write**. This is what makes "finished" contingent on the scaffold actually being correct, instead of a Stage 5 spot-check that gets skipped. (It is a mechanical check; it does not catch "built the wrong thing" — that needs an independent reviewer.)

## Where the script lives, and cleanup

Per SKILL.md "Generated artifacts": the bespoke `deploy_<slug>.ts` and the copied `deploy-lib.ts` + `scaffold-lib.ts` all live under `<cwd>/.tmp_deploy/`, run with `bun run`. Delete the scratch dir on success; **leave it in place and report its path on failure** so the user can inspect. Never write deploy scratch into the skill folder (it is read-only at runtime) or the model file's directory. The committed `deploy-lib.ts` / `scaffold-lib.ts` in the skill folder are the sources you copy *from*, never files you run in place or edit.
