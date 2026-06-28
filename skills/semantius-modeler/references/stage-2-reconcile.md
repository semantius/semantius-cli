# Stage 2: Verify reconciliation + Stage 2.5 access-control scope (modeler reference)

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

> **Module schema note.** Modules carry `module_name` (display), `module_slug` (URL handle), `description` (≤40-char selector chip, sourced from frontmatter `tagline`), `icon_name`, the top-level columns `domain_code` and `access_scope`, and `module_type` (`"domain"` default). The §1 Overview prose does NOT go on the module record. `module_type` from the spec (default `"domain"`); reject if it differs from a pre-existing module's `module_type`.

#### 2a-scaffold: standard module scaffold (idempotent)

> The committed [`scaffold-lib.ts`](./scaffold-lib.ts) `scaffoldModule()` executes steps 1-5 below in one idempotent, self-preflighting call. This section is the **contract** it implements (and what Stage 5 verifies); a deploy script calls the helper rather than re-typing the steps.

Every module carries: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (named in the spec's §9.1 baseline-roles table — conventionally `<slug>_viewer` / `<slug>_manager` / `<slug>_admin`, but the §9.1 `role` column is the authoritative, deploy-ready slug and the deployer uses it verbatim, never reconstructing it from the module slug), and six FK columns on the module record (`view_permission`, `manage_permission_id`, `admin_permission_id`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`).

For each module touched, idempotent steps:

1. **Determine the required tier set.** Two-permission baseline (`read`, `manage`) unless the spec's §8.1 Permissions catalog declares a `baseline-admin` row, in which case three-permission baseline (`read`, `manage`, `admin`).
2. **Create or backfill permissions from §8.1.** Iterate the spec's §8.1 Permissions catalog in table order. For each row, `read_permission --single` by `permission_name`.
   - **Exit 1 (missing):** `create_permission` passing `permission_name = <row.permission>`, `description = <row.description>` (verbatim from §8.1), and **`module_id = <module.id>`**. Never omit `module_id` — it is a load-bearing FK, not optional metadata. A permission minted with a NULL `module_id` still resolves by name (so the permission-hierarchy and role-permission joins pass, and a casual smoke test looks green), but module-scoped queries (`?module_id=eq.<id>`) silently miss the row and per-module RBAC audits report drift.
   - **Exit 0 (exists):** the row is already present — do **not** skip it. Assert its `module_id == <module.id>`; if the live value is NULL or points at a different module, `update_permission` to set it. This step **converges the column to the desired state, it is not create-only**: a permission left with a NULL `module_id` by an earlier buggy deploy is repaired here on the next run, not stranded forever because the create already happened. (This is the durable guard; Stage 5's check only verifies that this backfill landed.)
   The spec is the single source of truth for codes and descriptions. **Note:** when a row carries a `re-prefixed-from <catalog-module>.<verb>` annotation (Stage 1 parsed it into `row.re_prefixed_from`), the row's `permission_name` ALREADY reflects the installing-unit slug (the analyst emitted it that way per the entity-owning-module rule). Mint as-is; Stage 4n will reconcile if/when the catalog module installs. The annotation is metadata only — it does not change the mint here.
3. **Create permission-hierarchy chain.** For each row in the spec's §9.1 Permission hierarchy table: resolve both ends from `permission_name` to id once at the top, then **read-before-write** — `read_permission_hierarchy` filtered by `including_permission_id=eq.<including_id>&included_permission_id=eq.<included_id>` and `create_permission_hierarchy` only on exit 1, with `including_permission_id = <row.permission>.id`, `included_permission_id = <row.includes>.id`, `origin = "model"` (domain) or `"model_master"` (master). A re-run finds every chain row already present and skips it (same guard 4b restates).
4. **Create default roles per tier**, reading each role's `slug` **verbatim from the spec's §9.1 baseline-roles table** (the `role` column is the resolved, deploy-ready slug; the analyst already normalized it to the platform's `roles.slug` rule, so the deployer never reconstructs `<slug>_<tier>` — a module slug may legally carry a hyphen the role slug cannot). Idempotent and converging: `read_role --single` by that §9.1 slug; on **exit 1** `create_role`, passing the §9.1 `slug` verbatim plus `role_name`, `description`, **`module_id` (load-bearing FK — same NULL-drift failure mode as permissions above; never omit it)**, `origin = "model"`. On **exit 0** do not skip — assert the live `module_id == <module.id>` and `update_role` to set it if it is NULL or points elsewhere, so a role stranded with a NULL `module_id` by an earlier deploy is repaired on the next run. Then attach the row's `baseline grant` permission to each role with the same read-before-write guard: `read_role_permission --single` by `role_id=eq.<role_id>&permission_id=eq.<perm_id>` → `create_role_permission` only on exit 1.
5. **Populate the six module-record references, plus the access-scope setting.** After permissions and roles exist, `update_module` to set `view_permission = "<slug>:read"`, `manage_permission_id`, `admin_permission_id` (nullable), `default_*_role_id`, **and the top-level column `access_scope = <the scope resolved in Stage 2.5>`** (`basic` / `full`). The scope is written on **every** deploy, regardless of which Stage 2.5 resolution path decided it (frontmatter, prior live setting, or the ask) — this per-module record is the signal Stage 2.5's detection (and the analyst's identical detection) counts, so leaving it null silently skews future defaults toward basic. Write only the fields whose live value differs (re-runs are idempotent; a module already carrying the same `access_scope` is skipped). `access_scope` is a top-level column written directly; the `settings` JSON (e.g. `raci_mode`) is merged rather than overwriting sibling keys.

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
The former `single_approver` / `has_single_approver` pattern-flag mechanism has been retired from the contract. An approval is now a §7 gated transition + its §8.1 `workflow-gate` permission (verified to exist like any other §8.1 row by 2a-scaffold step 2) + the §9 RACI Accountable actor. There is no phantom `approve_<entity>_approval` gate to detect, so this stage performs no approval-specific check; a workflow-gate permission is reconciled as a normal §8.1 permission.

## Stage 2.5: Access control scope (basic vs full RBAC)

This stage guarantees the deploy reflects the user's access-control choice — **basic access** (plain read + edit) or **full RBAC** (admin tier, workflow gates, lifecycle gating, personas / RACI) — even when the spec doesn't carry one. It is the universal backstop: every deploy funnels through the modeler, so this is the one place the choice is *always* honored.

**This is not a re-litigation of the spec.** In the hybrid pipeline the analyst already authored the spec in the chosen shape and stamped `access_scope` in frontmatter; here the modeler simply *reads* that decision and obeys. The prompt below fires **only** when the choice is genuinely unresolved (no frontmatter directive, no prior choice on the module) — the same deploy-time-decision posture as the §6 cross-model-link prompt (a thing the spec deliberately leaves for deploy time). When the spec carries `access_scope`, no prompt fires. This is consistent with "the only confirmation the modeler asks" rule below: a spec that already encodes the decision is never re-asked.

### Resolution order (first hit wins, stop)

1. **Spec frontmatter `access_scope`** present (`basic` / `full`) → use it. No prompt. (The hybrid path: the analyst already shaped the spec to match, so no projection is needed — see below.)
2. **Live module `access_scope` column** present (a prior deploy recorded the choice) → use it. No prompt. Read it from the module record resolved in Stage 2a.
3. **Undecided** (neither carries a value) → run the detection below to pick a default, **ask** the user, and persist the answer to `modules.access_scope` (Stage 4a).

**Persist on every path, not only step 3.** Whichever step resolves the scope, record the resolved value to the `modules.access_scope` column via an idempotent `update_module` at Stage 4a-scaffold (same posture as `settings.raci_mode = "living"`). Steps 1 and 2 persist too: this per-module record is the signal the detection below (and the analyst's identical detection) counts, so it MUST be populated for every module the pipeline deploys, including the hybrid path where the spec frontmatter already carried the decision. A module left with `access_scope = null` is invisible to the count and silently skews future defaults toward basic.

### Detection (sets the default only)

Count the live modules that recorded a full-access deploy, excluding the module being deployed (a re-deploy must not self-trigger):

```bash
semantius call crud read_module '{"filters": "access_scope=eq.full,module_slug=neq.<system_slug>"}'
```

Any row → **default Full** (stay consistent with the modules already using full access control). No rows → **default Basic** (don't saddle a setup that isn't using governance with it). This counts the choice each prior deploy recorded on its module record (`modules.access_scope`) — not whether permissions or roles merely exist, since a basic module also creates `<slug>:read` / `<slug>:manage` and viewer / manager roles and so cannot be told apart from full by a permission sniff.

### The prompt (only at resolution step 3)

`AskUserQuestion`, header `Access control`, the Recommended option leading per the detection (Basic on a fresh instance, Full on one already using RBAC). Plain language, no `access_scope` token, US spelling, no em-dashes:

- label `Basic access (read and edit)` — *"Anyone allowed in can read and edit records. No roles to manage, no approval steps, no per-stage gating. The records and their stages still exist; moving a record through its stages just isn't restricted. You can add advanced access control later."*
- label `Advanced access control` — *"An admin tier, role-based permissions, approval gates on sensitive actions, and per-stage gating of record lifecycles. More to set up, fine-grained control over who can do what."*

### Realizing `basic`

If the resolved scope is `basic` **and the spec is already in the two-permission fallback shape** (frontmatter said `basic`, the analyst authored it that way), there is nothing to strip — deploy as written. The check: §8.1 carries only `<slug>:read` + `<slug>:manage`, no `workflow-gate` / `override` / `narrow` rows, §9.1 has only viewer + manager + the `manage → read` edge, no §9 RACI/persona surface. When that holds, `basic` is a no-op beyond persisting the setting.

If the resolved scope is `basic` **but the spec is full-shaped** (the backstop case: a full spec with no directive, or `access_scope = basic` against a full spec), apply the **two-permission projection** — deterministically deploy the spec as if it declared the two-permission fallback. Project, do not delete (the no-auto-deletion rule still holds; on a re-deploy that flips an existing full module to basic, the projection simply stops provisioning the higher-governance objects — any already-live gates/roles remain as quiet orphans, surfaced in the Stage 5 summary, never deleted):

| Stage | Full behavior | Basic projection |
|---|---|---|
| 2a-scaffold / 4a / 4b | create every §8.1 permission, the full hierarchy chain, viewer/manager/admin roles | create only `<slug>:read` + `<slug>:manage`, the single `manage → read` edge, and the `<slug>_viewer` + `<slug>_manager` roles. Skip `<slug>:admin`, every `workflow-gate` / `narrow` / `override` permission, the admin role, and every gate rollup. Leave the module record's admin FK columns null. |
| 4c (entities) | `edit_permission` per §3 `**Edit permission:**` (`admin` / `<narrow>` / `manage`) | force every entity's `edit_permission` to `<slug>:manage`. Lifecycle `workflow_state` enum fields are still created (the machine exists, ungated). |
| 4e (write-side rules) | apply all `validation_rules` / `computed_fields` | drop any entry whose JsonLogic gates on a dropped permission (`require_permission` / `has_permission` on a code that no longer exists); keep pure data-integrity / computed entries. |
| 4f (read-side rules) | apply `select_rule` / `input_type_rule` | apply none from the spec (treat as absent); for a *live* non-empty `select_rule` follow the existing 4f "model omits, live present → ask" path (never silently clear). Drop any `input_type_rule` that gates on a dropped permission. |
| 4k / 4l / 4m | personas + RACI, functional-ownership grants, lifecycle handoffs | skip entirely. |

**Unsplittable mixed rule (rare).** If a single `validation_rules` entry's JsonLogic *interleaves* a permission gate with a data-integrity check such that dropping the gate cannot cleanly preserve the integrity check, do not guess — **halt and route back to the analyst**: *"This design mixes a permission check with a data rule in one entry (`<code>` on `<table>`); deploying it as basic access needs the analyst to split them. Re-run `semantius-analyst` with basic access."* This mirrors the existing "spec doesn't match, re-run the analyst" posture; it is the one place basic-on-a-full-spec routes back instead of projecting.

The projection only narrows; it never invents. A basic deploy is always a strict subset of the full deploy, so re-running the same spec under `full` later is purely additive (every skipped object is created on the next full deploy, idempotently).

