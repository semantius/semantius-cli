# Deploy script template (modeler reference)

_Read this when Stage 4 needs a script — i.e. any deploy with prose-bearing payloads, many writes, or conditional logic over the live catalog (the common case). The stage map is in SKILL.md; the per-stage write rules are in `stage-4-execute.md`. This file shows how to assemble the script around the committed primitives in [`deploy-lib.ts`](./deploy-lib.ts); it does not re-paste them._

## The one rule this file exists to enforce

**A partial deploy must read as a failure, never as success.** The deploy's recovery model is re-run convergence (every write is read-before-write and idempotent; there is no transaction or rollback). That only works if a partial failure is **loud** — the operator sees "incomplete, re-run" and re-runs. The single way it breaks is a script that swallows an error, keeps going, and prints a success-shaped summary over a half-finished catalog. That is the `intgov-inventory` regression: `createEntityIfMissing` / `addFieldIfMissing` helpers that wrapped every call in a bare `catch`, reported success, and were ~40% complete.

## Use the committed primitives — do not re-implement them

There are **two committed resources** — copy both into the scratch dir and import them; re-typing either per deploy is the transcription step that shipped the `intgov-inventory` regression:

- [`deploy-lib.ts`](./deploy-lib.ts) — the schema-AGNOSTIC primitives (loud `write`, exit-code-aware `read1` / `readMany` / `readIn`, the create-or-read `ensure` and its bulk twins `ensureMany` / `ensurePairs` / `createMany`, the Layer-2 `postMany` / `seedEnsureMany`, the halting `runDeploy`). Knows no column names, so it never changes.
- [`scaffold-lib.ts`](./scaffold-lib.ts) — the schema-COUPLED, version-stamped baseline-scaffold builder (`scaffoldModule`, one array call per row kind) + a live-schema `preflightSchemas` guard. Bakes in module / permission / role column names, so it is bumped in lockstep with the platform.

```bash
mkdir -p .tmp_deploy
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/deploy-lib.ts"   .tmp_deploy/deploy-lib.ts
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/scaffold-lib.ts" .tmp_deploy/scaffold-lib.ts
# author .tmp_deploy/deploy_<slug>.ts (below), then:
bun run .tmp_deploy/deploy_<slug>.ts
```

> **Large deploys: run in the background, and re-run if it's killed — there is no progress file because none is needed.** Writes are batched (ALL entities in one `create_entity` call, all of an entity's fields in one `create_field` call, the baseline scaffold as one call per row kind), so a ~12-entity model is roughly 1 `create_entity` + ~12 `create_field` calls plus the read-before-write sweeps and per-field drift updates — on the order of 60-80 CLI calls at ~1-3s each, i.e. a couple of minutes, not the "hundreds of sequential writes" of the one-record-per-call era. That can still exceed a default 2-3 minute tool timeout. Two operational rules:
> 1. **Run `bun run` as a background process** (or with a generously raised tool timeout) so the harness does not kill it mid-deploy. The per-call latency is not the lever — the CLI's own `MCP_TIMEOUT` defaults to 30 minutes; the wrapping *tool* timeout is what cuts a foreground run short.
> 2. **If a run is killed partway, just re-run the SAME script.** Every write is read-before-write and idempotent (Cardinal rule #1), so already-created entities and fields read back as existing and are skipped, and the script reconciles forward from wherever it stopped. A bulk call is one transaction: either every row of that call landed or none did, so a kill never leaves half a batch. The live catalog IS the checkpoint — there is deliberately no `.deploy-progress.json` and none is wanted (a progress file would duplicate live state and risk trusting a stale copy over it). **Never hand-finish a partial deploy** by inspecting which entities exist and creating the rest manually; that is the exact error-prone path the re-run convergence model exists to remove.

`deploy-lib.ts` is the schema-agnostic surface:

| Export | Use for | Guarantee |
|---|---|---|
| `read1(tool, filters)` | read-before-write existence checks for ONE row | `0` → row, `1` → `null` (the create branch), `2/3/4/5` → **throws**. Never a `try/catch` probe. Never with an `in.()` filter (several matches exit `2`) — that is `readIn`. |
| `readMany(tool, filters)` | live field dumps for the diff, dedup | array (`[]` = none); throws on transport/tool/auth error |
| `readIn(tool, column, values, extraFilter?)` | the read-before-write sweep for a SET of records: `column=in.(…)`, chunked ≤100 keys per call | array in DB order (index it by key, never zip by position); `[]` for no keys with no call |
| `write(tool, payload, label?)` | every single-record `create_*` / `update_*` / POST/PATCH, and id-array `update_*` / `delete_*` (`{ id: [...], data }`) | payload over stdin (prose-safe); **throws on any non-zero exit**; never adds `--single` |
| `ensure(readTool, filters, writeTool, data)` | create-if-missing for ONE record that returns the real row (with its id) | re-reads by natural key; never trusts a create response for the id. Pass **raw fields** as the `data` arg — `ensure` wraps them in `{data}` for the write, so do NOT pre-wrap: `ensure(..., "create_entity", { table_name, ... })`, never `{ data: {...} }` (that double-wraps to `{data:{data:...}}` and the create fails). `write()` is the opposite — it takes the full payload, so there you DO pass `{ data: f }`. |
| `createMany(tool, rows, keyOf?)` | the bare bulk create: ONE `create_*` call per ≤100 raw rows (`{data: [...]}` added by the lib) | one request, one transaction, all-or-nothing per call; asserts the row count back; throws naming the chunk's keys; **no per-row fallback**. Prefer `ensureMany`, which wraps it in the read-before-write. |
| `ensureMany(readTool, keyColumn, keyOf, writeTool, rows, extraFilter?)` | create-if-missing for a whole SET of one kind (all entities of the spec, all fields of an entity, all §6 links) → `Map<key, liveRow>` | one `in.()` read → ONE `create_*` call for the missing rows only → one re-read for the ids (never off the create response). Same **raw rows** rule as `ensure`. Rejects duplicate keys; throws if a created key still reads back missing. |
| `ensurePairs(readTool, colA, colB, writeTool, rows)` | create-if-missing for link rows keyed by a pair (`permission_hierarchy`, `role_permissions`, `user_roles`) | reads by `colA=in.(…)`, matches pairs locally, ONE `create_*` call for the missing pairs, re-reads |
| `updateEntity(tableName, data)` | the update half of create-or-diff (entity column patches: `select_rule`, `computed_fields`, `module_id`, `label_parent`, …) | **owns the `update_entity` envelope** so you never hand-roll it: `table_name` is TOP-LEVEL, the changed columns go under `data`. Pass just the table name + the partial patch (`updateEntity("tickets", { select_rule })`); never write `{ table_name, data: {...} }` by hand and never bury `table_name` inside the patch. Blind PATCH — pair with a `read1`/`readMany` diff. |
| `postMany(path, rows)` / `seedEnsureMany(path, rows, keyField)` | Layer-2 seed inserts: ONE `postgrestRequest` POST per ≤100 rows (re-run-safe variant reads the keys first) | every row must carry the SAME key set (asserted); returns the rows WITH ids; never `--single`. See `stage-6-sample-data.md`. |
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
import { read1, readMany, readIn, write, ensure, ensureMany, ensurePairs, updateEntity, runDeploy } from "./deploy-lib";
import { scaffoldModule, verifyScaffold, preflightSchemas } from "./scaffold-lib";

runDeploy(async () => {
  // 0. Preflight the tools THIS script hand-authors (scaffoldModule preflights its own). Fails loud on a
  //    stale field name (e.g. `name` vs `role_name`) BEFORE any write. List EVERY key your payloads send so
  //    a stray one is caught — and NEVER list `required` (mandatory is `input_type: "required"`, not a
  //    `required` column — the #1 from-memory trap) or `is_nullable` (platform-computed from `format`).
  //    Preflight only the CREATE payloads you hand-author (the keys you list are the data-LEVEL columns).
  //    Do NOT preflight `update_entity` / `update_field` — their shape is owned by `updateEntity()` and the
  //    composite-`id` rule, and `update_entity` keys `table_name` at the TOP level (not under `data`), so
  //    listing it here would false-fail against the tool's `data` schema.
  await preflightSchemas({
    create_entity: ["table_name", "singular_label", "module_id", "view_permission", "edit_permission",
                    "edit_mode", "cube_mode", "order_column", "id_column", "icon_url"],
    create_field:  ["table_name", "field_name", "format", "reference_table", "width", "searchable",
                    "input_type", "default_value", "precision", "cube_type", "singular_label_parent",
                    "plural_label_parent"],
  });

  // 1. Baseline module scaffold — module (+ provenance) + permissions + hierarchy + roles + the six FK
  //    wires, all idempotent. Replaces hand-rolling §2a-scaffold steps 1-5 (where orphan roles, null
  //    module FKs, and missing provenance kept creeping in). Pass parsed §8.1 baseline descriptions,
  //    §9.1 role slugs, and the Stage-2.5 scope; "basic" auto-skips the admin tier:
  const cfg = {
    module: { module_slug: "<slug>", module_name: "<System Name>", description: "<tagline>",
              catalog_module_code: "<code>", domain_code: "<DOMAIN>", icon_name: "<icon>",
              // home_page / logo_color: pass ONLY when the frontmatter carries them (both optional).
              // A provided logo_color is written verbatim; omit it to let the cosmetic fallback (step 2) fill an empty live value.
              // home_page: "<frontmatter home_page>", logo_color: "<frontmatter logo_color>",
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
  //    RACI roles, and the cosmetic logo_color fallback (fires ONLY when the frontmatter omitted logo_color
  //    AND the live value is empty — never overwrites a provided value, which scaffoldModule already wrote).
  //    scaffoldModule covers ONLY the baseline tiers; these stay here per stage-4 — as SETS: all workflow-gate
  //    permissions in one ensureMany("read_permission", "permission_name", …, "create_permission", rows),
  //    all extra hierarchy edges in one ensurePairs(...), all persona grants in one ensurePairs(...).

  // 3. ENTITIES FIRST — every ✨-new / rename-incoming / promote-create payload (4c checklist: module_id from the
  //    scaffold, provenance stamped, computed_fields/validation_rules [] for now, NO label_parent) goes into ONE
  //    create_entity call. Nothing below creates a field until this resolves, so every reference_table already
  //    exists when 4d runs: self-references, cross-references, targets declared later in §3, promote-create rows
  //    in the master module (same array, different module_id). There is NO second pass.
  const entities = await ensureMany("read_entity", "table_name", (r) => r.table_name, "create_entity", entityRows);
  //    entities.get("<t>") is the LIVE row (id, module_id, …) — ids never come off the create response.
  //    ♻️ same-module / 🛑 merge / promote-existing hosts are NOT in entityRows: they need create-OR-DIFF, so read1
  //    the live row and `updateEntity(t, { ...drifted })` per host (each patch differs, so these stay per entity).
  //    The helper owns the `{table_name, data}` shape (table_name TOP-LEVEL, columns under data) — never hand-roll it.

  // 4. FIELDS — per entity, only after step 3: one read_field dump (the diff source), the missing set in ONE
  //    create_field call, one update_field per drifted field (each patch differs), verified by re-read.
  //    fieldRows[t] already has the reserved-name guard, the presence-conditional FK skip and the computed-field
  //    `disabled` override applied (4d).
  for (const t of Object.keys(fieldRows)) {
    const live = await readMany("read_field", `table_name=eq.${t}`);
    const liveBy = new Map(live.map((f) => [f.field_name, f]));
    const missing = fieldRows[t].filter((f) => !liveBy.has(f.field_name));
    await ensureMany("read_field", "field_name", (f) => f.field_name, "create_field", missing, `table_name=eq.${t}`);
    for (const f of fieldRows[t]) {
      const l = liveBy.get(f.field_name); if (!l) continue;
      const patch = diffField(f, l);                                   // the 4d property list
      if (Object.keys(patch).length) await write("update_field", { id: `${t}.${f.field_name}`, data: patch });
    }
  }
  //    Same data for several fields → ONE id-array call, e.g. the label columns that carry the `unique` marker:
  if (uniqueLabelIds.length) await write("update_field", { id: uniqueLabelIds, data: { unique_value: true } });

  // 5. Rules + Spine pass — computed_fields / validation_rules (4e) and select_rule / input_type_rule (4f) via
  //    updateEntity(t, {...}) / update_field per entity (each payload differs), then label_parent via
  //    updateEntity(t, { label_parent }) when live differs — all after their fields exist. 4g built-in extensions
  //    and 4h §6 links: one create_field call each, keyed by the composite id:
  //    ensureMany("read_field", "id", (f) => `${f.table_name}.${f.field_name}`, "create_field", rows).

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

// ❌ A loop of single-record creates — N round trips, N partial-failure points, and against the platform rule
//    ("more than one record of the same kind pending → ONE call"). Collect the rows, then ensureMany / createMany.
for (const f of fields) await write("create_field", { data: f });         // ← wrong: one array call instead
for (const e of entityRows) await ensure("read_entity", `table_name=eq.${e.table_name}`, "create_entity", e);  // ← wrong, AND
//    it is the interleave (entity, its fields, next entity, …) that made a field referencing a later entity fail

// ❌ --single with an array — the CLI rejects it (exit 1, SINGLE_ARRAY_INPUT); a bulk response is always an array.
await pgRequest("POST", "/leads", rows, true);                            // ← use postMany(...)

// ❌ Ids off a bulk create response — the response is a receipt; ensureMany's Map (a re-read) is the id source.
const created = await createMany("create_entity", rows); const id = created[0].id;   // ← use ensureMany(...).get(key)

// ❌ Per-row fallback after a failed bulk call — a failed call landed NOTHING; fix the cause and re-run.
try { await createMany("create_field", rows); } catch { for (const f of rows) await write("create_field", { data: f }); }
```

Reserve `catch` for one deliberate, narrow case: a single retry of a known-transient exit `3` — and before that retry, re-read (a lost response is the common exit-3 case; a blind resend of a bulk call would 409 on the rows that landed). Never as control flow, never to continue past a write.

## Cardinal rules (recap)

1. **Read before every write** via `read1` (exit-code-aware), never a `try/catch` existence probe.
2. **Every write is loud** — `write` throws on any non-zero exit.
3. **The script halts on the first failure** — `runDeploy` exits non-zero with the "incomplete, re-run" message. No catch-and-continue inside the callback.
4. **Never print success over a partial deploy** — the success line is reachable only on a clean resolve, and even then the "model is live" line waits for Stage 5.
5. **Provenance on every create** — module per the 4a checklist, entity per the 4c checklist.
6. **Fields and entities are diffed, not skipped** when they already exist (4d).
7. **Use `scaffoldModule()` for the baseline scaffold** — it builds the module, permissions, hierarchy, roles, and (the step most often hand-dropped) the six module-record FK wires + `access_scope` in one idempotent call, and self-preflights its field names. Hand-rolling §2a-scaffold steps 1-5 is what produced orphan roles (`origin: "user"`, null `module_id`) and a `user:read` module header across past deploys. Stage 5 still verifies the result.
8. **End with `verifyScaffold(cfg)`** — the mechanized self-audit re-reads live and asserts the scaffold, and **throws on drift so a failed audit halts the deploy exactly like a failed write**. This is what makes "finished" contingent on the scaffold actually being correct, instead of a Stage 5 spot-check that gets skipped. (It is a mechanical check; it does not catch "built the wrong thing" — that needs an independent reviewer.)
9. **Batch every set of records of one kind, and create every entity before any field.** All entities of the spec go out in ONE `create_entity` call (`ensureMany`), all of an entity's fields in ONE `create_field` call, the baseline scaffold as one call per row kind (`scaffoldModule` does this), same-data updates as one id-array call. No field is created until every entity of the deploy exists — that is what lets a field reference an entity declared later in the spec, a self-reference, or a promote-create row resolve immediately (there is no second pass). A loop of single-record creates is a defect, not a style choice.

## Where the script lives, and cleanup

Per SKILL.md "Generated artifacts": the bespoke `deploy_<slug>.ts` and the copied `deploy-lib.ts` + `scaffold-lib.ts` all live under `<cwd>/.tmp_deploy/`, run with `bun run`. Delete the scratch dir on success; **leave it in place and report its path on failure** so the user can inspect. Never write deploy scratch into the skill folder (it is read-only at runtime) or the model file's directory. The committed `deploy-lib.ts` / `scaffold-lib.ts` in the skill folder are the sources you copy *from*, never files you run in place or edit.
