# Stage 2: Verify reconciliation + Stage 2.5 access level (modeler reference)

_Read this when the workflow reaches Stage 2. The stage map is in SKILL.md._

## Stage 2: Verify reconciliation against the live catalog

**Read before writing, always.** (use-semantius Golden Rule #1)

The analyst has already classified every entity, detected every collision, and made every decision. The modeler's job in Stage 2 is to verify each decision still holds against the *current* live catalog (the catalog may have changed between analyst-run and modeler-run).

### 2a. Resolve the module

Look up the module by `system_slug`:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'
```

- **Exit 0 (exists)**: capture the `id`; plan `update_module` to refresh `module_name` / `description` if they drift.
- **Exit 1 (missing)**: plan `create_module` with `module_name = <system_name>`, `module_slug = <system_slug>`, `description = <tagline>`, `icon_name = <icon_name>`, `domain_code = <domain_code>`, `module_type = "domain"`, then run the scaffold pass (subsection 2a-scaffold below).
- **Exit 2 (duplicate)**: hard catalog bug; surface and stop.

> **Module schema note.** Modules carry `module_name` (display), `module_slug` (URL handle), `description` (≤40-char selector chip, sourced from frontmatter `tagline`), `icon_name`, the top-level columns `domain_code` and `access_scope` (`custom` / `basic` / `advanced` / `gated` / `raci`), and `module_type` (`"domain"` default). The §1 Overview prose does NOT go on the module record. `module_type` from the spec (default `"domain"`); reject if it differs from a pre-existing module's `module_type`.

#### 2a-scaffold: standard module scaffold (idempotent)

> The committed [`scaffold-lib.ts`](./scaffold-lib.ts) `scaffoldModule()` executes steps 1-5 below in one idempotent, self-preflighting call. This section is the **contract** it implements (and what Stage 5 verifies); a deploy script calls the helper rather than re-typing the steps.

Every module carries: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (named in the spec's §9.1 baseline-roles table — conventionally `<slug>_viewer` / `<slug>_manager` / `<slug>_admin`, but the §9.1 `role` column is the authoritative, deploy-ready slug and the deployer uses it verbatim, never reconstructing it from the module slug), and six reference columns on the module record: three permission names (`view_permission`, `manage_permission`, `admin_permission`, text FKs to `permissions.permission_name`) and three numeric role FKs (`default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`).

For each module touched, idempotent steps:

1. **Determine the required tier set.** Under `access_scope: custom` skip steps 1-5 entirely (Stage 2.5): the module keeps its hand-made permissions, roles and module-record references. Otherwise: `read` + `manage`, plus `admin` when the spec's §8.1 Permissions catalog declares a `baseline-admin` row.
2. **Create or backfill permissions from §8.1 — as one set.** Take the spec's §8.1 Permissions catalog in table order and treat the rows as ONE set: one `read_permission` with `permission_name=in.(<every row's permission>)`, then **one `create_permission` call** whose `data` array carries every row the read did not return (`permission_name = <row.permission>`, `description = <row.description>` verbatim from §8.1, and **`module_id = <module.id>`**), then one re-read to confirm the rows landed (never trust the create response). Permissions have no numeric id: `permission_name` is the primary key and every other table references a permission by that name. Never omit `module_id` — it is a load-bearing FK, not optional metadata. A permission minted with a NULL `module_id` still resolves by name (so the permission-hierarchy and role-permission joins pass, and a casual smoke test looks green), but module-scoped queries (`?module_id=eq.<id>`) silently miss the row and per-module RBAC audits report drift.
   - **Rows the read returned** are already present — do **not** skip them. Assert each one's `module_id == <module.id>`; every row whose live value is NULL or points at a different module goes into **one** `update_permission` call keyed by a `permission_name` array (`{"permission_name": [<drifted names>], "data": {"module_id": <module.id>}}`). This step **converges the column to the desired state, it is not create-only**: a permission left with a NULL `module_id` by an earlier buggy deploy is repaired here on the next run, not stranded forever because the create already happened. (This is the durable guard; Stage 5's check only verifies that this backfill landed.)
   The spec is the single source of truth for codes and descriptions. Never loop `read_permission --single` → `create_permission` per row: N single calls where one array call would do is the failure the platform's batching rule names. **Note:** when a row carries a `re-prefixed-from <catalog-module>.<verb>` annotation (Stage 1 parsed it into `row.re_prefixed_from`), the row's `permission_name` ALREADY reflects the installing-unit slug (the analyst emitted it that way per the entity-owning-module rule). Mint as-is; Stage 4n will reconcile if/when the catalog module installs. The annotation is metadata only — it does not change the mint here.
3. **Create the permission-hierarchy chain — as one set.** Both ends of every row in the spec's §9.1 Permission hierarchy table are written as permission names directly (no id lookup). **Read-before-write over the set** — one `read_permission_hierarchy` filtered by `including_permission_name=in.(<every including name>)`, match the `(including, included)` pairs locally, and issue **one `create_permission_hierarchy` call** carrying every missing edge (`including_permission_name = <row.permission>`, `included_permission_name = <row.includes>`, `origin = "model"` (domain) or `"model_master"` (master)); the platform generates each row's `id` as `"<including>.<included>"`. A re-run finds every chain row already present and issues no call (same guard 4b restates). `ensurePairs` in `deploy-lib.ts` is this step as code.
4. **Create default roles per tier — as one set**, reading each role's `slug` **verbatim from the spec's §9.1 baseline-roles table** (the `role` column is the resolved, deploy-ready slug; the analyst already normalized it to the platform's `roles.slug` rule, so the deployer never reconstructs `<slug>_<tier>` — a module slug may legally carry a hyphen the role slug cannot). Idempotent and converging, same shape as step 2: one `read_role` with `slug=in.(<every §9.1 slug>)`; **one `create_role` call** for the missing roles, each passing the §9.1 `slug` verbatim plus `role_name`, `description`, **`module_id` (load-bearing FK — same NULL-drift failure mode as permissions above; never omit it)**, `origin = "model"`, and `catalog_role_code` (the §9.1 slug, lineage); one re-read for the ids. Roles the read returned are not skipped — assert the live `module_id == <module.id>` and converge every drifted one in **one** `update_role` call with an `id` array, so a role stranded with a NULL `module_id` by an earlier deploy is repaired on the next run. Then attach each row's `baseline grant` permission with the same set-wise guard: one `read_role_permission` over `role_id=in.(<the role ids>)`, and **one `create_role_permission` call** carrying every missing `{role_id, permission_name}` pair (the role id resolved from the re-read, the permission written by name).
5. **Populate the six module-record references, plus the access-scope setting.** After permissions and roles exist, `update_module` (never `create_module`: each permission reference must name a permission that already exists, and `<slug>:read` does not exist until step 2) to set the permission names `view_permission = "<slug>:read"`, `manage_permission = "<slug>:manage"`, `admin_permission = "<slug>:admin"` (nullable; null under `basic`), the role ids `default_*_role_id`, **and the top-level column `access_scope = <the spec's access_scope>`** (`basic` / `advanced` / `gated` / `raci`; never written under `custom`, where this scaffold is skipped). The architect's permission step reads this per-module record (whether another module uses `raci`, and this module's current level). Write only the fields whose live value differs (re-runs are idempotent; a module already carrying the same `access_scope` is skipped). `access_scope` is a top-level column written directly; the `settings` JSON (e.g. `raci_mode`) is merged rather than overwriting sibling keys.

### 2b. Verify reuse-from annotations

For every spec entity with `**Reconciliation:** reuse-from <module>.<entity>`:

```bash
semantius call crud read_entity --single '{"filters": "table_name=eq.<entity>"}'
```

If the entity is missing, OR its `module_id` no longer matches `<module>`, halt with: *"The design expected `<Plural Label>` to already exist in your semantic model under the `<Module Display Name>` module, but it's not there anymore. Something changed since the planning step ran. Re-run `semantius-analyst` to refresh the design."*

For each reused entity, also read its current fields to populate the FK-target index used in Stage 4:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<entity>"}'
```

### 2c. Verify rename-incoming-from annotations

For every spec entity with `**Reconciliation:** rename-incoming-from <module>.<source> as <new_name>`:

- Confirm `<module>.<source>` exists (the analyst saw it; verify it's still there). If missing → halt with drift message.
- Confirm `<new_name>` does NOT exist anywhere in the catalog. If it now exists → halt with: *"The disambiguated name `<new_name>` is now in use; re-run the analyst to pick a different name."*

### 2d. Verify promote-to-master annotations

For every spec entity with `**Reconciliation:** promote-to-master <master_module>.<entity>`:

- Confirm `<master_module>` exists AND has `module_type = "master"`. If it exists with `module_type = "domain"` → halt (the analyst should have caught this).
- If `<master_module>` doesn't exist yet → it's a Branch-B-with-new-host case; plan `create_module` with `module_type = "master"` per the spec's `promotion_decisions` frontmatter, then create the entity there.
- Apply the manage-inclusion edges per the spec's `promotion_decisions[<entity>].manage_option` (1/2/3/4 — see analyst Stage 3b for the option semantics; the modeler reads the recorded choice and applies the corresponding `permission_hierarchy` rows).

### 2e. Verify dropped annotations

For every spec entity with `**Reconciliation:** dropped (optional, user declined)`: skip entirely. No reads, no writes. Note in the Stage 3 plan.

### 2f. Verify built-in dedups

For every spec entity with `**Reconciliation:** reuse-from semantius_builtin.<table>` (the analyst flagged platform built-ins): confirm `<table>` is in the canonical built-in list (see `use-semantius/references/data-modeling.md`). If the spec annotated a non-built-in as `semantius_builtin.*` → halt (spec corruption; re-run analyst).

### 2g. Resolve cross-model link suggestions

For each parsed §6 row `{from_table, to_concept, verb, cardinality, delete_mode}`, resolve the `to_concept` against the live catalog (the analyst leaves §6 `To` unprefixed and unresolved on purpose — resolution is the modeler's deploy-time job). Single exact / canonical match → mark the row ✨ proposed with the resolved target table captured, and check the auto-generated `<target_singular>_id` field name is free on `from_table` (🛑 field-name collision otherwise, resolved in Stage 3). Multiple plausible matches → mark 🟡 ambiguous for the Stage 3 batched question. No match in the catalog → mark the row 💤 dormant in the plan; do not halt the deploy on an unresolved §6 row (cross-model links are optional FKs, additive). `from_table` that is neither a §3 entity in this model nor a live entity is a 🛑 (Stage 3 routes the user back to the analyst).

### 2h. `module_kind` recognition
Parse the frontmatter `module_kind` value and surface in the Stage 3 plan-summary line `🏷 module_kind = <kind>`. No behavior branches on the value — the deployer's logic is `module_kind`-agnostic. Unknown values are accepted (warned in the plan, not blocked).

### 2i. Catalog-owner detection for re-prefixed permissions
For every spec §8.1 permission row with a `**Reconciliation:** re-prefixed-from <catalog-module>.<verb>` annotation, look up the catalog module in the live catalog:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<catalog-module>"}'
```

- **Exit 1 (catalog module absent)**: the re-prefix stands. The permission will be minted under the spec's installing-unit slug per Stage 4a-scaffold. Mark the row in the plan as `🔁 Re-prefix: <slug>:<verb> (catalog <catalog-module> not installed)`.
- **Exit 0 (catalog module present)**: queue the row for **Stage 4n reconciliation**. After the entity is moved (Branch-B promotion in 4c-promote) to the catalog module, Stage 4n will:
  - mint the catalog-prefixed sibling permission (`<catalog-module>:<verb>`) if absent;
  - create a sibling `role_permissions` row for every grant on the re-prefixed code (no deletes);
  - re-emit any `permission_hierarchy` edge referencing the re-prefixed code under the catalog prefix.
  - Mark the row in the plan as `🔁 Master-install reconciliation: rename <slug>:<verb> → <catalog-module>:<verb>; migrate <N> grants`.

The sweep is N-to-1: an entity may have accumulated multiple non-catalog prefixes across prior installs (e.g. `hiring-starter:hire_candidate` AND `ats-recruitment-pipeline:hire_candidate` may both exist when `ats-candidate-crm` finally installs). Stage 4n sweeps ALL non-catalog-prefixed permissions for the affected entity's verbs.

### 2j. Approval gates (no separate cross-check)
An approval is a §7 gated transition: under `access_scope: raci` + its §8.1 `workflow-gate` permission (verified to exist like any other §8.1 row by 2a-scaffold step 2) + the §9 RACI Accountable actor; under `gated` its rule requires `<slug>:admin`. There is no phantom `approve_<entity>_approval` gate to detect, so this stage performs no approval-specific check; a workflow-gate permission is reconciled as a normal §8.1 permission.

### 2k. Key type and base are create-only
An entity's key type (`id_type`), and for an `is_a` / `has_a` entity its base (`id_refentity`), are fixed when its table is created: the platform refuses any later change (`90233`), so the modeler never sends `id_type` on `update_entity` and never "converges" it. Using the `read_entity` rows Stage 2 already holds (one `table_name=in.(…)` sweep covers every spec entity; the rows carry `id_type` / `id_prefix`):

- **Entity that already exists live** (♻️ same-module re-deploy, `reuse-from`, shared-master host, merge host, rename-existing, promote of an existing entity) **and its spec block carries `**Key type:**`**: the value must equal live `id_type`. When the line is absent nothing is compared: on an existing entity an omitted line means "not specified" and the live value stands (same posture as the other omitted entity lines). A mismatch halts before any write, with: *"`<Plural Label>` already exists and its records use <live kind> as ids, but the design asks for <spec kind>. The kind of id is fixed when a table is created and cannot be changed afterwards; changing it means rebuilding the table and moving its records. Re-run `semantius-analyst` to keep the existing ids or to plan the rebuild."* (plain words for the kinds: `auto_increment` sequential numbers, `bigint` numbers you supply, `text` text ids you supply, `uuid` UUIDs, `typeid` prefixed ids such as `acct_01h4…`). The modeler never offers the rebuild itself.
- **`**Key prefix:**` on an existing `typeid` entity** that differs from live `id_prefix`: not a halt. Stage 4c syncs it on the ♻️ same-module path (`update_entity` with `id_prefix` only); the Stage 3 plan notes that new records get ids with the new prefix while existing records keep theirs.
- **`**Based on:**` is create-only too** (`id_refentity`, `90241`). On an entity that exists live, the spec's `**Based on:**` (absent = none) must equal live `id_refentity`, and an `is_a` prefix must equal live `id_prefix` (`90245`); a mismatch halts before any write with the same rebuild message, routed back to the analyst.
- **Entity this deploy creates with `**Based on:**`**: the base is either created by this deploy at an earlier level or exists live; a live base must be managed and of the right key type (`typeid` for `has_a`; `typeid` or `is_a` for `is_a`), else halt with the drift message (the catalog changed since the analyst ran). `<table_name>_ext` must not exist live (`90250`; halt, route back to the analyst to rename).
- **Base in another module**: the spec's §9.1 Permission hierarchy carries the cross-module edit grant (`` `<slug>:<tier>` `` includes the base's `edit_permission`); Gate A checks the included permission exists, and Stage 4i wires it like any cross-module inclusion.
- **Entity this deploy creates** (✨ New, rename-incoming, promote-create) whose spec carries `**Key prefix:**`: the prefix must not already be used by another live entity (`id_prefix` is unique among entities; one `read_entity` with `id_prefix=in.(<every new prefix>)`). A taken prefix means the catalog changed since the analyst ran: halt with the drift message and route back to the analyst to pick another prefix.

## Stage 2.5: Access level

The module's access level is decided by the architect and carried in the spec frontmatter `access_scope` (`custom` / `basic` / `advanced` / `gated` / `raci`); Stage 1 refuses a spec without it. The analyst already shaped the spec to match, so the modeler deploys it as written, also when it is lower than the live module's value (nothing is deleted: live permissions, roles and rules stay): no detection, no question, no projection.

**What each access level deploys** (the stages named here run as documented; the rest of the deploy is the same at every level):

| `access_scope` | 2a-scaffold / 4a / 4b (permissions, hierarchy, roles, module record) | 4c (entities) | 4k (personas, RACI) | 4l / 4m (functional ownership, handoffs) | `modules.access_scope` |
|---|---|---|---|---|---|
| `custom` | skipped: no permission, role, hierarchy or module-reference writes; the module keeps its hand-made structure (4a still refreshes the module's name, description and empty provenance keys) | each entity's `view_permission` / `edit_permission` = the module record's current `view_permission` / `manage_permission` (left empty when the module has none; the deploy proceeds) | skipped | skipped | not written (stays `custom`) |
| `basic` | `<slug>:read` + `<slug>:manage`, the single `manage → read` edge, viewer + manager roles; the module record's admin columns stay null | per the spec (`manage`) | skipped | skipped | written |
| `advanced` / `gated` | every §8.1 row, the §9.1 hierarchy, viewer + manager + admin roles | per the spec | skipped | run | written |
| `raci` | every §8.1 row (including one permission per gate, not included in `<slug>:admin`), the §9.1 hierarchy, viewer + manager + admin roles | per the spec | run | run | written |

Write-side and read-side rules (4e / 4f) deploy as the spec says at every level: the analyst authored no permission-gated rules under `basic` and `custom`, and under `gated` the process-gate rules require `<slug>:admin`.
