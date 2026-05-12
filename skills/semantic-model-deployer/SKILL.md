---
name: semantic-model-deployer
description: Safely deploys a *-semantic-model.md file (produced by the semantic-model-analyst skill) to a live Semantius instance using the semantius. Before any writes, reconciles the model against the existing catalog, updates an existing module in place when the slug matches, extends Semantius built-ins (`users`, `roles`, `permissions`, …) additively instead of replacing them, refuses duplicate entity names across modules, and surfaces explicit merge/rename decisions for near-duplicates (e.g. `contracts` vs `saas_contracts` vs `vendor_contracts`). Use whenever a semantic-model file exists and the user wants to deploy, apply, push, sync, integrate, reconcile, or roll out the model, including phrasings like "implement the model", "deploy the model", "apply the schema", "set up the entities", "create the entities in Semantius", "push this to Semantius", "integrate this model with what's already there", or "now make it real". Also trigger when the user uploads or references a *-semantic-model.md and asks to do anything that would materialize it. Trigger proactively when such a file is present and the user's intent is clearly to deploy it.
---

# semantic-model-deployer Skill

This skill bridges the gap between a self-contained semantic model (produced by the `semantic-model-analyst` skill) and a live Semantius instance.

**Division of responsibility:**
- This skill owns the *workflow*, parsing the model, inspecting what's already deployed, diffing, deduplicating against built-ins, **detecting name collisions and near-collisions across the entire entity catalog**, planning, and orchestrating the sequence of steps.
- The **use-semantius skill** owns the *execution*, all Semantius operations are done via the `semantius` CLI tool, following that skill's patterns and reference docs.

## Writing conventions (apply to every output this skill produces)

These rules apply to chat output, plan summaries, verification reports, and anything else this skill writes for the user to read. They are not optional style preferences.

**1. US English spellings, always.** Never British English. Examples that come up often (left = correct US form, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), uncategorized (not `uncategorised`), normalize (not `normalise`), harmonize (not `harmonise`), analyze (not `analyse`). When in doubt between two spellings, pick the `-ize` / `-or` / `-er` form.

**2. No em-dashes (`—`, U+2014).** Banned as a parenthetical break or "and" substitute. Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.` or `X; Y`; `A — B — C` triplet → split into two sentences. The en-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is specifically on `—` used as punctuation. Before writing any file or assistant message, scan for `—` and convert each instance.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?". Use the form that agrees with the singular implicit subject; avoid colloquial elided-auxiliary forms in written text.

**4. Semantius entity-label symmetry.** When this skill writes about or proposes entity labels: `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products`. Field-level titles like "Product Name" go on the auto-created `label` field's `title` via `update_field` (this is what §8 step 5 of the model handles), never on the entity's `singular_label`.

---

## Schema compatibility: `EXPECTED_MAJOR = 2`

This skill expects model files written by `semantic-model-analyst` major `2`. The model file's front-matter `version: "MAJOR.MINOR"` is checked at the start of Stage 1. **Major must equal `EXPECTED_MAJOR`**, minor is informational and not compared. Files with a different major are rejected with a request to update the model via the analyst before retrying.

**`v2.0` contract change.** Files written by analyst `2.0+` carry a mandatory `### Permissions summary` table under `## 2` (after the entity-summary table and the Mermaid diagram). This table is the canonical source for the module's permission catalog and its hierarchy rows. The deployer reads the table directly in Stage 2a (module + permissions setup) and creates every `create_permission` + `create_permission_hierarchy` call from it; the legacy parallel enumeration in §8 step 1 is gone in v2.0 files (§8 step 1 just points the deployer at the §2 table). v1.x files lack this table and are refused; route the user back to analyst Mode D Rebuild to materialize the v2 file from the v1 content. See "Parse the Permissions summary table" below for the column shape and validation rules.

- **Older major** (e.g. file is `"0.x"`, this skill expects `"1.x"`), the file was written by an older analyst version using a structure this deployer no longer understands. Tell the user to run the analyst skill; its archived-knowledge mode reads the older file and re-authors a current-major file from the same semantic content.
- **Newer major** (e.g. file is `"2.x"`, this skill expects `"1.x"`), the file was written by a newer analyst than this deployer knows about. Tell the user to update this deployer skill before retrying.
- **Missing `version` key** (legacy, pre-versioning), treat as major `0`; same response as older-major above.

When the analyst's major bumps, this skill's `EXPECTED_MAJOR` must be bumped in lock-step (same commit when feasible). The two skills are paired; a major mismatch between the skills themselves is a maintainer error, not a user-facing one.

## Your role: gatekeeper of a unified catalog

Semantius is a **unified platform, a universal system of records**. It is **not** a collection of independent silos stitched together. Each semantic model you implement is a *point solution* that drops into a shared catalog of modules, entities and fields. Other point solutions have been, or will be, installed into the same instance.

**Two entities called `contracts` owned by two different modules is exactly the kind of drift that makes the platform unusable for both humans and agents.** The moment the catalog contains ambiguous names, downstream reasoning falls apart: users don't know which table to use, agents pick the wrong one, reports double-count, and FK references point to the wrong concept.

**Cross-model link suggestions.** Closing silos goes beyond name-collision policing. The model's §6 carries a flat hint table of FKs that would add value if the named target entity exists in the catalog (e.g. `incidents → hardware_assets`, `incidents → configuration_items`). For each row, the deployer resolves the `To` against the live catalog: an exact match becomes an additive `create_field` proposal, ambiguity (multiple plausible targets like `vendors` vs `suppliers` vs `saas_vendors`) triggers a single user confirmation, and a missing target is silently skipped. Cross-module changes are strictly additive (new optional FKs); §6 never carries renames, type changes, deletions, or entity-overlap declarations. Entity overlap (vendors-vs-suppliers, contracts-vs-saas_contracts) is detected separately at Stage 2d/2e by inspecting the live catalog. See Stage 2g and Stage 4f.

Your job as the implementer is to **refuse to introduce ambiguity**. Before creating any entity you must:

1. Check whether it already exists as a built-in (see Stage 2b), never replace, may extend additively.
2. Check whether it already exists as a custom entity in this same module (Stage 2c), this is a re-run; update in place.
3. Check whether an entity with the **same** name already exists in a **different** module (Stage 2d), **ambiguity gate; the user must decide merge vs rename before you proceed.**
4. Check whether an entity with a **similar** name exists anywhere (Stage 2d), **ambiguity gate; the user must decide.**

Never silently coexist conflicting names. Never pick a side for the user. Resolving catalog ambiguity is the single most important thing this skill does.

**This skill is designed to be re-run whenever the model changes.** Because it always inspects Semantius before acting, re-running on an updated model is safe, it diffs the new model against what's already deployed and applies only the delta (new entities, new fields, updated labels/enums). If a module with the same `system_slug` already exists, **always update that module**, never create a duplicate. Things that haven't changed are skipped. Things in Semantius that are no longer in the model are left alone.

**The model is self-contained.** The semantic-model file produced by `semantic-model-analyst` declares every entity the domain needs, including ones that happen to overlap with Semantius built-ins (e.g. `users`, `roles`, `permissions`, `webhook_receivers`). Those built-ins are platform infrastructure, they control authentication, RBAC, and integration, and **must never be replaced**. They *may* be extended additively (new fields on `users`, for instance). See Stage 2b.

---

## Step 0: Load the use-semantius Skill

Before doing anything else, read the use-semantius skill and its data-modeling reference:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
```

The data-modeling reference gives you the mandatory creation order, all field formats, the Golden Rules, and exact CLI syntax. Everything in the execution stages below follows those patterns. Also read `references/cli-usage.md` if you need help with CLI invocation, piping, or error handling.

All Semantius operations in this skill are performed using the **`semantius` command-line tool**, for example:

```bash
semantius call crud read_module '{"filters": "name=eq.lead_manager"}'
semantius call crud create_entity '{"data": {...}}'
```

---

## High-Level Workflow

```
1. Parse PRD  →  2. Inspect Semantius  →  3. Plan & Present  →  4. Execute  →  5. Verify  →  6. Sample Data?
```

Work through each stage in order. Narrate what you're doing at each step.

---

## Stage 1: Parse the semantic model

Locate the `*-semantic-model.md` file. The very first check is the schema-version gate; everything else only runs if the version is compatible.

- **`version`** from YAML frontmatter, required. Compare its **major** part against this skill's `EXPECTED_MAJOR` (see "Schema compatibility" near the top of this file). Major equal → proceed. Major older or missing → stop with a message naming the file's version, this skill's expected major, and the recommended next step (run the analyst's audit mode to migrate). Major newer → stop and ask the user to update this skill. Do not parse the rest of the file when the gate fails; mismatched majors mean the file's structure may not match what the rest of Stage 1 assumes.

Once the version gate passes, extract the rest:

- **`system_slug`** from YAML frontmatter, this is the module name
- **Human-readable system name**, from the top-level heading (`# ... — Semantic Model`)
- **Entity list**, from the §2 entity summary table, in order
- **Per-entity details** from each §3 entity subsection:
  - `table_name`, `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`
  - Fields: `field_name`, `format`, required, `title` (= Label column), reference targets, delete modes
  - Enum values from §5
  - **`**Audit log:**`** line, when present (default `no` when absent or empty).
  - **`**Edit permission:**`** line, when present (analyst skill v1.10+). Accepted values:
    - `manage` (default, also the value when the line is absent) → `edit_permission = <system_slug>:manage`.
    - `admin` (analyst v1.10+) → `edit_permission = <system_slug>:admin`.
    - `<narrow_suffix>` matching a `Type: workflow-narrow` row in the §2 Permissions summary (analyst v2.1+) → `edit_permission = <system_slug>:<narrow_suffix>`. The parser checks the §2 table for a row whose `Permission` cell equals `<system_slug>:<narrow_suffix>` and whose `Type` is `workflow-narrow`; if no such row exists, this is a 🛑 High blocker (undeclared narrow tier).

    Carry the resolved value through to Stage 4c's `create_entity` call. The line is **not** required, files written by older analyst minors (1.9 or earlier) carry no annotation; treat every entity as `manage` in that case (the legacy two-permission baseline).
  - **`Computed fields`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `name` (existing scalar field on this entity), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`.
  - **`Validation rules`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `code` (snake_case, unique within entity), `message` (required), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`. JsonLogic in this array may invoke two platform-extension operators introduced in analyst skill v1.11: `{"value_changed": "<field>"}` (true when the field's value differs from `$old`, true on INSERT) and `{"require_permission": "<permission_code>"}` (returns `true` when the caller holds the permission, throws otherwise). Both are passed through verbatim, no special encoding. **However**, the deployer must cross-check every `require_permission` argument against the §2 **Permissions summary** table (the canonical source as of v2.0): collect every distinct `<permission_code>` referenced across all entities' `validation_rules`, verify each one appears as a `Permission` row in the table. Mismatch is a 🛑 High blocker (see the precedence table below); refuse to deploy and send the user back to the analyst skill rather than calling `create_permission` ad hoc, the analyst's audit should have caught this and the model may have other gaps if it didn't.
- **Relationship table** (§4), confirms `reference_delete_mode` for each FK field
- **§2 Mermaid diagram**, sanity-check it agrees with §3/§4 (the model's own audit should have caught mismatches; if it disagrees here, flag for the user before proceeding rather than silently picking one side)
- **§6 Cross-model link suggestions**, parse the §6 markdown table into a list of rows, each carrying `{from_table, to_concept, verb, cardinality, delete_mode}`. Defaults: `cardinality = "N:1"` and `delete_mode = "clear"` when the column is absent or empty; `verb` is required and never defaulted. If §6 reads "No cross-model link suggestions.", the list is empty and Stages 2g and 4f are no-ops. The `related_domains` front-matter is informational only (a discovery tag for humans browsing the catalog); the deployer does not consume it.
- **§7 Open questions**, scan both sub-sections. **§7.1 🔴 Decisions needed is a gate**: if any entry is present and unresolved, stop before Stage 4 and list the blockers to the user; ask them to either (a) answer each question so the model can be updated first via the semantic-model-analyst skill, or (b) explicitly waive and proceed at their own risk. Do not make up answers, and do not silently proceed. **§7.2 🟡 Future considerations is informational only**, note them for the user but do not block.
- **Permissions summary** (`### Permissions summary` sub-section under `## 2`, mandatory in analyst v2.0+) — parse the table verbatim. Five columns in this fixed order: `Permission | Type | Description | Used by | Hierarchy parent`. Build a `permissions` index from the rows; each entry `{permission, type, description, used_by, hierarchy_parent}`. The deployer's Stage 2a (module + permissions setup) creates one `create_permission` call per row in table order, using the `Permission` and `Description` cells. After all permissions exist, the deployer iterates the index once more and issues one `create_permission_hierarchy` call per row whose `hierarchy_parent` is non-`—`, with `parent_permission = hierarchy_parent` and `child_permission = permission`. **Parse-time validation** (all 🛑 High blockers, reject before any write):
  - exactly one row with `Type: baseline-read` and `Permission = <slug>:read`;
  - exactly one row with `Type: baseline-manage` and `Permission = <slug>:manage`;
  - at-most-one row with `Type: baseline-admin` and `Permission = <slug>:admin`;
  - every `Type` value in `{baseline-read, baseline-manage, baseline-admin, workflow, workflow-narrow}` (the `workflow-narrow` value was added in analyst v2.1; files stamped older than `2.1` that include it should not exist in the wild, refuse and route to the analyst);
  - every `Hierarchy parent` cell either `—` or a `Permission` value that also appears in the table;
  - **no `Type: workflow` (elevated) row whose `Hierarchy parent` is `<slug>:manage`** — rolling an elevated permission under `manage` auto-grants every manager the gated authority and defeats the conditional check;
  - **every `Type: workflow-narrow` row's `Hierarchy parent` is `<slug>:manage` or higher in the baseline chain (`<slug>:admin` is acceptable *only if* it transitively includes `manage`)** — a `workflow-narrow` row whose `Hierarchy parent` is `—` is a blocker (the narrow tier would not be reachable by `manage` holders, inverting intent); a `workflow-narrow` row whose `Hierarchy parent` is `<slug>:admin` in a model where `admin` does *not* roll up to `manage` is also a blocker.

  **Cross-check against the rest of the parse** (also blockers):
  - every `require_permission(<code>)` argument referenced across all `validation_rules` appears as a `Permission` row;
  - every entity carrying `**Edit permission:** admin` appears in the `baseline-admin` row's `Used by` cell (and vice versa);
  - every entity carrying `**Edit permission:** <narrow_suffix>` (analyst v2.1+) has `<slug>:<narrow_suffix>` declared as a `Type: workflow-narrow` row, AND the entity appears in that row's `Used by` cell;
  - every `Type: workflow` (elevated) row is invoked by at least one `require_permission` rule;
  - every `Type: workflow-narrow` row is consumed by at least one entity's `Edit permission:` annotation OR invoked by at least one `require_permission` rule.

  The table is the canonical source — when the table and a §3 / §8 reference disagree, the table wins and the disagreement is a defect surfaced to the user.
- **Implementation notes** (§8), always follow these. **In v2.0 files, §8 step 1 references the §2 Permissions summary table rather than enumerating permissions inline.** Read §8 for the procedural sequence (module creation order, label-column fixups, dedup-against-builtin, etc.) but read the Permissions summary table for the permission catalog itself.

### Model-to-Entity Mapping

| Model line | `create_entity` / `update_entity` parameter |
|---|---|
| `table_name` (§3 heading) | `table_name` |
| Singular / Plural labels | `singular_label` / `plural_label` |
| Description | `description` |
| Label column | `label_column` |
| `**Audit log:** yes \| no` | `audit_log` (boolean; omit or pass `false` when the model says `no` or is silent) |
| `**Edit permission:** manage \| admin \| <narrow_suffix>` (analyst v1.10+ for `manage`/`admin`; v2.1+ for narrow; absent = `manage`) | `edit_permission`: `"<system_slug>:admin"` when the line says `admin`; `"<system_slug>:<narrow_suffix>"` when the line names a bare suffix that matches a `Type: workflow-narrow` row in the §2 Permissions summary (Stage 1 has already validated this); otherwise `"<system_slug>:manage"`. `view_permission` is always `"<system_slug>:read"`. For files without the line (pre-v1.10), every entity gets `"<system_slug>:manage"` — the legacy two-permission baseline. |
| `**Edit mode:** auto \| sidebar \| modal \| page` (when present) | `edit_mode` (omit when absent, defaults to `auto`) |
| `**Cube mode:** disabled \| auto` (when present) | `cube_mode` (omit when absent, defaults to `disabled`) |
| `**Computed fields**` JSON block (when present) | `computed_fields` (array; omit or pass `[]` when absent. Sent verbatim — the deployer never edits, reorders, or merges entries.) |
| `**Validation rules**` JSON block (when present) | `validation_rules` (array; omit or pass `[]` when absent. Sent verbatim.) |

> `searchable` and `is_child` on the entity are read-only / auto-computed by the platform. **Never** pass them on `create_entity` / `update_entity`.

### Model-to-Field Mapping

| Model column | `create_field` parameter |
|---|---|
| Field name | `field_name` |
| Format | `format` (text formats include `string`, `text`, `multiline`, `html`, `code`; `string` and `text` render single-line inputs, `multiline` renders a `<textarea>`. All five store as Postgres `TEXT`. Format **can** be changed after `create_field`, but **only within the same primitive type** — `text → multiline → html` is safe (all `TEXT`), `text → date` is rejected. Surface a cross-primitive mismatch between model and live as a hard block; a same-primitive mismatch can be reconciled via `update_field`. See the format-rule below.) |
| Label | `title` |
| → `table` | `reference_table` |
| Delete mode from §4 | `reference_delete_mode` |
| Notes annotation `relationship_label: "<verb>"` (FK rows), must equal the §2 Mermaid edge label `\|<verb>\|` for the same FK | `relationship_label` |
| Notes annotation `parent label: "<singular>" / "<plural>"` (parent FK rows only) | `singular_label_parent` / `plural_label_parent` |
| Notes annotation `cube_type: <value>` | `cube_type` (omit when absent, defaults to `auto`) |
| Notes annotation `default: "<value>"` | `default_value` |
| **Description** column (5th column in §3 field tables, analyst v1.8+) | `description` (read the cell verbatim, pass to `create_field`. Blank cell ⇒ omit / pass `""`. Free-form prose found in the Reference / Notes column is **not** mapped — that's an analyst authoring error per the v1.8 convention; surface as a 🟡 to the user and recommend running the analyst's audit pass before redeploying.) |
| Enum values from §5 | `enum_values` |

> **Default-value guard (re-deploy safety).** Before issuing `create_field` for a **required** field on an **existing entity that already holds rows**, verify a default is supplied. Postgres rejects `ALTER TABLE ... ADD COLUMN ... NOT NULL` (and CHECK-constrained enums in particular) on a non-empty table when no default exists, with `(23514) check constraint "..._check" of relation "..." is violated by some row`. Specifically:
> - For required enums: `default_value` MUST be present in the model and be one of the listed `enum_values`. If the §3 Notes don't carry a `default: "<value>"` annotation, stop and surface this as a 🔴, ask the analyst skill to set one (convention: first enum value, the initial lifecycle state).
> - For required non-FK scalars on a non-empty existing entity: same, refuse to add the column without a default, surface the gap, and ask before proceeding.
> - For required FK fields on a non-empty existing entity: there is no meaningful default. Stop and ask whether to add the column nullable (drop "required") or backfill the FK to a chosen target row before re-running.
> - For brand-new entities (created in this run, zero rows): no guard needed, defaults are nice-to-have but the create won't fail without them.
> Run a quick `read_entity` / `count` against the live table to determine whether it has rows; do not assume.

> **Verb consistency check.** When the §2 Mermaid edge for an FK is labeled `|owns|` but the §3 Notes for that FK has no `relationship_label: "..."` annotation (or a different verb), stop and surface this as a mismatch, do not silently pick one side. The diagram label and the field metadata must agree. The optimizer regenerates the diagram from `relationship_label`, so a mismatch here means the round-trip will lose information.

> The §3 `Required` column is captured as author intent in the model document but is **not** passed to `create_field`. The platform manages nullability internally based on format and delete-mode semantics, do not send an `is_nullable` (or equivalent) parameter.

### Fields That Are Auto-Generated: Never Create These

`create_entity` automatically creates these, skip them when iterating over model fields:

- `id`, `label`, `created_at`, `updated_at`
- The field named in `label_column` (auto-created with `ctype: label`)

> **Title correction:** The auto-created `label_column` field gets its title from `singular_label`. If the model specifies a different title for that field, use `update_field` to fix it after entity creation.

### Self-References

Fields that reference their own entity (e.g., `campaign.parent_campaign_id → campaigns`) must be created in a second pass after all entities exist. Flag them during parsing.

---

## Stage 2: Inspect the Unified Catalog

**Read before writing, always.** (use-semantius Golden Rule #1)

This stage does four things in order: (a) resolve the module, (b) inspect built-ins, (c) load the full entity catalog, (d) classify every model entity and surface ambiguity.

### 2a. Resolve the module: update if it already exists

Look up the module by its slug (lowercase URL handle), since `system_slug` is the model's URL-shaped identifier:

```bash
semantius call crud read_module '{"filters": "module_slug=eq.<system_slug>"}'
```

> **Module schema note.** Modules carry both a **`module_name`** (unique human-facing display name shown in the UI selector and landing page header, keep acronyms as acronyms, e.g. `CRM`, `ITSM`, `CMDB`) and a **`module_slug`** (lowercase URL/permission handle, e.g. `crm`, `itsm`, `cmdb`). The earlier `alias` field is **removed**. `module_name` maps to the model's `system_name`; `module_slug` maps to the model's `system_slug`; the module's `description` maps to the model's `system_description` (compact tagline, ≤40 chars, e.g. `Customer Relationship Management`). The §1 Overview prose does **not** go on the module record, it is too long for the selector chip; keep it in the markdown file only.

- **Exists** → plan an `update_module` to refresh `module_name`, `description`, and (if missing on the existing record) `module_slug`, drawing them from the model's `system_name`, `system_description`, and `system_slug` respectively. Capture the existing `module_id` to reuse. **Never create a second module with the same slug.** On re-run, also reconcile permissions: if the model now requires `<system_slug>:admin` (per Stage 1's parsed §3 `**Edit permission:**` annotations) but the live module only has `<system_slug>:read` and `<system_slug>:manage` (the legacy two-permission baseline), plan an additive permission create plus the missing hierarchy row. See Stage 4b for the full reconciliation rules.
- **Missing** → plan a `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<system_description>"`, followed by the permissions and hierarchy rows derived directly from the §2 **Permissions summary** table (parsed in Stage 1):
  - **Create each permission, in table order.** For each row in the table, call `create_permission` with `permission_name = row.Permission` and `description = row.Description`. Permission creation happens before hierarchy because hierarchy rows reference both ends. There is no separate "baseline vs workflow" branching here — the table is a flat list and the deployer iterates it once. The parse-time validation has already enforced shape (exactly one baseline-read row, exactly one baseline-manage row, at-most-one baseline-admin row, valid `Type` values, etc.); if parse passed, this step is mechanical.
  - **Create each hierarchy row.** Iterate the table again and for every row whose `Hierarchy parent` cell is non-`—`, call `create_permission_hierarchy` with `parent_permission = row["Hierarchy parent"]` and `child_permission = row.Permission`. The `manage includes read` baseline chain, the `admin includes manage` rollup (when baseline-admin exists), and every workflow rollup under `<slug>:admin` are all encoded in the table column; the deployer does not need a separate enumeration. Parse-time validation has already rejected any `Hierarchy parent = <slug>:manage` for a workflow row (defeats the conditional gate).

> **Required model keys.** `system_name`, `system_slug`, and `system_description` are all required front-matter keys per analyst skill v1.0+. If the model file is missing `system_description`, stop and route the user back to the analyst skill (Mode B audit) to backfill it before deploying, the deployer will not invent a description.

If the module exists but the user's model genuinely belongs to a different domain and the shared slug is itself the collision, stop and ask, that's a model-level naming problem the analyst skill should fix, not something to paper over.

### 2b. Inspect Semantius built-ins

The semantic model may declare entities that already exist as built-ins (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`, see `use-semantius/references/data-modeling.md` for the authoritative list). **These tables control the platform (authentication, RBAC, integration). They must never be replaced.**

For each built-in referenced by the model:

- **Skip `create_entity`** entirely. The built-in already exists; recreating would break the platform.
- **Reuse as a `reference_table` target** for any FK in the model that points at it.
- **Additive fields only.** If the model declares extra scalar fields on a built-in (e.g. `users.department`, `users.employee_id`), offer them to the user as `create_field` calls. **Never modify existing built-in fields**, never change formats or enum values on a built-in.

### 2c. Load the full entity catalog

Ambiguity detection only works if you can see every entity in the instance, not just the ones in this module. Load the catalog:

```bash
semantius call crud read_entity '{}'
```

Build an index of every existing entity keyed by `table_name`, carrying at least `{module_id, module_name, module_slug, singular, plural, description, label_column}`. The owning module's `module_name` (display) and `module_slug` (URL/permission handle) are both useful: use `module_name` when narrating conflicts to the user ("`vendors` already exists in module CRM"), and `module_slug` when constructing UI links or permission strings. You will use the index in 2d.

### 2d. Classify each model entity

For every entity declared in the model's §2, determine which bucket it falls into. **Buckets marked 🛑 are ambiguity gates, the user must make an explicit decision in Stage 3 before any writes happen.**

| Bucket | Condition | Action |
|---|---|---|
| 🔒 Built-in | `table_name` matches a Semantius built-in | Reuse. Offer additive fields only (see 2b). |
| ♻️ Same-module match | Entity exists and its `module_id` equals our module's id | Re-run case, proceed to field-level diff (see "What to compare" below). |
| 🛑 Cross-module exact name | Entity exists with the **same `table_name`** but `module_id` ≠ our module | **Gatekeeper decision required.** Never silently coexist, see 2e. |
| 🛑 Similar name | An existing entity's `table_name` is *near* a model entity's name (see heuristic below) | **Gatekeeper decision required.** Similarity is a hint, not a verdict; the user decides. |
| ✨ New | No match of any kind | Create normally in Stage 4. |

For field-level checks on a same-module match, run the usual reads:

```bash
semantius call crud read_permission '{"filters": "permission_name=eq.<slug>:read"}'
semantius call crud read_field '{"filters": "table_name=eq.<table_name>&field_name=eq.<field_name>"}'
```

### 2e. Similarity heuristic: when to flag

You, the agent, are responsible for detecting near-names. Flag any pair where:

- One name is a prefix or suffix of the other, `contracts` ↔ `saas_contracts`, `orders` ↔ `sales_orders`
- They share a singular root or a lemma, `contract` ↔ `contracts`, `customer` ↔ `customers`, `vendor` ↔ `vendors`
- They differ only by a domain qualifier, `vendor_contracts` ↔ `saas_contracts`, `support_ticket` ↔ `it_ticket`
- They are obvious synonyms for the same business concept, `customers` ↔ `clients`, `employees` ↔ `staff`, `products` ↔ `items`
- Edit distance is small and the tokens look related (not just typos of unrelated words)

If you're uncertain whether two names refer to the same concept, **flag it**. A false positive costs the user one confirmation click; a missed collision pollutes the catalog permanently and cannot be cleaned up without data migration.

### 2f. For each 🛑, compare the concepts before asking the user

You cannot ask a useful question without first understanding both entities. For every flagged pair, pull the existing entity's fields and build a side-by-side comparison:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<existing_table_name>"}'
```

Note for each:

- Module it lives in, `singular`, `plural`, `description`, `label_column`
- Field names, formats, required-ness
- Overlap: which fields mean the same thing (often same name, sometimes just same concept under a different name)
- Format conflicts on conceptually-same fields (cross-primitive → blocks merge; same-primitive can be reconciled via `update_field` before merge)

This comparison goes into the Stage 3 plan so the user can decide on informed grounds.

### What to compare when a same-module entity already exists

| Property | Risk | Notes |
|---|---|---|
| Field `format` | ⚠️ Medium within primitive, 🛑 High across primitives | Same-primitive changes are accepted by `update_field` (e.g. `text` ↔ `multiline` ↔ `html` ↔ `json` ↔ `email`, all TEXT-backed; `integer` ↔ `number`, both numeric; `date` ↔ `datetime`). Cross-primitive changes (`text → date`, `email → integer`) are rejected by the platform — fall back to a model-level rethink via the analyst skill. Don't maintain a parallel primitive taxonomy here; sync to the model and let Semantius adjudicate. |
| Field `enum_values` | ✅ Low for additive, 🛑 High for removals | Adding values the live row doesn't have is safe (no existing record carries the new value); sync via `update_field`. Removing values the live row still carries is unsafe: existing rows may hold the removed value and the check-constraint tightening will fail. Surface removals in the Stage 3 plan so the user can decide (drop the value and reconcile existing rows first, or keep it in the model). |
| Entity labels, descriptions | ✅ Low | Safely updatable |
| Field `title`, `description` | ✅ Low | Safely updatable |
| Field `required`, `searchable`, `width`, `input_type` | ✅ Low | Safely updatable; sync to model value. |
| Field `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` | ✅ Low | FK metadata is safely updatable; sync to model value. |

### 2g. Resolve §6 cross-model link suggestions against the live catalog

Walk every row in the §6 hint list parsed in Stage 1. For each row `{from_table, to_concept, verb, cardinality, delete_mode}`, resolve `to_concept` against the global entity catalog already loaded in 2c.

Three outcomes per row:

- **Exact match** (one entity in the catalog has `table_name == to_concept`): mark the row ✨ **Proposed**, record the resolved target's `table_name`, `singular`, and owning `module_name` for use in Stage 3 and Stage 4f. Auto-generate the FK column name from the target's singular form using the `<target_singular>_id` convention (e.g. `hardware_assets` becomes `hardware_asset_id`). If a field with that name already exists on `from_table`, mark it 🛑 **Field-name collision** and carry the conflict into Stage 3 for the user to resolve (rename the new FK or skip the row).
- **No match** (no entity has `table_name == to_concept` and no near-name match either): mark 💤 **Dormant**. Skip silently; the target module is not deployed. Do not surface the row in Stage 3.
- **Multiple plausible matches** (no exact match, or an exact match plus near-name candidates): mark 🟡 **Ambiguous**. Run the same similarity heuristic that Stage 2e uses for entity collisions (prefix/suffix/synonym/qualifier, small edit distance with related tokens) over the catalog index, and collect every plausible target. Stage 3 will ask the user to pick one or skip.

Field-source-side check: every row's `from_table` must be a `table_name` that will exist after this deploy completes, on either this module's side (a `table_name` declared in this model's §3) or on a module already in the catalog. If `from_table` is neither in this model's §3 nor in the catalog, surface as a 🛑 **Unresolved source** so the user can fix the model via the analyst skill before Stage 4f tries to create a field on a non-existent table.

Build a `link_proposals` list carrying the resolved rows (Proposed, Ambiguous, Field-name collision, Unresolved source) for Stage 3. Dormant rows do not appear in the plan; they are noted in the verification summary so the user knows how many suggestions were silently parked. Carry that summary into Stage 3 so the user sees the cross-module impact alongside the in-module plan.

---

## Stage 3: Plan and Present (and resolve ambiguity)

Before running any writes, show the user a clear plan. The plan must have two parts: (1) the normal module/permission/entity summary, and (2) **an ambiguity-decisions section if any 🛑 buckets were raised in Stage 2**. No writes happen until every 🛑 has an explicit decision.

### Normal plan (example)

```
📦 Module: saas_expense_tracker
  ✨ Will create (new module)
  🔑 Permissions: ✨ saas_expense_tracker:read, ✨ saas_expense_tracker:manage, ✨ saas_expense_tracker:admin
  🔗 Permission hierarchy: ✨ admin → manage, ✨ manage → read
  🛠 Admin-tier entities (edit_permission = saas_expense_tracker:admin): departments, budget_periods
  🛠 Operational entities (edit_permission = saas_expense_tracker:manage): every other entity below

🗂 Entities (7 total):
  🔒 users — Semantius built-in, reusing (model declares 3 extra fields: `department_id`, `job_title`, `employee_id` — will add additively with user confirmation)
  ✨ vendors — will create + 6 fields
  ✨ subscriptions — will create + 26 fields
  ✨ departments — will create + 5 fields
  ✨ budget_periods — will create + 6 fields
  ✨ budget_lines — will create + 8 fields
  ✨ license_assignments — will create + 7 fields

Total to create: 1 module, 3 permissions, 2 hierarchy rows, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🔗 Cross-model link suggestions (from §6):
  ✨ Propose on `subscriptions`: + `contract_id → contracts` (governs, clear) — pending confirmation
  ✨ Propose on `subscriptions`: + `project_id → projects` (charged to, clear) — pending confirmation
  💤 Skipped (target not in catalog): `subscriptions → cost_allocation_rules`
```

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12) — will update module metadata from the new model; will diff entities and apply only changes`. Render the field-level deltas inline under each ♻️ entity so the user sees exactly what's about to change, not just a vague "will diff" promise:

```
🗂 Entities (7 total):
  ♻️ subscriptions — 26 fields, 4 drifted, 1 new
     ~ vendor_name.description: "Vendor" → "Legal name of the contracting vendor"
     ~ status.enum_values: + "renewed", + "expired"
     ~ amount.searchable: false → true
     ~ contract_url.format: text → html (same primitive, accepted)
     + renewal_date (date, optional)
  ♻️ vendors — 6 fields, no drift
  ✨ budget_lines — will create + 8 fields
```

Use `~` for drifted properties (with `old → new`), `+` for additions, and surface `🛑` separately for anything that blocks the fast-path (enum removals, cross-primitive format changes, field deletions, tier flips). The 🛑 deltas route through the normal Stage 3 ambiguity dialog; the `~` and `+` deltas are informational and apply automatically once the plan is approved (or under the clean re-run fast-path, immediately).

### Cross-model link suggestions (additive, reversible)

§6 link proposals are **additive and reversible**: adding an optional cross-module FK never breaks the local module, never deletes data, and can be removed later by editing the model and redeploying. Because of that the deployer's posture is *err toward implementing*. Don't drag the user through individual confirmation when the analyst has already drafted a hint and the target exists in the catalog.

**Print the link-proposal summary as prose first** (the same `🔗 Cross-model link suggestions` block from the normal plan), so the user has the list in front of them before any widget appears.

**Resolve Ambiguous rows first.** Any rows marked 🟡 Ambiguous in Stage 2g (multiple plausible targets matched the `To` concept) gate which proposals are even askable. Batch one question per ambiguous row into a single `AskUserQuestion` call. Each question's options list the candidate target tables (with their owning module for context) plus a "skip this row" option. After the user picks, the Ambiguous rows that resolved promote into the ✨ Proposed list and the rest drop out.

**Resolve Field-name collisions next.** Any row marked 🛑 Field-name collision in Stage 2g (the auto-generated `<target_singular>_id` already exists on `from_table`) is also batched into the same `AskUserQuestion` call. Options: provide an alternative field name (the runtime's "Other" slot accepts free text) or skip the row. Unresolved-source rows are also surfaced here for the user to fix the model via the analyst skill before this stage retries.

**Then approve the Proposed list.**

- **0 proposals**, skip this section entirely; nothing to ask.
- **1–3 proposals**, present inline with one combined confirmation: *"Apply these N cross-model link suggestions? [yes / review each / skip all]"*. Default branch on `yes` is "apply all".
- **4 or more proposals**, call `AskUserQuestion`:

  - **question**: `"Found N cross-model link suggestions whose target is in the catalog. How should I handle them?"`
  - **header**: `"Cross-model links"`
  - **multiSelect**: `false`
  - **options** (in this order, recommended first):
    1. label `"Apply all (recommended)"`, description `"Add every proposed FK in one pass. Each is an additive optional column on this model's tables, reversible later by dropping the field. This is the default for a connected catalog."`
    2. label `"Review each one"`, description `"Walk through each proposal individually. Use when the catalog is unfamiliar or when one of the suggestions touches a sensitive shared table."`
    3. label `"Skip all"`, description `"Land the in-module changes now and skip every link proposal. The proposals will re-surface on the next deploy unless removed from the model's §6."`

**On `Apply all`**, Stage 4f executes every Proposed row without further prompts.

**On `Review each one`**, fall back to one batched `AskUserQuestion` with one question per proposal (yes / skip), then Stage 4f executes only the accepted ones.

**On `Skip all`**, Stage 4f is a no-op. The dormant rows and the explicitly-skipped ones are noted in the verification summary so the user knows nothing was wired up.

This flow is **distinct from the 🛑 ambiguity protocol below for entity name collisions**. Entity-name ambiguity gates are blockers; the deploy cannot proceed until the user picks merge / rename / etc. Link proposals are not blockers; skipping them lets the deploy proceed unchanged. Keep the two flows separate.

### Ambiguity decisions (required when any 🛑 was raised)

**Every 🛑 decision must be taken via the `AskUserQuestion` tool**, not via prose options the user has to type back ("a or b"). Structured widgets remove the letter-mapping friction, survive multi-decision flows cleanly, and match how the `semantic-model-analyst` skill handles its own big decision. Never propose a default silently.

**The protocol for each 🛑:**

1. **Print the comparison block first as prose**, so the user has the facts in front of them before the widget appears. Comparison blocks carry information; the tool carries only the choice.
2. **Then call `AskUserQuestion`** with the decision as a single question. Use 4 explicit options; the runtime auto-adds an "Other" slot you can use for free-text renames or "abort".
3. **Batch multiple 🛑 gates into one `AskUserQuestion` call** with one question per gate. Never drip decisions one turn at a time. Never squash two decisions into the same prose paragraph (the screenshot of "(a or b) and (yes/no)" is exactly the failure mode this directive prevents).

**Example, comparison block (prose, shown first):**

```
⚠️ Ambiguity: `contracts`

  Incoming (this model → module `saas_expense_tracker`):
    Purpose: A signed commercial agreement for a SaaS subscription
    Label column: contract_number
    Fields: contract_number, signed_date, total_contract_value,
            renewal_notice_days, vendor_id (→ vendors), signatory_user_id (→ users)

  Existing (module `facility_management`, created 2026-01-14):
    Purpose: Lease and service agreements for physical properties
    Label column: contract_number
    Fields: contract_number, effective_date, termination_date,
            landlord_id (→ landlords), property_id (→ properties),
            monthly_rent

  Overlap: both share `contract_number` (string). Other fields are disjoint;
  the entities model different concepts that happen to share an English word.
```

**Example, the matching `AskUserQuestion` call:**

- **question**: `"How should I resolve the name collision on `contracts`?"`
- **header**: `"Ambiguity: contracts"`
- **multiSelect**: `false`
- **options** (4; the runtime appends Other):
  1. label `"Rename incoming → saas_contracts"`, description `"Keep the two concepts isolated. Recommended when they are genuinely different — the facility-management lease is not the same thing as a SaaS subscription agreement."`
  2. label `"Rename both (saas_contracts + facility_contracts)"`, description `"Most conservative. Removes ambiguity entirely by marking the catalog explicitly domain-scoped. High-risk second half — renaming the existing entity touches live records and FKs."`
  3. label `"Merge into existing `contracts`"`, description `"Treat as the same entity. Non-overlapping fields are added additively. Only safe when the two truly represent the same business concept (does not look like it here)."`
  4. label `"Rename existing → facility_contracts"`, description `"Keep the incoming name as `contracts`. High-risk — touches live records and any FK pointing at the existing table; may require data migration. Confirm twice before proceeding."`

The auto-"Other" slot handles: the user wants to abort, or the user wants a different custom name than the four suggested ones.

### If multiple 🛑 were raised

Send them all in **one** `AskUserQuestion` call as separate questions in the `questions` array. The comparison blocks print as prose in order above the tool call; the widgets appear as independent choices. Do not chain one-question calls across turns, that's exactly the pattern that produced the confusing "(a or b) and (yes/no)" UX.

### For similar-name flags

Use the same protocol; phrase the question to make clear the match is a *heuristic*, not a verdict (e.g. `"Does `lease_contracts` in this model refer to the same concept as the existing `contracts`?"`). Include the heuristic that matched (prefix/suffix/synonym/qualifier) in the comparison block so the user can judge whether it's a real collision or a coincidence.

### Fallback: when `AskUserQuestion` isn't available

If the tool is not available in the harness, fall back to labeled prose options with the same content, but present **exactly one decision per turn**, not multiple. Use clearly labeled choices ("A", "B", "C", "D", "Other, specify") and wait for the user's reply before moving to the next decision. Never combine multiple decisions into one prose prompt.

### Merge / rename rules

**Merge (a):**

- Do a field-by-field mapping. For each incoming field, either point it at an existing field with the same meaning, or add it as a new field on the existing entity.
- **Format mismatch on a conceptually-same field is a hard block only when the primitives differ.** Same-primitive mismatches (`text` vs `multiline`, both `TEXT`) can be reconciled with an `update_field` to align formats before the merge proceeds. Cross-primitive mismatches (one side `text`, the other `date`) cannot be reconciled; fall back to rename.
- The merged entity stays in its current module (keeps existing records and FKs intact). The incoming model's module just references it.

**Rename incoming (b):**

- Pick a qualifier from the model's domain (`saas_`, `hr_`, `billing_`) and propose it. The user may override.
- **Rewrite every reference in the plan before any Stage 4 writes.** Purely in-memory, no live data exists yet for the incoming entity, so this is safe as long as it's *complete*:
  - The entity's `table_name` in the plan
  - **Every field in this model where `reference_table` equals the old name.** Fields in *other entities in this same model* that point at the renamed entity (e.g. `license_assignments.subscription_id → subscriptions` when renaming `subscriptions` → `saas_subscriptions`) silently break if this step is missed, they'd end up pointing at a non-existent table.
  - Relationship prose in the plan summary
  - Mermaid diagram node + edge names
- The source `.md` file is left unchanged unless the user explicitly asks the analyst skill to update it.

**Rename existing (c):**

- **High-risk.** Confirm twice. The data-modeling reference calls `table_name` immutable, so `update_entity` may reject the rename outright. If it does, stop immediately and offer option (a) merge or (d) rename-both as fallback. Never attempt DDL directly.
- **No catalog-side FK fix-up is needed.** Semantius propagates renames automatically, every `reference_table` in the catalog that pointed at the old name is updated by the platform as part of the rename. Do not scan, do not issue `update_field` calls for existing FKs. Your only job is to request the rename and confirm it succeeded.
- Incoming fields in *this* model that point at the renamed entity must still use the new name, that's an in-memory plan rewrite (same mechanic as option (b)) and happens before Stage 4 writes.

**Rename both (d):**

- Apply (b) to the incoming entity, then (c) to the existing one. Only the (b) half needs a `reference_table` rewrite (in-memory, across this model). The (c) half's catalog-side FKs are repointed by the platform automatically.

Do not proceed to Stage 4 until every 🛑 has a recorded decision. Restate the resolved plan once before executing.

**Exception:** If there are zero built-in overlaps, zero cross-module collisions, zero similar-name flags, and the module doesn't exist yet, proceed immediately: "No existing model found and no catalog collisions, creating everything from scratch now."

**Clean re-run fast-path.** If the module already exists but every diff is all-green — no removed enum values, no cross-primitive format changes, no field deletions, no `edit_permission` tier flips, no cross-module collisions, no §6 ambiguities — print the delta summary inline and proceed without a confirmation prompt. Example: *"Re-run against existing `saas_expense_tracker` module: 0 entities to create, 3 entities to update (7 fields drifted, all safe). Applying now."* The user still sees exactly what changed; they just don't have to click through a gate that has nothing risky in it. Any single 🛑 (enum removal, cross-primitive format, removed field, tier flip, collision) cancels the fast-path and routes back to the normal Stage 3 dialog.

---

## Stage 4: Execute

Follow the use-semantius mandatory creation order exactly:

```
Module → Permissions → Entities → Fields (per entity, in model order)
```

Refer to `use-semantius/references/data-modeling.md` for the exact CLI syntax for each operation. **Before executing, apply every ambiguity decision from Stage 3** to the in-memory plan, renames propagate to every `reference_table` and relationship reference in the model. The sequence:

**4a. Module**, If missing, `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<system_description>"`. If it already exists, `update_module` to refresh those three fields from the model (and to add `module_slug` if the existing record is missing it). Never create a duplicate module with the same `module_slug`. The `alias` field is gone, do not pass it.

**`logo_color` fallback.** After the create-or-update, read the module's live `logo_color`. If it is empty (`""` or null), compute one random dark shade of red, green, blue, or orange at runtime and write it back via `update_module`. Use HSL so the dark-and-readable constraint is enforced uniformly across hues, then convert to hex.

Recipe:

1. Pick a hue family uniformly from `{red, green, blue, orange}`, then pick a hue degree uniformly from that family's band:
   - Red: `H ∈ [350, 360] ∪ [0, 10]`
   - Orange: `H ∈ [20, 40]`
   - Green: `H ∈ [100, 150]`
   - Blue: `H ∈ [205, 240]`
2. Pick saturation `S ∈ [55, 90]` (%) — saturated enough to read as a real color, not muddy.
3. Pick lightness `L ∈ [18, 30]` (%) — the dark band; below 18 gets crushed to near-black, above 30 stops reading as "dark".
4. Convert HSL to hex (`#rrggbb`, lowercase, 6 digits) and write via `update_module`.

Only fill the gap — never overwrite a `logo_color` the user (or an earlier deploy) already set. This is purely a cosmetic guardrail so module selector chips get a dark, readable backdrop instead of the platform's empty-string default. Picking a fresh shade per deploy means re-runs against the same empty-state module will land different colors; that's intentional — once set, it sticks, and the user can override at any time.

**4b. Permissions and hierarchy**, Determine the required permission set from Stage 1's parsed §3 `**Edit permission:**` annotations: if any entity carries `admin`, the model needs three permissions (`<slug>:read`, `<slug>:manage`, `<slug>:admin`); otherwise two (`<slug>:read`, `<slug>:manage`). For each required permission, `read_permission` first; `create_permission` only for the missing ones. Pass `description` strings that match the tier semantics: `read` → *"View <System Name> data"*; `manage` → *"Create, update, and delete operational <System Name> records"*; `admin` → *"Create, update, and delete reference / configuration <System Name> records"*.

Then ensure the **permission hierarchy chain** exists via `create_permission_hierarchy` so higher tiers transitively grant lower ones (see use-semantius `references/rbac.md` § "Set Up Permission Hierarchy"):

- For three-permission models: `parent_permission_id` = `<slug>:admin`, `child_permission_id` = `<slug>:manage`; AND `parent_permission_id` = `<slug>:manage`, `child_permission_id` = `<slug>:read`.
- For two-permission models: `parent_permission_id` = `<slug>:manage`, `child_permission_id` = `<slug>:read`.

`read_permission_hierarchy` first with `parent_permission_id=eq.<parent_id>&child_permission_id=eq.<child_id>` to check whether the row already exists (re-runs are idempotent). Create only missing rows. **Never invert direction** (child including parent breaks RBAC).

**Re-run reconciliation.** When the module already exists with the legacy two-permission baseline but the current model has been upgraded to need three (any §3 entity now carries `**Edit permission:** admin`), the deploy adds the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row additively. Surface this in the Stage 3 plan as `✨ saas_expense_tracker:admin` and `✨ admin → manage` so the user can see the upgrade. Never delete or rename existing permissions or hierarchy rows.

**4c. Entities**, Walk model §2 in order and apply each entity's bucket decision:

- 🔒 Built-in → skip entirely. Do not `create_entity` for `users`, `roles`, etc. The §3 `**Edit permission:**` annotation, if any, has no effect on built-ins.
- ♻️ Same-module match → skip `create_entity`. If the model's `**Audit log:**`, `**Edit permission:**`-derived `edit_permission`, `singular_label`, `plural_label`, `description`, **`computed_fields`**, or **`validation_rules`** differ from the live entity, call `update_entity` to sync. Treat `computed_fields` and `validation_rules` as **wholesale replacements**: send the model's array as-is, the platform replaces (does not merge). When the model carries the heading but with an empty array, pass `[]` so the platform drops any existing trigger; when the model omits the heading entirely, omit the key from the `update_entity` payload (do not silently clear an array a maintainer added live, unless the model authoritatively states there should be none — see "Conflict Resolution Reference"). For `edit_permission` specifically: read the live entity's current `edit_permission` first, and only `update_entity` when the resolved permission name (e.g. `<slug>:admin` vs `<slug>:manage`) differs; surface the change to the user in the Stage 3 plan as a tier flip so they can sanity-check (a tier flip is a real RBAC change). Then fall through to 4d (field diff).
- ✨ New → `create_entity`. Pass `audit_log` from the §3 `**Audit log:**` line (default `false` when the line is missing or says `no`). Pass `view_permission: "<system_slug>:read"` and `edit_permission` derived from the §3 `**Edit permission:**` line: `"<system_slug>:admin"` when the line says `admin`, `"<system_slug>:manage"` otherwise (default, or when the line is absent in a pre-v1.10 file). Pass `computed_fields` and `validation_rules` from the §3 sub-blocks (default `[]` when absent). After creation, correct the `label_column` field title if needed with `update_field`.
- 🛑 Resolved as **merge** → skip `create_entity`. The target is the existing entity in the other module. Record the mapping; the merge is realized in 4d by adding the non-overlapping fields additively to the existing entity.
- 🛑 Resolved as **rename incoming** → `create_entity` using the new name. (Plan-level rewrite of `reference_table` values has already happened before this stage.)
- 🛑 Resolved as **rename existing** → attempt `update_entity` on the existing entity's `table_name` first, before any new creates. If the platform rejects the rename, stop and return to Stage 3, never continue silently. Once the rename succeeds, Semantius repoints every catalog-side `reference_table` automatically; no follow-up `update_field` pass is needed.
- 🛑 Resolved as **rename both** → do the existing-rename first, then `create_entity` for the incoming under its new name.
- 🛑 Resolved as **abort** → stop Stage 4 entirely; tell the user to iterate on the model with the analyst skill.

**4d. Fields**, For each entity, create missing fields in model order with `create_field`. Skip auto-generated ones (`id`, `label`, `created_at`, `updated_at`, and the `label_column` field). Always include `width: "default"` and `input_type: "default"`. For FK fields whose `reference_table` is a built-in (`users`, `roles`, …) or a merged existing entity, point directly at that `table_name`, the platform doesn't care whose module owns it.

**Computed-field columns are deployed as `input_type: "readonly"`.** Before issuing each `create_field`, check whether its `field_name` appears in the parent entity's `computed_fields[].name` list. If yes, override `input_type` to `"readonly"` instead of `"default"`, regardless of anything else the model says about that field's input_type. The platform silently overwrites caller-supplied values for any column listed in `computed_fields` (see use-semantius `references/data-modeling.md` § "Evaluation semantics" — *"Caller-supplied values for a computed field are silently overwritten"*), so the UI hint must match the semantics — otherwise the auto-generated form lets users type into a field whose value will be clobbered on save. This is a deployer-enforced consistency rule between two model declarations the user has already made consistent in intent; the JsonLogic stays verbatim and the model file is not modified.

For ♻️ same-module matches and 🛑 merges, do not just create the missing fields and stop — walk every model field against its live counterpart and emit `update_field` for each property that has drifted. The diff is essentially free: one `read_field` per entity (filter `table_name=eq.<table>`) already returns every property in a single round-trip, and local comparison is microseconds. Skipping the diff is the reason changed descriptions, title corrections, enum extensions, and same-primitive format adjustments fail to land on re-runs.

For each model field on this entity:

- **Field absent live** → `create_field` as before (auto-generated fields `id`, `label`, `created_at`, `updated_at`, and the entity's `label_column` are still skipped).
- **Field present live** → compute the property delta against the model and emit **one** `update_field` carrying every changed key. Issue one call per drifted field (not one per property) so the audit log records a coherent change set per column. Properties to compare:
  - `title`, `description` — sync to model value.
  - `required`, `searchable`, `width`, `input_type` — sync to model value.
  - `format` — sync to the model value and let the platform decide. Same-primitive changes are accepted by Semantius (TEXT family: `text`/`multiline`/`html`/`json`/`email`; numeric: `integer`/`number`; temporal: `date`/`datetime`). Cross-primitive changes return a primitive-change error — quote the error back verbatim and route the user to the analyst skill for a model-level rethink. The deployer doesn't keep its own primitive taxonomy; Semantius is authoritative.
  - `enum_values` — only sync **additive** extensions (model values the live row doesn't have). Removals (live values the model omits) are unsafe — existing rows may carry the removed value and the constraint tightening will fail at write time. Removals are caught in Stage 2 and surfaced as a 🛑 in Stage 3, never silently applied here.
  - `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` (FK metadata) — sync to model value.

The readonly rule from Stage 4d's create path also applies on re-runs: for every existing field whose name appears in `computed_fields[].name`, if its live `input_type` is anything other than `"readonly"`, include `input_type: "readonly"` in the same `update_field` call. This catches both newly-introduced computed fields (the column existed first, then the model added it to `computed_fields`) and corrections to live data where someone manually toggled input_type away from readonly.

**Don't blind-upsert.** Calling `update_field` on every field regardless of drift is tempting because it's one less branch, but it bloats the audit log, masks live drift that the user may want to see (e.g. someone tightened a description live and the model is stale — the diff exposes that, a blind overwrite silently destroys it), and is strictly slower (more write round-trips than necessary). The diff is the fast path.

**4d-bis. Apply computed fields and validation rules (after fields exist).** The platform validates `computed_fields[].name` against the entity's fields at deploy time, so these arrays can only be set once every field they reference exists. Sequence:

- For ✨ **new entities**, pass `computed_fields` / `validation_rules` on `create_entity` only when **every** referenced field is also auto-created by Semantius (rare: typically only the `label_column`). The safer default is to pass `[]` (or omit) on `create_entity`, then call `update_entity` with the full arrays after 4d has created the referenced fields. Either path lands the same trigger.
- For ♻️ **same-module matches** and 🛑 **merges**, call `update_entity` with the model's arrays after 4d's field diff has synced the underlying columns. If a referenced column doesn't yet exist on the live entity but is being added in this run, sequence the field create first.
- For 🔒 **built-ins**, never push `computed_fields` or `validation_rules` from the model onto a built-in entity — those tables run platform logic and the model's rules would conflict. Stop and surface this to the user before any write.

After the call, surface to the user: *"Applied N computed_fields and M validation_rules on `<table_name>`."* If `update_entity` rejects the arrays (malformed JsonLogic, unresolved field name, duplicate `code`), the error message names the offending entry's array index — quote it back to the user and ask the analyst skill to fix the model before re-running. Do not attempt to repair JsonLogic in the deployer.

**4e. Built-in extensions**, If the user confirmed additive field extensions on a built-in (e.g. the model declares `users.department_id` and the built-in doesn't have it), create those fields after all custom entities are done. Do not modify existing built-in fields, do not change formats or enum values.

**Second pass**, After all entities exist, create any self-reference fields (e.g. `departments.parent_department_id` → `departments`) and any cross-reference pairs that had to wait (e.g. the mutual `departments.manager_user_id` ↔ `users.department_id`).

After each entity's fields are done, share the UI link:
`https://tests.semantius.app/<module_slug>/<table_name>` (URLs use the lowercase `module_slug`, never the display `module_name`).

**4f. Cross-model link suggestions**, After all in-module creates and built-in extensions are done, walk the Proposed list from Stage 3 and execute each confirmed row as an additive `create_field` call.

For each confirmed row `{from_table, resolved_target_table, target_singular, verb, cardinality, delete_mode, field_name}`:

- `field_name` is the auto-generated `<target_singular>_id` from Stage 2g (or the user-supplied alternative if the row went through the field-name-collision flow in Stage 3).
- `format` is always `reference` for §6 rows; `parent` is never used (cross-module ownership is not allowed).
- `reference_delete_mode` is the row's `delete_mode` from §6 (default `clear`; `restrict` is allowed; `cascade` is rejected at parse time).
- `relationship_label` is the row's `verb` from §6.
- `title` is derived from the target's singular form (e.g. `Hardware Asset`) or set from the verb-plus-target idiom; the analyst's verb is the authoritative metadata, the `title` is just a UI label.
- Always include `width: "default"` and `input_type: "default"`.
- Pass `is_unique: true` only when the row's cardinality is `1:1`.

```bash
# Example: a §6 row read `incidents | hardware_assets | affected by | N:1 | clear`,
# Stage 2g resolved hardware_assets to itam.hardware_assets, Stage 3 confirmed.
semantius call crud create_field '{
  "data": {
    "table_name": "incidents",
    "field_name": "hardware_asset_id",
    "title": "Hardware Asset",
    "format": "reference",
    "reference_table": "hardware_assets",
    "reference_delete_mode": "clear",
    "relationship_label": "affected by",
    "width": "default",
    "input_type": "default"
  }
}'
```

For each created field, share the UI link to the source table so the user can inspect:
`https://tests.semantius.app/<from_module_slug>/<from_table>` (URL uses the source module's lowercase `module_slug`).

**Skip silently** for any Stage-3 confirmed proposal the platform rejects (e.g. the resolved target was renamed between Stage 2g inspection and 4f write). Surface the failure in the verification summary; do not retry. Skipped, ambiguous-and-skipped, dormant, and resolved-but-declined rows are listed in the verification summary so the user can see how many §6 hints landed and how many parked.

**Stale rows in the model.** §6 rows whose target is dormant today may resolve on a later deploy of any model. The user can refresh by re-running this skill against any model whose §6 references the newly-arrived target; nothing is persisted on module metadata, so the redeploy is the trigger.

---

## Stage 5: Verify

After all creates are done:

1. `read_entity` on each custom entity, confirm `label_column` is set
2. `read_field` per entity, confirm field count matches the model (minus auto-generated)
3. Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`)

Print a final summary: "✅ Done. Created 1 module, 3 permissions, 2 hierarchy rows, 5 entities (2 admin-tier, 3 operational), 47 fields. Reused built-ins: users. Additive fields on built-ins: 2."

When the model is on the two-permission fallback (no admin-tier entities), the summary reads "2 permissions, 1 hierarchy row, N entities (all operational)". The admin-tier breakdown is omitted when there are no admin-tier entities.

---

## Closing Contract: clean and sticky

The final assistant message of a deployment session is a **call-to-action**, not a recap. It must contain exactly three things, in this order, and nothing else:

1. One status line: `The <System Name> model is live in Semantius ✅`
2. **Open in UI:** `https://tests.semantius.app/<module_slug>`, module landing page, on its own line, prominent (use a markdown link so it's clickable, e.g. `[Open <System Name> in Semantius →](https://tests.semantius.app/<module_slug>)`). The URL path is the lowercase `module_slug` (e.g. `crm`); the link text uses the human display `system_name` (e.g. `CRM`).
3. The Stage 6 sample-data offer.

Everything else, what was created, what was skipped, why built-ins were reused, counts, per-entity links, caveats, justifications, belongs in the Stage 5 verification summary **before** this closing block, separated by a horizontal rule (`---`). Do not mix the two. The closing must not contain reasoning, parentheticals, or "by the way" notes; those dilute the call to action.

This block is **sticky**: if a follow-up turn (audit, "did I miss anything?", fix-up, clarification) interrupts before the user has answered the sample-data question, **re-emit the same three lines at the end of the follow-up reply**. Treat them as a footer that re-attaches itself until the user accepts sample data, declines it, or explicitly closes the session ("we're done", "thanks, that's all"). Before sending any assistant message that comes after Stage 4 writes have started, scan the draft: if it does not contain both the module landing-page link and the sample-data question, append the closing block.

---

## Stage 6: Sample Data

After verification, the closing message asks:

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](https://tests.semantius.app/<module_slug>)
>
> Would you like me to generate 10 realistic sample records for each newly-created entity?

### Scope: whose tables get sample data

**Only entities this run created get sample records.** Everything else is off-limits. Writing seed data into an existing table pollutes live records, confuses reports, and can break referential integrity for users who are actively using the platform.

| Bucket | Eligible for sample data? |
|---|---|
| ✨ New entities created this run | ✅ Yes |
| 🛑 Resolved as "rename incoming" (a new table under the renamed name) | ✅ Yes, it's a new table |
| 🛑 Resolved as "rename both", the *incoming* side | ✅ Yes, new table |
| 🛑 Resolved as "rename existing" | ❌ **Never**, the table already has records |
| 🛑 Resolved as "merge", target existing entity | ❌ **Never**, existing table |
| ♻️ Same-module match (entity already existed) | ❌ **Never**, existing table |
| 🔒 Built-in `users` | ⚠️ Off by default, allowed only after explicit confirmed override (see below) |
| 🔒 Other Semantius built-ins (`roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`) | ❌ **Never, under any circumstances**, no override |

**Sample `users`, off by default, confirmed override allowed.** `users` is platform infrastructure, it controls authentication. Fake users cannot log in (no password, no real IdP identity), cannot receive meaningful role assignments, and will pollute audit trails. **Default behavior: decline and explain these limitations.** If after that explanation the user still wants sample users and explicitly confirms they understand the generated users cannot log in, you may proceed. When you do:

- Use clearly-synthetic identifiers: `email: "sample1@example.invalid"` (the `.invalid` TLD is reserved exactly for this), `full_name: "Sample User 1"`, etc.
- If the model has a `status` / `is_active` / similar field on users, seed to an inactive/test value so the rows can't be mistaken for real accounts.
- Never assign roles to sample users (no `user_roles` inserts, that's the absolute-never bucket below).
- Surface the override in the final summary: *"Created N sample users per your explicit request, none of them can log in."*

**Other built-in tables stay absolute, no override.** `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. These control RBAC, integrations, and the platform's own schema; seeding fake rows corrupts real users' access and the platform itself. Decline every request, even confirmed ones.

### FK fields that point at ineligible tables

A new entity often has FKs to built-ins or existing entities (e.g. `subscriptions.business_owner_id → users`, `subscriptions.primary_department_id → departments` when `departments` is pre-existing). For those fields:

- **Read existing records** from the target table (e.g. `GET /users?select=id&limit=20`) and **pick real IDs at random** to use as FK values.
- Never insert synthetic target records to satisfy the FK. If the target table has zero rows and seeding would require inventing one, skip the FK (leave it null if nullable) or skip the sample record entirely.
- For FKs into **other newly-created entities** in the same run, capture the inserted IDs from those earlier POSTs (see script pattern below) and reference them normally.

Create records in dependency order (entities with no parent FKs first, junction tables last, the model §4 order is usually correct), restricted to the eligible set defined above.

**Generate a single shell script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script to a temp file, run it once, and check the output.

The script should consist of sequential `semantius call crud postgrestRequest` calls, one per record, capturing inserted IDs directly from the POST response for use in FK fields.

### postgrestRequest response envelope

`postgrestRequest` always wraps its result in `{"request":{...},"response":{"status":201,"data":[{...}]}}`. The inserted record is at `response.data[0]`, **not** at the top level. Always use this extractor:

```bash
# Correct — navigate the envelope
ID=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")

# WRONG — treats response as a bare array, always fails with KeyError
ID=$(... | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
```

The same envelope applies to GET, use `d['response']['data']` to access the array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['response']['data']))")
```

### Script pattern

```bash
#!/usr/bin/env bash
set -e

PG='semantius call crud postgrestRequest'

echo "=== Seeding campaigns ==="
C_SPRING=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Spring Launch","status":"active"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
C_FALL=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Fall Promo","status":"draft"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
echo "  spring=$C_SPRING fall=$C_FALL"

echo "=== Seeding leads ==="
# Use captured IDs for FK fields — never assume sequential IDs
$PG "{\"method\":\"POST\",\"path\":\"/leads\",\"body\":{\"lead_name\":\"Jane Smith\",\"campaign_id\":$C_SPRING}}" > /dev/null
# ... etc ...
```

**Important for FK fields:** Capture IDs directly from each POST response, do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely.

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**String safety, ASCII only in seed data:** Do not use Unicode punctuation (em dash `—`, smart quotes `""`/`''`, ellipsis `…`) in seed strings. These characters break bash argument parsing when the script is executed. Use plain ASCII alternatives: `-` instead of `—`, `"` instead of `""`, etc.

Generate realistic data:
- Real-sounding names and emails (not "Test User 1")
- Enums: cycle through all valid model §5 values for that specific field so every value appears at least once
- Dates: realistic mix of past and future
- Numbers: plausible domain ranges
- Booleans: realistic mix

Run the complete script in one bash call and report the final output summary.

---

## Conflict Resolution Reference

| Conflict | Risk | Action |
|---|---|---|
| Module with same `system_slug` already exists | ✅ Low | `update_module`, never create a duplicate |
| Field `format` mismatch, same primitive (TEXT family / numeric / temporal) | ✅ Low | `update_field` accepted by the platform — sync to model value. |
| Field `format` mismatch, cross primitive (e.g. `text → date`, `email → integer`) | 🛑 High | Platform rejects. Quote the primitive-change error back and route to the analyst skill. |
| Entity label/description mismatch | ✅ Low | Offer `update_entity` (skip for built-ins) |
| Field title/description mismatch | ✅ Low | `update_field` — included in the per-field walk at Stage 4d. |
| `enum_values` differ, additive (model adds values the live row doesn't have) | ✅ Low | `update_field` — sync the extended list. No existing record carries the new values, so no constraint break. |
| `enum_values` differ, removal (live row still carries values the model omits) | 🛑 High | Existing rows may hold the removed value and the check-constraint tightening will fail. Surface in Stage 3 so the user can drop the value (and reconcile existing rows first) or keep it in the model. |
| Extra fields/entities not in model | None | Leave them alone |
| Model declares a built-in (`users`, `roles`, …) | None | Dedup: skip create, reuse built-in as `reference_table` target; never replace |
| Model declares extra fields on a built-in | ⚠️ Medium | Offer additive `create_field`; never modify existing built-in fields |
| **Cross-module exact-name collision** (entity with same `table_name` exists in another module) | 🛑 High, ambiguity gate | Stage 3 decision dialog: merge / rename incoming / rename existing / rename both / abort. Never silently coexist. |
| **Similar-name collision** (root, synonym, qualifier, prefix/suffix) | 🛑 High, ambiguity gate | Same dialog as above. User may decline, in which case record the decision and proceed. |
| Merge requires changing field format **across primitive types** (e.g. `text → date`) | 🛑 High | Merge is impossible, fall back to a rename option. Same-primitive format changes (`text → multiline → html`, all `TEXT`) are allowed and can be applied via `update_field` before the merge — not a blocker. |
| Existing-entity rename rejected by platform | 🛑 High | Stop. Offer "rename incoming" or "rename both" as fallback. Never continue silently. |
| §6 row whose `To` target is in the catalog (exact match) and whose auto-generated `<target_singular>_id` field name is free on `From` | ⚠️ Medium | Stage 3 user-confirmed proposal; Stage 4f executes as `create_field` on the source table with the §6 verb as `relationship_label`. |
| §6 row whose `To` target is not in the catalog (and no near-name match) | ✅ Low | Dormant. Skip silently this run; redeploy any model whose §6 references the target once it later arrives. |
| §6 row whose `To` matches multiple plausible targets in the catalog (`vendors` vs `suppliers` vs `saas_vendors`) | ⚠️ Medium | Stage 3 batched `AskUserQuestion` lists candidates with their owning module; user picks one or skips. |
| §6 row's auto-generated FK field name (`<target_singular>_id`) already exists on `From` | ⚠️ Medium | Stage 3 batched `AskUserQuestion` offers a free-text alternative or skip. |
| §6 row whose `From` is neither a `table_name` in this model's §3 nor an existing entity in the catalog | 🛑 High | Stop before Stage 4f. Ask the user to fix the model via the analyst skill so `From` resolves. |
| §6 row uses `cascade` delete or `M:N` cardinality | 🛑 High | Reject at parse time. Cross-model cascade implies ownership across modules; M:N requires an unowned junction table. Send the user back to the analyst skill. |
| Front-matter `version` major older than `EXPECTED_MAJOR` (or `version` key missing entirely) | 🛑 High | Stop at Stage 1. Tell the user the file is from an older analyst major; the analyst's archived-knowledge mode can re-author a current-major file from it. Do not deploy older majors. |
| Front-matter `version` major newer than `EXPECTED_MAJOR` | 🛑 High | Stop at Stage 1. The file was written by a newer analyst than this deployer knows. Ask the user to update this deployer skill before retrying. |
| Model-side `computed_fields` / `validation_rules` array differs from live entity (♻️ same-module match) | ⚠️ Medium | `update_entity` with the model's array verbatim (wholesale replacement). The platform regenerates the BEFORE INSERT/UPDATE trigger; existing rows are not retro-validated. Surface the diff to the user before applying when an entry is being **removed** (the rule will stop firing on future writes). |
| Model omits `Computed fields` / `Validation rules` heading but live entity carries non-empty arrays | ⚠️ Medium | Ambiguous: the analyst might mean "leave as-is" or "I dropped these". Do not silently clear. Surface the live arrays to the user and ask whether to keep them or pass `[]` to remove. The semantic-model-optimizer would have round-tripped them; absence after a round-trip means deliberate removal. |
| Model carries `Computed fields` referencing a field that does not yet exist on the entity | ⚠️ Medium | Sequence: create the referenced field first (Stage 4d), then push the array via `update_entity` (Stage 4d-bis). The platform rejects arrays whose `name` does not resolve to a field. |
| Field is referenced by `computed_fields[].name` but its `input_type` is not `readonly` (either on create or on a re-run) | ✅ Low | Auto-set `input_type: "readonly"` — on create via the `create_field` payload (Stage 4d), on re-run via `update_field`. The column is semantically read-only: every caller value is clobbered by the compute pass at trigger time, so the UI hint is just being aligned with platform behavior. The model and its JsonLogic are not modified. |
| Model carries `validation_rules` with a duplicate `code` within the entity | 🛑 High | Reject at parse time. Send the user back to the analyst skill to fix; the deployer will not silently rename. |
| Model declares `computed_fields` / `validation_rules` on a Semantius built-in (`users`, `roles`, …) | 🛑 High | Refuse. Built-ins run platform logic; model-driven rules would conflict. The model is buggy, escalate to the analyst skill. |
| Model's `validation_rules` JsonLogic invokes `{"require_permission": "<code>"}` for a `<code>` that is not a row in the §2 Permissions summary table | 🛑 High | Reject at parse time, before any write. The platform will throw at rule-evaluation time on every write that hits the gate because the permission doesn't exist; that's a runtime failure mode the analyst's audit should have caught. Surface the offending rule's entity + `code` and the missing permission to the user, ask them to re-run the analyst skill's audit on the file. Do not call `create_permission` ad hoc, an undeclared permission usually signals the model is missing the matching hierarchy row and entity-tier wiring too. |
| Model declares a workflow row in the §2 Permissions summary (e.g. `<slug>:approve_<noun>`) that no `validation_rules` JsonLogic invokes via `require_permission` | ⚠️ Medium | Surface to the user as an "orphan workflow permission" finding in Stage 3 plan. The deployer can still create the permission (it does no harm), but the model is likely buggy, either a `require_permission` call was dropped or the permission was declared speculatively. Ask the user whether to create it anyway or send the file back to the analyst. |
| Live module has workflow permissions (`<slug>:approve_<noun>` etc.) that the model's §2 Permissions summary no longer lists | ⚠️ Medium | Do not silently delete; revoking a permission affects every role and user that holds it. Surface in Stage 3 plan and ask the user to confirm the removal before calling `delete_permission`. If the model's intent was to keep the permission but rename it, that should be done as a delete + create through the analyst skill, not inferred from a diff. |
| Model's §2 Permissions summary table has a `Type: workflow` (elevated) row whose `Hierarchy parent` cell is `<slug>:manage` (rolling an elevated workflow permission up under the baseline manage tier) | 🛑 High | Reject before any write. This row auto-grants every `<slug>:manage` holder the gated authority, defeating the conditional `require_permission` check the workflow permission was created for. The analyst's audit should have caught this. Surface the offending row to the user and route back to the analyst skill; the fix is either to change the `Hierarchy parent` to `<slug>:admin` (promoting the model to three-permission baseline if needed) or to set it to `—` so the workflow permission is granted directly. |
| Model's §2 Permissions summary table has a `Type: workflow-narrow` row whose `Hierarchy parent` cell is `—` or is `<slug>:admin` in a model where `admin` does not transitively include `manage` (analyst v2.1+) | 🛑 High | Reject before any write. The narrow tier's intent is that holders of `<slug>:manage` transitively pass the narrow check; a rollup that excludes `manage` from the chain inverts that intent. Surface the offending row and route back to the analyst skill; the fix is to set `Hierarchy parent` to `<slug>:manage` (the default) or to ensure the baseline chain includes `manage → admin`. |
| Model carries `**Edit permission:** <narrow_suffix>` but the §2 Permissions summary has no `Type: workflow-narrow` row for `<slug>:<narrow_suffix>` (analyst v2.1+) | 🛑 High | Reject before any write — the entity binds to an undeclared narrow tier. Surface the offending entity and route back to the analyst skill to declare the row, or change the annotation back to `manage`/`admin`. |
| Live entity's `edit_permission` is `<slug>:<narrow_suffix>` but model annotates it as `manage` (or vice versa) (analyst v2.1+) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan, same posture as the `manage ↔ admin` flip — this is a real RBAC change (different population of users gains or loses write access on this entity). `update_entity` only after explicit user confirmation. |
| Model's §2 Permissions summary table is missing entirely (file is v1.x or analyst v2.0 skipped the section) | 🛑 High | Reject at Stage 1. v2.0 files require the section; v1.x files are a major-mismatch. Route the user back to analyst Mode D Rebuild to materialize the v2 file from the existing content. Do not attempt to synthesize the table from §8 step 1 and per-entity `Edit permission:` annotations, the v2 contract requires the analyst to produce the table as a deliberate authoring step, not a deployer-side inference. |
| Model carries `**Edit permission:** admin` annotations but the live module is on the legacy two-permission baseline (only `<slug>:read` and `<slug>:manage`) | ✅ Low | Additive upgrade. Stage 4b creates the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row; Stage 4c sets `edit_permission` on the admin-tier entities. Surface in Stage 3 plan as `✨` rows so the user can confirm. |
| Model carries no `**Edit permission:**` annotations (pre-v1.10 file) but the live module has all three permissions and admin-tier entities | ✅ Low | Leave alone. Older analyst minors didn't author tier annotations; do not flip live entities' `edit_permission` from `<slug>:admin` back to `<slug>:manage` based on the absence of an annotation. To sync, the user runs the analyst's Mode B audit first (which proposes annotations + the three-permission §8 step 1) and redeploys against the updated file. |
| Live entity's `edit_permission` is `<slug>:admin` but model annotates it as `manage` (or vice versa) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan. `update_entity` only after explicit user confirmation, this is a real RBAC change; everyone with the old tier loses or gains edit access on that entity. Do not silently switch. |
| Re-run on a module whose live hierarchy has the inclusion direction inverted (e.g. `read includes manage`) | 🛑 High | Stop. An inverted row breaks RBAC; the deployer never authored this. Surface to the user and ask whether to delete the inverted row and recreate it the right way around. Never `update` a hierarchy row silently. |
