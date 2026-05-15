# semantic-model-deployer — changelog

The deployer's `EXPECTED_MAJOR` and the parser version are bumped in lockstep with the analyst skill (`semantic-model-analyst`). This file records the deployer-side delta for each analyst minor / major bump. The current `EXPECTED_MAJOR` constant and the routing rules for older / newer majors live in [SKILL.md](./SKILL.md) under "Schema compatibility"; this file records how the deployer's behavior changed when each contract change landed.

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## `v3.0` (MAJOR) — master modules, module scaffold, shared-entity promotion

`EXPECTED_MAJOR` bumped from `2` to `3` in lockstep with the analyst skill.

Files written by analyst `3.0+` may carry two new authoring conventions on top of `2.x`: an optional `module_type: master` frontmatter directive (default `"domain"` when absent), and an optional per-entity `**Shared master cluster:** <name>` annotation in §3 alongside `**Edit permission:**` / `**Audit log:**`. Both are forward-compatible additions: pre-3.0 model files parse against a 3.0 deployer with both fields defaulted. However, a pre-3.0 deployer reading a 3.0 master-typed model would silently create a regular domain module instead of a master, producing the wrong shape rather than a missed optimization — the major bump is the honest signal that the two skills must move in lockstep.

**Module scaffold standardization.** Every module (domain or master) now carries a standard scaffold: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (`<slug>_viewer`, `<slug>_manager`, optionally `<slug>_admin`), and six module-record references (`view_permission` text + `manage_permission_id` / `admin_permission_id` FKs + three default-role-id FKs). Stage 2a-scaffold builds the scaffold idempotently on first deploy and re-deploys; the three-permission upgrade case adds the missing tier additively. Role records gain a `slug` column (snake_case, unique via Postgres index — acts as a natural-key second primary key) and an `origin` enum (`"system"` / `"model"` / `"model_master"` / `"user"`, strictly immutable after INSERT).

**Master module concept.** A new `module_type` enum on the `modules` table (`"domain"` or `"master"`, default `"domain"`) designates master modules — neutral hosts for shared / master data, consumed by multiple domain modules via cross-module `permission_hierarchy` rows tagged `origin = "model_master"`.

**Stage 2d Branch A and Branch B.** The collision gate gains two new branches:

- **Branch A (🟢 shared-master match):** when the incoming entity matches a live entity in a `module_type = "master"` module, the deploy auto-wires the consumer via a cross-module read inclusion (always) and a manage inclusion (per-consumer binary prompt). No collision widget.
- **Branch B (5th collision option):** the existing 4-option collision widget for domain-vs-domain collisions gains "Promote to shared master module" as the 5th option. Picking it moves the entity into a master host (newly created or selected from existing masters), wires up cross-module bridges, and seeds the master's manager role from the original module's manager members. Two follow-up prompts (host module + manage option 1–4) batch into the same `AskUserQuestion` call.

**Analyst-emitted cluster hints.** The optional `**Shared master cluster:** <name>` annotation (parsed in Stage 1) shapes Stage 2d follow-up 1 defaults — recommended existing-master selection or recommended new-module name. The hint is a soft suggestion; the user can always override at the prompt.

**Master models (`module_type: master` frontmatter).** A model file can declare itself a master, formalizing an ad-hoc runtime-promoted master into a properly-modeled domain cluster (more common) or declaring a new master upfront (rare). Stage 2a's master-model branch matches by exact slug first, then by entity overlap; renames the matched master if the user opts in (Stage 4b-rename cascade: ~7–10 writes, forward-recoverable); consolidates multiple sibling masters into a domain cluster (4c-merge-master) by moving entities and re-pointing consumer bridges, leaving source masters as quiet orphans.

**JSON-array merge with `source_module` tagging.** `computed_fields` and `validation_rules` on master entities are now merged across consuming models rather than wholesale-replaced. Natural key is `name` / `code` alone (global within the entity); `source_module` is reconciliation metadata. Conflict on same key from different sources triggers a 🛑 prompt (keep / replace / rename / abort). Domain entities keep wholesale-replacement semantics.

**Stage 4 sub-stages 4i and 4j (new).** 4i creates cross-module `permission_hierarchy` rows tagged `origin = "model_master"` (read inclusions always, manage inclusions per consumer's decision). 4j seeds `<master>_manager` from `<original>_manager` members at promotion time (one-shot, not a dynamic link).

**Stage 4b-rename (new).** Master-model rename cascade: `update_module` + per-tier `update_permission` (codes embed the slug) + per-tier `update_role` (slugs embed the slug). No transaction envelope; forward-recoverable on partial failure.

**Stage 4c-promote and 4c-merge-master (new).** Branch B promotion (entity → master via `update_entity` setting `module_id`) and Path-2 cleanup (entity moves + bridge re-points across multiple source masters).

**No auto-deletion of catalog records.** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. Master-merge leaves source masters as quiet orphans. The deployer does not maintain an orphan registry, does not detect orphans, and does not report them. Symmetric across all catalog-record kinds, all origins, all stages.

**Stage 5 structured verification report.** Replaces the single-line success summary with a structured per-area report: modules, roles (grouped by `origin`), entities, permission hierarchy, merged JSON arrays, counters broken down by `origin`. No orphan section. The compact one-line summary is still emitted for log-parsers; the structured report sits above it.

**Two new gates.** Gate A (pre-write planned-state integrity) fires in Stage 3, verifies the planned end-state object graph is internally consistent before any writes. Gate B (steward seed non-empty) fires in Stage 4 right after 4j seeds the master manager role; if zero members, surfaces a 🟡 and requires explicit user confirmation.

**Origin field protection.** `roles.origin`, `permission_hierarchy.origin`, and system-generated `roles.slug` are audit-trail fields installed via platform validation rules (`origin_immutable_roles`, `origin_immutable_hierarchy`, `system_role_slug_immutable`) tagged `source_module: "platform"`. All three rules use the `value_changed` JsonLogic operator; INSERT-only, no transitions after INSERT regardless of value. The deployer never modifies `origin = "user"` records under any circumstance.

**Slug-collision policy.** When the scaffold pass would create a role with slug X and a role with that slug already exists with `origin = "user"`, the deploy surfaces a 🛑 via `AskUserQuestion` with two options: rename existing user role first (admin renames in UI), or abort. No silent-claim path, no origin flip.

**Stage numbering update.** Stage 4 sub-stages 4i and 4j are added after 4h. Stage 5/6 add the structured verification report and two gates. No existing stage numbers change.

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
