# semantic-model-deployer — changelog

The deployer's `EXPECTED_MAJOR` and the parser version are bumped in lockstep with the analyst skill (`semantic-model-analyst`). This file records the deployer-side delta for each analyst minor / major bump. The current `EXPECTED_MAJOR` constant and the routing rules for older / newer majors live in [SKILL.md](./SKILL.md) under "Schema compatibility"; this file records how the deployer's behavior changed when each contract change landed.

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## `v2.2` — read-side sub-blocks (`Input type rules`, `Select rule`)

Files written by analyst `2.2+` may carry two new optional §3 sub-blocks per entity: **`Input type rules`** (a JSON array of `{field, jsonlogic, description?}` entries that bind dynamic UI-mode overrides to specific fields — same shape as `Computed fields` / `Validation rules`) and **`Select rule`** (a single JsonLogic object that drives a `FOR SELECT` row-level security policy on the entity).

Both are platform features that already exist server-side; the analyst skill v2.2 made them addressable from the model file. The deployer applies them in **Stage 4f** ("Apply read-side rules") after fields exist, via `update_field` (per `Input type rules` entry) and `update_entity` (per `Select rule`). Missing headings mean no rule (both columns default to `{}` on the platform); the deployer never silently clears an existing live rule when the model omits a heading (same drift-handling rule as `computed_fields` / `validation_rules`).

Stage 4 sub-stages were renumbered in this release to remove the legacy `4d-bis` smell. The mapping is:

| Was | Now | Purpose |
|---|---|---|
| 4a | 4a | Module |
| 4b | 4b | Permissions and hierarchy |
| 4c | 4c | Entities |
| 4d | 4d | Fields |
| 4d-bis | **4e** | Apply write-side rules (computed_fields, validation_rules) |
| — | **4f** | (NEW) Apply read-side rules (select_rule, input_type_rule) |
| 4e | **4g** | Built-in extensions |
| 4f | **4h** | Cross-model link suggestions |

Defense-in-depth check: the Stage 1 parser walks every `Select rule` sub-block's `description` and the entity's §3 prose for bypass-shaped phrases (*"bypass"*, *"elevated"*, *"override"*, *"see every"*, *"unrestricted"*) and permission tokens (`<slug>:<suffix>`). For every permission token named in prose, the JsonLogic body must literally reference that token. For every bypass phrase, either the JsonLogic body must encode the bypass OR the model must carry a §7-resolved architectural-decision entry naming a documented broadening mechanism. A prose claim that doesn't reconcile with the JsonLogic body is a 🛑 High blocker — the deployer never deploys a rule the analyst's Stage 12.5 audit should have caught.

Major stays at `2`; v2.1 files contain neither sub-block and parse cleanly under v2.2 with no behavior change.

---

## `v2.0` (MAJOR) — mandatory `### Permissions summary` table

Files written by analyst `2.0+` carry a mandatory `### Permissions summary` table under `## 2` (after the entity-summary table and the Mermaid diagram). This table is the canonical source for the module's permission catalog and its hierarchy rows. The deployer reads the table directly in Stage 2a (module + permissions setup) and creates every `create_permission` + `create_permission_hierarchy` call from it; the legacy parallel enumeration in §8 step 1 is gone in v2.0 files (§8 step 1 just points the deployer at the §2 table). v1.x files lack this table and are refused; route the user back to analyst Mode D Rebuild to materialize the v2 file from the v1 content.

Parse-time validation that previously checked §8 step 1 now checks the §2 table directly. See SKILL.md "Parse the Permissions summary table" for the column shape and the full validation list.

`EXPECTED_MAJOR` bumped from `1` to `2` in lockstep with the analyst skill.

---

## Earlier versions

Earlier deployer revisions tracked analyst v1.x updates (per-entity `Edit permission:` annotations, workflow-permission scan integration, conditional-permission `require_permission` cross-checks). These predate the dedicated CHANGELOG and live only in git history; consult the analyst's CHANGELOG for the corresponding contract-change descriptions.
