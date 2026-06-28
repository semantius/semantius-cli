# Stage 4: Execute (modeler reference)

_Read this when the workflow reaches Stage 4. The stage map is in SKILL.md._

<!-- DUPLICATE of canonical copy in references/stage-2-reconcile.md (Stage 2.5, Realizing basic). Edit both. -->

**Stage 2.5 two-permission projection table (reproduced here for residency; canonical copy in `references/stage-2-reconcile.md`):**

| Stage | Full behavior | Basic projection |
|---|---|---|
| 2a-scaffold / 4a / 4b | create every §8.1 permission, the full hierarchy chain, viewer/manager/admin roles | create only `<slug>:read` + `<slug>:manage`, the single `manage → read` edge, and the `<slug>_viewer` + `<slug>_manager` roles. Skip `<slug>:admin`, every `workflow-gate` / `narrow` / `override` permission, the admin role, and every gate rollup. Leave the module record's admin FK columns null. |
| 4c (entities) | `edit_permission` per §3 `**Edit permission:**` (`admin` / `<narrow>` / `manage`) | force every entity's `edit_permission` to `<slug>:manage`. Lifecycle `workflow_state` enum fields are still created (the machine exists, ungated). |
| 4e (write-side rules) | apply all `validation_rules` / `computed_fields` | drop any entry whose JsonLogic gates on a dropped permission (`require_permission` / `has_permission` on a code that no longer exists); keep pure data-integrity / computed entries. |
| 4f (read-side rules) | apply `select_rule` / `input_type_rule` | apply none from the spec (treat as absent); for a *live* non-empty `select_rule` follow the existing 4f "model omits, live present → ask" path (never silently clear). Drop any `input_type_rule` that gates on a dropped permission. |
| 4k / 4l / 4m | personas + RACI, functional-ownership grants, lifecycle handoffs | skip entirely. |

---

## Stage 4: Execute

> **Access-control projection (Stage 2.5).** When Stage 2.5 resolved `basic` and the spec is full-shaped, every sub-stage below is **narrowed per the Stage 2.5 two-permission projection table** (reproduced at the top of this file; canonical copy in `references/stage-2-reconcile.md`) — fewer permissions / roles / hierarchy rows (4a-scaffold, 4b), `edit_permission` forced to `<slug>:manage` (4c), permission-gated rules dropped (4e / 4f), and governance stages (4k / 4l / 4m) skipped entirely. When Stage 2.5 resolved `full`, or `basic` against an already-two-permission spec, every sub-stage runs as written. The projection only narrows; it never creates anything a full deploy wouldn't.

Follow the use-semantius mandatory creation order exactly:

```
Module → Permissions → Entities → Fields (per entity, in model order)
```

<!-- DUPLICATE of canonical copy in SKILL.md (Cross-cutting safety invariants). Edit both. -->

**Failure is loud and halting (the recovery model depends on it).** The deploy's entire recovery story is re-run convergence: the spec is the target, every Stage 4 op is read-before-write and idempotent, and a failed or partial deploy is recovered by **re-running** — there is no transaction, rollback, or resume (PostgREST is stateless). That model is only safe if a partial failure is **visible**. So when any Stage 4 sub-stage's write fails (a `create_*` / `update_*` / `postgrestRequest` returns non-zero, a platform constraint trips, or a ⚠ row forces a FAIL LOUD), **stop immediately and tell the user the deploy is incomplete and must be re-run** — do not swallow the error, do not continue to the next sub-stage, and never let the closing message or the Stage 5 summary print a success-shaped result over a partial write. The single way this model breaks in practice is a partial failure that reads as success, so the operator never re-runs. State the halt plainly (and within the Writing Conventions, no em-dashes in this user-facing line): *"Deploy halted at `<sub-stage>` after N writes. The deploy is incomplete: fix the cause and re-run, and the modeler reconciles forward from wherever it stopped (every op is idempotent, so re-running never double-creates)."* This is especially load-bearing inside 4k living-mode, which materializes the RACI engine across five separate `postgrestRequest` batches (`processes` → `raci_assignments` → `process_gates` → enforcement rules → `raci_mode` flag): a mid-sequence abort there must surface, never be summarized away.

**When this stage needs a script (prose-bearing payloads, many writes, or conditional logic over the live catalog — the common case), build it from [`references/deploy-script-template.md`](./deploy-script-template.md), which assembles the deploy around the committed primitives in [`references/deploy-lib.ts`](./deploy-lib.ts).** Those primitives are the concrete implementation of the loud-and-halting invariant above: an exit-code-aware `read1` for read-before-write (never a `try/catch` existence probe), the loud `write` for mutations, the create-or-diff field sync (not create-if-missing), and a `runDeploy` harness that halts non-zero on the first failure and never prints success over a partial deploy. Copy `deploy-lib.ts` into the scratch dir and import it; do **not** invent your own error handling — the `intgov-inventory` deploy reported success at ~40% complete because hand-rolled `createEntityIfMissing` / `addFieldIfMissing` helpers wrapped writes in a bare `catch` and continued.

Refer to `use-semantius/references/data-modeling.md` for the exact CLI syntax for each operation. **Before executing, apply every ambiguity decision from Stage 3** to the in-memory plan, renames propagate to every `reference_table` and relationship reference in the model. The sequence:

<!-- DUPLICATE of canonical copy in SKILL.md (Cross-cutting safety invariants). Edit both. -->

### Provenance stamping (core columns; applies to every create in this stage)

The platform ships core provenance columns the modeler is the only writer of. **The deployer stamps these values at provision time** — they are how rename detection, catalog-owner-arrival, behavior discovery, and cross-domain merges become deterministic platform reads downstream (the analyst on re-reconcile, and every `use-*` discovery skill). The rules, once, for the whole stage:

- **Stamp VALUES only — never `create_field` these columns, never write `ctype`.** Core registers them with `ctype = 'core'` (so `is_core` is *derived* as `ctype <> ''`); `ctype` is privilege-locked. The modeler does **not** create these columns and does **not** stamp `is_core` — it passes the column values on the `create_*` / `update_*` payload it already sends. (If a deploy ever errors that one of these columns is missing, the platform is too old — surface that; do not try to `create_field` it.)
- **`entities.catalog_entity_code` = the catalog code**, from the spec's `**Catalog entity code:**` line (NOT `table_name`, which holds the deployed / dialect / silo name). Default to `table_name` only when the line is absent.
- **`entities.catalog_owner_module`** = the owner-module slug from the spec's `**Catalog owner:**` line (an `embedded_master` provisioned locally as a placeholder while its catalog owner module is absent); `''` when the line is absent (this module owns the entity (`role = master`), or it is local). Soft string, not an FK.
- **`entities.entity_type`** = the class from the spec's `**Entity type:**` line; **`'unclassified'` (never `''`) when absent.** Must be one of the six CHECK values.
- **`entities.catalog_entity_aliases`** = **APPENDED** to on a reuse/merge that renames an incoming entity onto an existing host (read the host's current array, push each new `{alias_code, source_domain, source_module, decided}` element, write back). **Never rewrite or drop prior elements**; a plain `create_entity` leaves it at `[]`.
- **`modules.catalog_module_code`** = the catalog blueprint / `system_slug` the module was provisioned from; the top-level columns `domain_code`, `access_scope`, and `icon_name`; plus the `modules.settings` keys (`naming_mode`, `module_kind`, `catalog_snapshot`, `promotion_decisions`), on `create_module` / `update_module`.
- **`roles.catalog_role_code`** = the catalog persona/role slug a role was provisioned from, on every `create_role`.
- **Codes are write-once at create.** The two scalar codes (`catalog_entity_code` / `catalog_module_code`) are set on the create call and **never re-sent on a later rename** — a rename touches `table_name` / `module_slug` only. Core enforces immutability-once-non-empty, so a re-send of a *changed* value is rejected; a re-run that re-sends the *same* value is a harmless idempotent no-op.

**4a. Module**, If missing, `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<tagline>"`, `module_type: "<frontmatter_module_type>"` (defaulting to `"domain"`), **`catalog_module_code: "<source blueprint code / system_slug>"`** (write-once lineage; the catalog blueprint this module was provisioned from, or `system_slug` for greenfield), the top-level columns **`domain_code`** (from the spec's frontmatter `domain_code`), **`icon_name`** (from the spec's frontmatter `icon_name`), and **`access_scope`** (from the Stage 2.5 resolved scope — record `basic` / `full` so future re-deploys read it back at Stage 2.5 step 2 and never re-ask), and the **`settings`** provenance keys (`settings.naming_mode` from the spec's `naming_mode`, `settings.module_kind` from `module_kind`, `settings.catalog_snapshot` from the spec's frontmatter `reconciled_against_catalog_snapshot`, `settings.promotion_decisions` from the frontmatter when present). If it already exists, `update_module` to refresh `module_name`, `description`, and (if missing) `module_slug` from the model, and fill any **empty** provenance keys (do not overwrite a non-empty `catalog_module_code`; merge `settings` keys rather than replacing the object). **`access_scope` (top-level column) is the exception to "fill only empty"** — when Stage 2.5 resolved a scope (whether from the spec directive or a fresh prompt), write it even if a prior value exists, so an explicit re-choice (e.g. the user re-deploys the spec under a new scope) sticks; a deploy that merely read the live value back at step 2 re-writes the same value (idempotent no-op). **Never flip `module_type`** on a re-deploy of a domain module — promotion is the explicit Stage 2d Branch B flow, not an inferred update. Never create a duplicate module with the same `module_slug`. The `alias` field is gone, do not pass it.

**4a payload checklist — confirm before sending `create_module` (and the create path of `update_module`).** The provenance keys below are the ones most often dropped, because they come from the spec **front-matter** rather than the entity tables the rest of the deploy reads, so a script built straight from §3 omits them silently. A module created without them looks correct in the UI but is invisible to catalog lineage, the analyst's re-reconcile, behavior discovery, and every `use-*` skill (they read these values to group the catalog and detect drift). Confirm every row is in the payload before you send it:

| Payload key | Source (spec front-matter) | `hiring-starter` example | Notes |
|---|---|---|---|
| `module_name` | `system_name` | `HIRING-STARTER` | |
| `module_slug` | `system_slug` | `hiring-starter` | |
| `description` | `tagline` | `Hiring Starter` | ≤40-char selector chip |
| `module_type` | `module_type` (default `domain`) | `domain` | never flip on re-deploy |
| `catalog_module_code` | catalog blueprint code the module was cloned from, else `system_slug` (greenfield) | `hiring-starter` | **write-once** lineage |
| `domain_code` | `domain_code` | `ATS` | top-level column |
| `icon_name` | `icon_name` | `users` | top-level column |
| `settings.module_kind` | `module_kind` | `starter` | |
| `settings.naming_mode` | `naming_mode` | `agent-optimized` | |
| `settings.catalog_snapshot` | `reconciled_against_catalog_snapshot` | `2026-06-25T15:12:29Z` | **the key renames** — front-matter `reconciled_against_catalog_snapshot` → settings `catalog_snapshot` |
| `access_scope` | Stage 2.5 resolved scope (`access_scope`, else resolved at deploy) | `full` | top-level column; `basic` / `full` |
| `settings.promotion_decisions` | `promotion_decisions` | _(omitted)_ | include **only** when the front-matter carries it |

Complete payload — copy this shape and fill each value from the front-matter; do **not** reconstruct it from memory (that is how keys get dropped). The `call()` wrapper is the Bun-script transport from the Data fidelity section of SKILL.md:

```typescript
await call("create_module", {
  data: {
    module_name: "HIRING-STARTER",              // system_name
    module_slug: "hiring-starter",              // system_slug
    description: "Hiring Starter",              // tagline (≤40-char selector chip)
    module_type: "domain",                      // frontmatter module_type, default "domain"
    catalog_module_code: "hiring-starter",      // catalog blueprint code, else system_slug — WRITE-ONCE
    domain_code: "ATS",                         // frontmatter domain_code (top-level column)
    icon_name: "users",                         // frontmatter icon_name (top-level column)
    access_scope: "full",                       // Stage 2.5 resolved scope (top-level column)
    settings: {
      module_kind: "starter",                   // frontmatter module_kind
      naming_mode: "agent-optimized",           // frontmatter naming_mode
      catalog_snapshot: "2026-06-25T15:12:29Z", // frontmatter reconciled_against_catalog_snapshot (renamed)
      // promotion_decisions: [ ... ],           // ONLY when frontmatter carries it
    },
  },
});
```

On the **`update_module` reconciliation path** (module already exists) the same keys apply, but fill only **empty** provenance keys and **merge** `settings` rather than replacing the object (never overwrite a non-empty `catalog_module_code` — it is write-once). `access_scope` (top-level column) is the one exception: always re-write it from the Stage 2.5 resolution. The create-vs-update rules are spelled out in the 4a paragraph above; this checklist and template are the point-of-use restatement so nothing is dropped at the call site.

**Master-model branch.** When frontmatter `module_type: master`, 4a takes the master-model resolution from Stage 2a (exact-slug match → entity-overlap match → create-new). For the exact-slug-match branch with a slug rename approved by the user, also run the rename cascade in 4b-rename below. For entity-overlap consolidation of multiple sibling masters, the per-source consolidate decisions feed into 4c-merge-master.

**Scaffold pass.** After 4a's module create-or-update, run the standard scaffold (Stage 2a-scaffold steps 2–5): create permissions per tier (idempotent), create the hierarchy chain tagged `origin = "model"` (domain) or `"model_master"` (master), create default roles per tier using the §9.1-resolved role slugs (read verbatim, not reconstructed from the module slug) with `origin` tagged matching the module type **and `catalog_role_code` stamped from the §9.1 baseline-role slug** (lineage; VALUE-only, write-once), attach `role_permissions`, and populate the six module-record FK / column references. Each step is idempotent on re-run. Surface the three-permission upgrade case as `✨ <slug>:admin / <slug>_admin role` plan lines.

**Module-record wiring is a discrete `update_module`, not a side effect of creating roles — and it is the scaffold step most often dropped.** Once the permissions and roles exist, `update_module` (by numeric module `id`) sets the six module-record references: `view_permission = "<slug>:read"` (a text column the platform otherwise leaves at its `user:read` default), and the numeric FKs `manage_permission_id` / `default_viewer_role_id` / `default_manager_role_id` (otherwise null), plus `admin_permission_id` / `default_admin_role_id` under `access_scope: full` only (left null under `basic`), and the `access_scope` column itself. Resolve each permission name / role slug to its id at write time (`read1` / `ensure`, never off a create response). Skipping it leaves the module header showing `user:read` and the default-role pickers empty even though per-entity RBAC is correct; Stage 5's module-scaffold check fails loud on it. Canonical procedure: `references/stage-2-reconcile.md` §2a-scaffold step 5.

**Role-slug normalization (defense-in-depth; `roles.slug` is `^[a-z0-9_]+$`).** `module_slug` may contain hyphens (`ben-admin`), but `roles.slug` may not. The analyst's §9.1 already emits every baseline and persona role slug with `-`→`_` applied (`ben-admin` → `ben_admin_viewer`), and this scaffold reads those slugs **verbatim** rather than re-deriving `<slug>_<tier>`. As a backstop, **whenever the deployer constructs or writes a role slug, replace every `-` with `_` first.** This covers every path that could rebuild `<module_slug>_<tier>` from a hyphenated module slug — the baseline scaffold here, the functional-ownership role lookups in 4l, and the master-rename cascade in 4b-rename — plus any stale or hand-edited spec whose §9.1 slug slipped through with a hyphen. A hyphenated `roles.slug` is rejected by the platform's `^[a-z0-9_]+$` constraint, so a re-derived `ben-admin_viewer` fails `create_role` / `update_role` even though the module and its `ben-admin:read` permission are both valid. This mirrors the persona-slug derivation in 4k, which already lowercases and converts hyphens to underscores.

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

**4b. Permissions and hierarchy.** Permission creation itself is owned by the Stage 2a-scaffold pass (run as part of 4a's create-or-update): it iterates the §8.1 Permissions catalog index in table order and creates every missing row, passing the §8.1 `description` cell verbatim — baseline tiers (`<slug>:read`, `<slug>:manage`, `<slug>:admin`) and workflow tiers alike. **Do not restate or override those descriptions here.** 4b's responsibility is the **permission hierarchy chain** plus the re-run reconciliation that follows.

Then ensure the **permission hierarchy chain** exists via `create_permission_hierarchy` so broader (including) permissions transitively grant narrower (included) ones (see use-semantius `references/rbac.md` § "Set Up Permission Hierarchy"). A row reads as `including_permission_id` ── *includes* ──▶ `included_permission_id`:

- For three-permission models: `including_permission_id` = `<slug>:admin`, `included_permission_id` = `<slug>:manage`; AND `including_permission_id` = `<slug>:manage`, `included_permission_id` = `<slug>:read`.
- For two-permission models: `including_permission_id` = `<slug>:manage`, `included_permission_id` = `<slug>:read`.

`read_permission_hierarchy` first with `including_permission_id=eq.<including_id>&included_permission_id=eq.<included_id>` to check whether the row already exists (re-runs are idempotent). Create only missing rows. **Never invert direction** — the narrower permission must never appear on the including side (that would mean the narrower one "includes" the broader, which breaks RBAC).

**Re-run reconciliation.** When the module already exists with the legacy two-permission baseline but the current model has been upgraded to need three (any §3 entity now carries `**Edit permission:** admin`), the deploy adds the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row additively. Surface this in the Stage 3 plan as `✨ saas_expense_tracker:admin` and `✨ admin → manage` so the user can see the upgrade. Never delete or rename existing permissions or hierarchy rows.

**4b-rename: master-model rename cascade.** When a master-model deploy resolved Stage 2a via exact-slug or entity-overlap match AND the user opted to rename the existing master to the model's `system_slug` (e.g. `vendors` → `vendor_management`), coordinate the cascade. Platform behavior (confirmed):

- `modules.module_slug` rename works on populated modules.
- Permission codes whose names embed the slug (`vendors:read`) do not auto-rename. The deployer explicitly calls `update_permission`.
- Default-role slugs (`vendors_viewer`) do not auto-rename. The deployer explicitly calls `update_role`. (Permitted by `system_role_slug_immutable`: only `origin = "system"` slugs are locked; `model` / `model_master` are deployer-rewritable.)
- Role-permission links are FK-based and don't need to be touched.
- Entity `module_id` FKs and cross-module `permission_hierarchy` rows reference by id; no rename needed.

Orchestration sequence per rename:

1. `update_module` to set new `module_slug`, `module_name`, `description`, AND `view_permission = "<new>:read"` together (the text-column natural-key reference embeds the slug; write it in the same update).
2. `update_permission` for each of `<old>:read`, `<old>:manage`, `<old>:admin` (the latter only when it exists). New `permission_name` reflects the new slug.
3. `update_role` for each of `<old>_viewer`, `<old>_manager`, `<old>_admin` (the latter only when it exists). New `slug` reflects the new module slug, with `-`→`_` applied per the role-slug normalization rule in 4a (a hyphenated new module slug must still yield an underscore-only `roles.slug`).

Roughly 6–8 writes for a typical master rename. Each step is a pure name swap with no FK changes, so the cascade is **forward-recoverable**: if any step fails partway, the catalog is in a half-renamed state (some records on the new slug, others still on the old), and re-running the deploy completes the cascade. At the start of each rename pass the deployer reads the current `module_slug`, `permission_name`, and `role.slug` values and only issues `update_*` calls for records still pointing at the old slug. No rollback path (PostgREST is stateless and has no transaction envelope); forward recovery is the only recovery model.

Surface in the Stage 3 plan as a `🔁 Renaming master module:` block listing each old → new pair (module + permission codes + role slugs). If any `update_*` call fails for a structural reason (e.g. `update_module` rejects the slug rename), stop and surface a 🛑 with the platform error.

**4c. Entities**, Walk model §2 in order and apply each entity's bucket decision:

- 🔒 Built-in → skip entirely. Do not `create_entity` for `users`, `roles`, etc. The §3 `**Edit permission:**` annotation, if any, has no effect on built-ins.
- 🟢 Shared-master match (Branch A) → skip `create_entity`. The target is the existing entity in the master module. Field diffs on the master entity are applied additively in 4d as usual. JSON arrays (`computed_fields`, `validation_rules`) are merged with `source_module` tagging per 4e-merge instead of wholesale-replaced. The cross-module wire-up happens in 4i. **Provenance:** the master entity already carries its own stamped `catalog_entity_code` / `entity_type` — do NOT restamp them (the codes are write-once). If the spec carries `**Catalog alias:**` line(s) on this host (this domain's blueprint called the concept by a different catalog code that reconciled onto the shared master), APPEND each element to the master's `catalog_entity_aliases` exactly as in the merge case below.
- ♻️ Same-module match → skip `create_entity`. **First converge the owning FK: if the live entity's `module_id` is NULL or does not equal this module's id, `update_entity` to set it** (repairs an entity stranded with a NULL `module_id` by an earlier buggy deploy — the scaffold converges, it does not skip a row just because it already exists). Then, if the model's `**Audit log:**`, `**Edit permission:**`-derived `edit_permission`, `**Label parent:**`-derived `label_parent`, `singular_label`, `plural_label`, `description`, **`computed_fields`**, or **`validation_rules`** differ from the live entity, call `update_entity` to sync (for `label_parent`: set it to the spec's named FK when the line is present, or clear it to null when the spec omits the line and live carries a stale value). **Behavior depends on the host module's `module_type`:** for `module_type = "domain"`, `computed_fields` and `validation_rules` are **wholesale replacements** (existing behavior, see 4e); for `module_type = "master"`, they are **merged by `source_module` tag** (see 4e-merge). For `edit_permission` specifically: read the live entity's current `edit_permission` first, and only `update_entity` when the resolved permission name (e.g. `<slug>:admin` vs `<slug>:manage`) differs; surface the change to the user in the Stage 3 plan as a tier flip so they can sanity-check (a tier flip is a real RBAC change). Then fall through to 4d (field diff).
- ✨ New → `create_entity`. **Pass `module_id` = the id of the module this entity is being created in** (the Stage 2a-resolved domain module here; the master module's id under `promote-to-master`). This is **required** — the platform rejects a null `module_id`, and an entity that slips through with NULL belongs to no module (see the Model-to-Entity Mapping note). Pass `audit_log` from the §3 `**Audit log:**` line (default `false` when the line is missing or says `no`). Pass `view_permission: "<system_slug>:read"` and `edit_permission` derived from the §3 `**Edit permission:**` line: `"<system_slug>:admin"` when the line says `admin`, `"<system_slug>:manage"` otherwise (default, or when the line is absent). Pass `computed_fields` and `validation_rules` from the §3 sub-blocks (default `[]` when absent). For a master-module deploy (`module_type: master`), each `computed_fields` / `validation_rules` entry is tagged with `source_module = "<system_slug>"` before send. **Stamp the provenance columns on this same `create_entity` payload** (per "Provenance stamping" above): `catalog_entity_code` = the spec's `**Catalog entity code:**` (the catalog code, default `table_name`); `entity_type` = the spec's `**Entity type:**` (`'unclassified'` when absent); `catalog_owner_module` = the spec's `**Catalog owner:**` slug (a placeholder `embedded_master` whose owner is absent), else `''`. **Do NOT pass `label_parent` on this `create_entity`.** It names a `reference`/`parent` FK that 4d (or the second pass) has not created yet, and the platform validates `label_parent` against the entity's live fields at write time, so stamping it on the create payload fails whenever the line is present. It is applied later, in the **Spine pass** (a post-field `update_entity`; see below), only when the `**Label parent:**` line is present. It is a normal nullable property, not a write-once provenance code, so the deferred update re-points it freely. After creation, correct the `label_column` field title if needed with `update_field`.
- 🛑 Resolved as **merge** → skip `create_entity`. The target is the existing entity in the other module. Record the mapping; the merge is realized in 4d by adding the non-overlapping fields additively to the existing entity. **If the spec carries `**Catalog alias:**` line(s) on the host (a cross-domain identity renamed onto it), APPEND each `{alias_code, source_domain, source_module, decided}` element to the host's `catalog_entity_aliases`:** read the host's current array, push the new element(s) only when an equal `(alias_code, source_domain)` pair is not already present (idempotent on re-run), and `update_entity` with the extended array. Never rewrite or drop prior elements.
- 🛑 Resolved as **rename incoming** → `create_entity` using the new name. (Plan-level rewrite of `reference_table` values has already happened before this stage.)
- 🛑 Resolved as **rename existing** → attempt `update_entity` on the existing entity's `table_name` first, before any new creates. If the platform rejects the rename, stop and return to Stage 3, never continue silently. Once the rename succeeds, Semantius repoints every catalog-side `reference_table` automatically; no follow-up `update_field` pass is needed.
- 🛑 Resolved as **rename both** → do the existing-rename first, then `create_entity` for the incoming under its new name.
- 🛑 Resolved as **promote to shared master** (Branch B, option 1 of the four-option widget) → run 4c-promote (below). Plan line `📥 Promoting <entity> → <master>`.
- 🛑 Resolved as **abort** → stop Stage 4 entirely; tell the user to iterate on the model with the analyst skill.

**4c provenance checklist — confirm before sending `create_entity` (✨-New and rename-incoming paths).** Same point-of-use discipline as the 4a module checklist: the columns most often dropped are sourced from §3 annotation lines (and one *derived* value), not from the Fields table the rest of the entity build reads. An entity created without them deploys and looks correct in the UI, but its catalog lineage, class, placeholder-owner pointer, and behavior flags are gone — silently breaking the analyst's re-reconcile and every `use-*` discovery skill. Stamp every row on the **same** `create_entity` payload (provenance is values-only — never `create_field` these columns):

| Payload key | Source | `candidates` example | When absent |
|---|---|---|---|
| `catalog_entity_code` | §3 `**Catalog entity code:**` (the catalog code, not the deployed `table_name`) | `candidates` | default `table_name` — **write-once** |
| `entity_type` | §3 `**Entity type:**` (one of the 6 CHECK values) | `operational_workflow` | `unclassified` (never `''`) |
| `catalog_owner_module` | §3 `**Catalog owner:**` (placeholder `embedded_master` only) | `ats-candidate-crm` | `''` |
| `label_parent` | _Not stamped on this payload_ — the named FK does not exist yet at `create_entity` time. Applied in the **Spine pass** (post-field `update_entity`), only when the `**Label parent:**` line is present. | _(deferred)_ | omit here |

**`catalog_entity_aliases` is NOT on the create payload.** A plain `create_entity` leaves it `[]`. It is **APPEND-only**, and only on a reuse/merge that renames an incoming entity onto an existing host (§3 `**Catalog alias:**` line(s)): read the host's array, push each `{alias_code, source_domain, source_module, decided}` element, write back — never rewrite or drop prior elements. See the 🟢-shared-master / 🛑-merge bullets above.

Complete payload — copy this shape; fill every value from §3, do not reconstruct from memory:

```typescript
await call("create_entity", {
  data: {
    table_name: "candidates",                  // §2 table name (plural snake_case)
    singular_label: "Candidate",               // §3 Singular Label
    plural_label: "Candidates",                // §3 Plural label
    description: "A person known to the recruiting team, …",  // §3 Description — the FULL multi-sentence text, byte-for-byte (abbreviated here)
    label_column: "full_name",                 // §3 Label column
    module_id: 1034,                           // resolved id of the module this entity lands in (read_module) — REQUIRED, non-null
    view_permission: "hiring-starter:read",    // always <system_slug>:read
    edit_permission: "hiring-starter:manage",  // §3 Edit permission: admin → :admin, else :manage
    audit_log: true,                           // §3 Audit log: yes/no (default false)
    computed_fields: [],                       // §3 Computed fields sub-block (default [])
    validation_rules: [ /* … */ ],             // §3 Validation rules sub-block (default [])
    // ── provenance (values-only, same payload) ──
    catalog_entity_code: "candidates",         // §3 Catalog entity code — WRITE-ONCE
    entity_type: "operational_workflow",       // §3 Entity type (6-way CHECK)
    catalog_owner_module: "ats-candidate-crm", // §3 Catalog owner ('' when the line is absent)
    // label_parent is NOT passed here — the named FK doesn't exist yet; it is stamped in the Spine pass (post-field update_entity).
  },
});
```

**Which buckets stamp what** (provenance is written only on entity-provisioning paths):
- ✨ **New** / 🛑 **rename-incoming** → full stamp as above (`catalog_owner_module` from the line, else `''`).
- 📥 **promote-to-master** → full stamp, but `catalog_owner_module = ''` (the entity lands in its catalog home); never re-send `catalog_entity_code` on the later move (write-once).
- 🟢 **shared-master** / 🛑 **merge** (host already exists) → do **not** restamp `catalog_entity_code` / `entity_type`; only APPEND `catalog_entity_aliases` when a `**Catalog alias:**` line is present.
- 🔒 **built-in** / ♻️ **reuse-from** → no provenance writes (referenced, not provisioned; the existing row holds its own stamp).

**4c-promote: Branch B promotion.** When the user picked "Promote to shared master module" at Stage 2d-branch-b, the follow-up answers carry the host-module decision (existing master to join OR new master to create) and the manage option (1–4). 4c-promote orchestrates the move:

1. **Ensure the master module exists.** If the user picked "create new master," issue `create_module` with `module_type: "master"` and the chosen slug / name (`<system_name>` defaults to the slug humanized, e.g. `parties` → `Parties`), **stamping `catalog_module_code` and the `settings` provenance keys per 4a**. Then run the scaffold pass (Stage 2a-scaffold steps 2–5) so the master has its three permissions, three default roles (each with `catalog_role_code` stamped), and six module-record references. If the user picked an existing master, capture its id and skip create; if its scaffold has gaps (a master created in a prior tenant lifecycle before scaffolding was standard), the scaffold pass fills them now. Plan line: `🆕 Master module created: <slug>` for new masters, omitted for existing.
2. **Move the entity.** Read the entity's live `module_id` first; issue `update_entity` setting `module_id` to the master module's id **only when it isn't already there** (a re-run finds the entity already moved and skips the write — read-before-write, like every other Stage 4 op). The platform repoints every catalog-side FK that references this `table_name` automatically. **Confirmed:** `update_entity` accepts `module_id` change on a populated table; no DDL needed, FKs survive. **Provenance:** the entity now lives in its catalog home, so in the same `update_entity` clear `catalog_owner_module` to `''` (the placeholder pointer is satisfied — this module owns it now). Do **not** touch `catalog_entity_code` — it is write-once and was stamped at the entity's original create. (For the variant where `promote-to-master` *creates* the entity fresh in the master because it was never on a placeholder, the ✨-New `create_entity` stamping applies, but with `catalog_owner_module = ''` since the create lands in the catalog owner.)
3. **Tag JSON arrays with source.** For each entry in the moved entity's `computed_fields` and `validation_rules`, set `source_module = "<original_module_slug>"` so re-runs of either module can merge correctly (see 4e-merge). Done via `update_entity` setting the arrays.
4. **Cross-module wire-up** runs in 4i (every consumer gets its read inclusion, plus manage inclusion per the picked option).
5. **Seed master manager role** runs in 4j (snapshot copy of `<original>_manager` members into `<master>_manager`).

**4c-merge-master: master-vs-master consolidation (Path 2 cleanup).** When a master-model deploy resolved Stage 2a via entity-overlap match AND multiple source masters host the model's declared entities, the per-source consolidate decisions from Stage 2a feed in here. For each source master the user opted to consolidate:

1. **Move each affected entity.** `update_entity` to change `module_id` to the target master.
2. **Re-point consumer cross-module bridges.** For every cross-module `permission_hierarchy` row `(parent, child)` whose child is one of the source master's read/manage permissions (`<source_master>:read` or `<source_master>:manage`) AND whose parent is in a *different* module (i.e. an outside consumer, not the source master's own internal chain), check whether the equivalent target-master bridge already exists. If it does (e.g. the consumer was already wired to the target master via a prior merge or a Branch A wire-up), **leave the source bridge alone** — it now points at the orphan source-master permission, which is harmless because the source master is itself an orphan, and the deployer never deletes catalog rows. If the target bridge does not yet exist, call `update_permission_hierarchy` to set the child to the corresponding target-master permission (the row's id stays the same). Result: the consumer ends up with exactly one live bridge per tier to the target master, and any duplicate source-side bridges are left as inert orphans referencing the orphan source master.
   The source master's **internal** chain rows (`<source_master>:manage → <source_master>:read` tagged `origin = "model_master"`) are also left alone — they point at orphan permissions inside an orphan module, no functional effect.
3. **Leave source masters alone.** The deployer never deletes the now-empty source master, its permissions, its default roles, its `role_permissions`, or its intra-master hierarchy rows. They remain as quiet orphans in the catalog (see "No auto-deletion" rule below). An admin who notices may drop them manually; the verification report does not flag them.

Plan line: `📥 Merging master modules:` block listing each source → target pair.

**4d. Fields**, For each entity, create missing fields in model order with `create_field`. Skip auto-generated ones (`id`, `label`, `created_at`, `updated_at`, the `label_column` field, and the platform-derived composed-label columns `_label` / `<fk>_label`). **Reserved-name guard (defense-in-depth):** before any `create_field`, reject any `field_name` that starts with `_` or ends with `_id_label` — those are platform-reserved for the `_label` / `<fk>_label` columns and the platform rejects them too. A spec carrying such a name is an authoring bug; FAIL LOUD and route the user back to the analyst rather than attempting the write. Always include `width: "default"` and `input_type: "default"`. For FK fields whose `reference_table` is a built-in (`users`, `roles`, …) or a merged existing entity, point directly at that `table_name`, the platform doesn't care whose module owns it.

**Presence-conditional FK skip.** Before issuing a `create_field` for a reference / parent FK whose `reference_table` would target an entity declared in the spec via a §5 edge with `delete_mode: none (required-if-present)`, check whether the target entity is installed in the live catalog AND not in this deploy. If the target is absent in BOTH places, **SKIP the field create entirely**. No column is emitted and no constraint is created. Without this skip, a broken non-null restrict would land on every row; instead nothing is emitted. Plan line: `💤 Skipping FK <from>.<target_id> → <target_entity> — target not installed (presence-conditional)`. The skipped row is recorded in Stage 5's structured verification report.

**⚠ annotation handling.** For each parsed §7 lifecycle row marked `data_quality_flagged` (carrying `⚠ state-machine shape` or `⚠ unresolved gate`), the deployer **SKIPS or FAILS LOUD**: do NOT auto-resolve, do NOT silently provision. The default is SKIP with a Stage 5 line `⚠️ Skipped on ⚠ flag: <entity>.<state> — <verbatim reason>`. When the ⚠ row is one whose presence the rest of the deploy depends on (e.g. a `⚠ unresolved gate` on a state that another stage references), the deployer FAILS LOUD with the verbatim reason, asking the user to fix the source data and re-run the analyst.

**Computed-field columns are deployed as `input_type: "disabled"`.** Before issuing each `create_field`, check whether its `field_name` appears in the parent entity's `computed_fields[].name` list. If yes, override `input_type` to `"disabled"` instead of `"default"`, regardless of anything else the model says about that field's input_type. The platform silently overwrites caller-supplied values for any column listed in `computed_fields` (see use-semantius `references/data-modeling.md` § "Evaluation semantics" — *"Caller-supplied values for a computed field are silently overwritten"*), so the UI hint must match the semantics — otherwise the auto-generated form lets users type into a field whose value will be clobbered on save. `"disabled"` (greyed-out, cannot receive focus) is the right mode rather than `"readonly"` (rendered as plain text but still focusable / submittable): the value is platform-owned, not user-corrected, and the greyed-out treatment signals that unambiguously. This is a deployer-enforced consistency rule between two model declarations the user has already made consistent in intent; the JsonLogic stays verbatim and the model file is not modified.

For ♻️ same-module matches and 🛑 merges, do not just create the missing fields and stop — walk every model field against its live counterpart and emit `update_field` for each property that has drifted. The diff is essentially free: one `read_field` per entity (filter `table_name=eq.<table>`) already returns every property in a single round-trip, and local comparison is microseconds. Skipping the diff is the reason changed descriptions, title corrections, enum extensions, and same-primitive format adjustments fail to land on re-runs.

For each model field on this entity:

- **Field absent live** → `create_field` as before (auto-generated fields `id`, `label`, `created_at`, `updated_at`, the entity's `label_column`, and the composed-label columns `_label` / `<fk>_label` are still skipped).
- **Field present live** → compute the property delta against the model and emit **one** `update_field` carrying every changed key. Issue one call per drifted field (not one per property) so the audit log records a coherent change set per column. Properties to compare:
  - `title`, `description` — sync to model value.
  - `required`, `searchable`, `width`, `input_type` — sync to model value.
  - `format` — sync to the model value and let the platform decide. Same-primitive changes are accepted by Semantius (TEXT family: `text`/`multiline`/`html`/`json`/`email`; numeric: `integer`/`number`; temporal: `date`/`datetime`). Cross-primitive changes return a primitive-change error — quote the error back verbatim and route the user to the analyst skill for a model-level rethink. The deployer doesn't keep its own primitive taxonomy; Semantius is authoritative.
  - `enum_values` — only sync **additive** extensions (model values the live row doesn't have). Removals (live values the model omits) are unsafe — existing rows may carry the removed value and the constraint tightening will fail at write time. Removals are caught in Stage 2 and surfaced as a 🛑 in Stage 3, never silently applied here.
  - `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` (FK metadata) — sync to model value.

The `disabled` rule from Stage 4d's create path also applies on re-runs: for every existing field whose name appears in `computed_fields[].name`, if its live `input_type` is anything other than `"disabled"`, include `input_type: "disabled"` in the same `update_field` call. This catches both newly-introduced computed fields (the column existed first, then the model added it to `computed_fields`) and corrections to live data where someone manually toggled the input_type to an editable mode. Live fields still carrying the legacy `"readonly"` (from deploys made before this skill switched modes) are migrated to `"disabled"` on the next re-run by this same rule.

**Don't blind-upsert.** Calling `update_field` on every field regardless of drift is tempting because it's one less branch, but it bloats the audit log, masks live drift that the user may want to see (e.g. someone tightened a description live and the model is stale — the diff exposes that, a blind overwrite silently destroys it), and is strictly slower (more write round-trips than necessary). The diff is the fast path.

**4e. Apply write-side rules (computed_fields, validation_rules).** The platform validates `computed_fields[].name` against the entity's fields at deploy time, so these arrays can only be set once every field they reference exists. Sequence:

- For ✨ **new entities**, pass `computed_fields` / `validation_rules` on `create_entity` only when **every** referenced field is also auto-created by Semantius (rare: typically only the `label_column`). The safer default is to pass `[]` (or omit) on `create_entity`, then call `update_entity` with the full arrays after 4d has created the referenced fields. Either path lands the same trigger.
- For ♻️ **same-module matches** and 🛑 **merges**, call `update_entity` with the model's arrays after 4d's field diff has synced the underlying columns. If a referenced column doesn't yet exist on the live entity but is being added in this run, sequence the field create first.
- For 🔒 **built-ins**, never push `computed_fields` or `validation_rules` from the model onto a built-in entity — those tables run platform logic and the model's rules would conflict. Stop and surface this to the user before any write.

After the call, surface to the user: *"Applied N computed_fields and M validation_rules on `<table_name>`."* If `update_entity` rejects the arrays (malformed JsonLogic, unresolved field name, duplicate `code`), the error message names the offending entry's array index — quote it back to the user and ask the analyst skill to fix the model before re-running. Do not attempt to repair JsonLogic in the deployer.

**4e-merge: master entity JSON-array merge with `source_module` tagging.** For entities whose host module's `module_type = "master"` — which includes Branch A wire-ups, 4c-promote target masters, and master-model deploys — `computed_fields` and `validation_rules` are **merged**, not wholesale-replaced. The merge model lets multiple consuming models contribute rules to the same master entity without trampling each other.

Each entry carries an optional `source_module` field. The deployer sets it automatically when emitting an entity update: the value is the `system_slug` of the model currently being deployed. Legacy entries without `source_module` (created before this design, or admin-edited via the UI) are treated as `source_module = "user"` for rule purposes.

**Merge logic (per array, per master entity).** Read the live entity's arrays first; build the merged result by walking each incoming entry against the live state. The natural key is `name` for `computed_fields` and `code` for `validation_rules`, treated **globally within the entity** — `source_module` is reconciliation metadata, not part of the uniqueness key.

1. **Incoming entry, same key, same `source_module` as a live entry** → incoming replaces the live entry (per-source wholesale replacement, scoped). Tag the merged entry with the same `source_module`.
2. **Incoming entry, same key, different `source_module` from a live entry** → conflict. Surface as a 🛑 via `AskUserQuestion` with the comparison block printed as prose first:
   - keep live (drop incoming, recommended when live is admin-authored or from a stable source);
   - keep incoming (replace live, sets `source_module` to the incoming model's slug);
   - rename the incoming code (e.g. `vendor_email_required` → `<incoming_slug>_vendor_email_required`) and add as a new entry;
   - abort the deploy.
   Rule 2 always beats rule 4: a key collision is a real conflict even when the live owner isn't part of this deploy.
3. **Incoming entry, no key match in live** → additive: append to the merged array, tagged with the incoming model's `source_module`.
4. **Live entry whose key is not touched by any incoming entry** → leave alone, regardless of `source_module`. Entries from other consumers and admin-created entries (`source_module = "user"`) are preserved across re-runs.

Send the merged array via `update_entity`. The platform replaces the column wholesale (it does not know about the merge); the deployer is the entity that owns reconciliation.

**Source-tagging the platform's own rules.** The three platform-installed validation rules (`origin_immutable_roles`, `system_role_slug_immutable`, `origin_immutable_hierarchy`) are tagged `source_module: "platform"`. Treat `"platform"` as a reserved source name: the deployer never emits it for model-driven rules, and the merge always leaves `"platform"`-tagged entries alone (rule 4).

**Where the merge applies.** Only to entities hosted in a `module_type = "master"` module. Domain entities keep wholesale-replacement semantics from the existing 4e flow. Branch A wire-ups never `create_entity` the master entity (it already exists); they only contribute additive fields (4d) and merged JSON entries (4e-merge).

**4f. Apply read-side rules (select_rule, input_type_rule).** Read-side rules sit one layer up from write-side rules: `select_rule` filters per-row visibility (an entity-level RLS policy), and `input_type_rule` overrides each field's UI mode per-record at form render. Same prerequisite as 4e — every field referenced inside either rule's JsonLogic must already exist — so 4f runs **after** 4d (field diff) and **after** 4e (write-side rules) so error messages stay attributable to the right rule type.

Sequence per entity:

- **`select_rule` (per entity).** Read the model's parsed `select_rule` object for this entity. Compare against the live value (Stage 2's `read_entity` already returns it):
  - Model carries `Select rule` heading with a non-empty object AND live is empty → `update_entity` with `data.select_rule = <model_object>`. **Warn the user before the call:** *"About to apply `select_rule` to `<table_name>`. After this, callers will see only rows matching the rule. Confirm rollout?"* This is a medium-risk read-visibility change (rows that callers used to see disappear); the user must explicitly confirm.
  - Model carries `Select rule` heading with the same object as live → no-op.
  - Model carries `Select rule` heading with a non-empty object that differs from live non-empty → `update_entity` with `data.select_rule = <model_object>` after showing the diff to the user and confirming. Same medium-risk warning as above.
  - Model carries `Select rule` heading with `{}` AND live is non-empty → `update_entity` with `data.select_rule = {}`. The platform drops the generated `FOR SELECT` RLS policy function. **Warn the user explicitly:** *"About to remove `select_rule` from `<table_name>`. After this, all rows become visible to anyone with `view_permission`. Confirm?"* This is a medium-risk widening change; the user must confirm.
  - Model omits the `Select rule` heading entirely AND live is empty → no-op.
  - Model omits the `Select rule` heading entirely AND live is non-empty → **ambiguous**. Do not silently clear (same rule as `computed_fields` / `validation_rules` drift). Surface the live rule to the user: *"`<table_name>` has a live `select_rule` but the model omits the heading. Keep the live rule (round-tripped through optimizer would have echoed it) or remove it (pass `{}` to drop the RLS policy)?"* Wait for a decision; do not proceed.

- **`input_type_rule` (per field, then in aggregate).** For each entry in the entity's parsed `Input type rules` list:
  - Resolve the entry's `field` against the entity's live field list (it must exist — Stage 4d created it if it didn't). Call `update_field` on `<table_name>.<field>` with `data.input_type_rule = <entry.jsonlogic>`. Pass the JsonLogic object verbatim; do not normalize, reformat, or attempt to validate the return-type. The platform's per-render fallback to the static `input_type` handles malformed or out-of-enum returns gracefully.
  - For each live field whose `input_type_rule` is non-empty but whose name does NOT appear in the model's `Input type rules` list: **ambiguous, same rule as the entity-level case above**. Do not silently clear. Surface the field + its live rule to the user and ask whether to keep or remove (pass `{}` to clear).

- For 🔒 **built-ins**, never push `select_rule` or `input_type_rule` from the model onto a built-in entity or its fields — those tables run platform logic and the model's rules would conflict. Stop and surface this to the user before any write (same posture as the write-side built-in guard in 4e).

After the per-entity 4f pass, surface to the user a one-line summary: *"Applied select_rule on `<table_name>` and N input_type_rule(s) across `<list_of_fields>`."* If `update_entity` or `update_field` rejects the JSON (the `select_rule_is_object` constraint trips, a malformed JsonLogic structure, etc.), the error message names the offending entry — quote it back to the user and ask the analyst skill to fix the model before re-running. Do not attempt to repair JsonLogic in the deployer.

**Audit-trail surface.** Read-visibility changes (any `select_rule` create/modify/remove on an entity that already holds rows) deserve a one-line entry in the Stage 5 verification summary alongside permission changes — they're the read-side analog of an `edit_permission` flip and carry the same "user noticing 'why can't I see X anymore'" failure mode if rolled out silently.

**4g. Built-in extensions.** If the user confirmed additive field extensions on a built-in (e.g. the model declares `users.department_id` and the built-in doesn't have it), create those fields after all custom entities are done. Do not modify existing built-in fields, do not change formats or enum values.

**Second pass.** After all entities exist, create any self-reference fields (e.g. `departments.parent_department_id` → `departments`) and any cross-reference pairs that had to wait (e.g. the mutual `departments.manager_user_id` ↔ `users.department_id`).

**Spine pass (`label_parent`).** After the second pass — so every `reference`/`parent` FK now exists, including self-references and the deferred cross-reference pairs — stamp each freshly-created entity's identity spine. For every ✨-new or rename-incoming entity whose spec carries a `**Label parent:**` line, `update_entity` with `data.label_parent = "<fk_field>"`. **Read-before-write:** skip the call when the live entity's `label_parent` already equals the spec value (idempotent re-run). This is deferred out of 4c for the same reason 4e defers `computed_fields` / `validation_rules` — the value names a field that must exist first, and the platform validates it at write time; stamping it on `create_entity` rejects whenever the FK has not been created yet. The ♻️ same-module branch in 4c already re-points `label_parent` via `update_entity` on drift (its fields exist), so it needs no spine-pass entry; only newly-created entities do. Stage 5 still round-trips `label_parent` against the spec, so a missed stamp surfaces in verification.

After each entity's fields are done, share the UI link:
`{ui_baseurl}/<module_slug>/<table_name>` — capture `ui_baseurl` once from `getCurrentUser` (`semantius call crud getCurrentUser | jq -r .ui_baseurl`, e.g. `https://<org>.semantius.app`) and reuse it for every link below. Never hardcode the org host. URL paths use the lowercase `module_slug`, never the display `module_name`.

**4h. Cross-model link suggestions.** After all in-module creates and built-in extensions are done, walk the Proposed list from Stage 3 and execute each confirmed row as an additive `create_field` call. **Read-before-write:** check the source entity's live fields first (`read_field` filtered by `table_name`); if the target FK column (`<target_singular>_id`, or the user-supplied alternative) already exists, the row landed on a prior deploy — skip the create as a clean idempotent no-op. Do not re-create it and do not count it as a failure.

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
`{ui_baseurl}/<from_module_slug>/<from_table>` (URL uses the source module's lowercase `module_slug`; reuse the `ui_baseurl` captured from `getCurrentUser` above).

**Skip silently** for any Stage-3 confirmed proposal the platform rejects (e.g. the resolved target was renamed between Stage 2g inspection and 4h write). Surface the failure in the verification summary; do not retry. (An *already-exists* result is not a rejection — the read-before-write check above turns it into a clean no-op, so re-runs don't pad the "parked" count with rows that actually landed on a prior deploy.) Skipped, ambiguous-and-skipped, dormant, and resolved-but-declined rows are listed in the verification summary so the user can see how many §6 hints landed and how many parked.

**Stale rows in the model.** §6 rows whose target is dormant today may resolve on a later deploy of any model. The user can refresh by re-running this skill against any model whose §6 references the newly-arrived target; nothing is persisted on module metadata, so the redeploy is the trigger.

**4i. Cross-module permission inclusions.** After in-module hierarchy is set up (4b), and after any master-promotion entity moves (4c-promote, 4c-merge-master), wire up the cross-module `permission_hierarchy` rows that bridge consumers to masters. The shape:

- **Read inclusion (always).** For every consumer module of a master entity: a row with `including_permission_id = <consumer>:read.id`, `included_permission_id = <master>:read.id`, `origin = "model_master"` (the consumer's `:read` includes the master's `:read`). Created at Branch B promotion (for both `<original>` and `<incoming>`) and at every Branch A wire-up (one per new consumer). Without this row, consumers can't see the shared entity through their own module's read permission.
- **Manage inclusion (conditional, per consumer).** A row with `including_permission_id = <consumer>:manage.id`, `included_permission_id = <master>:manage.id`, `origin = "model_master"` (the consumer's `:manage` includes the master's `:manage`). Created only when this consumer's manage answer (Stage 2d-branch-a binary prompt, or Stage 2d-branch-b option 2/3/4) opts the consumer into write access via hierarchy rather than role membership. Branch A never modifies prior consumers' inclusions — each consumer's decision is recorded independently.

Idempotency: `read_permission_hierarchy` filtered by `(including_permission_id, included_permission_id)` first; create only on exit 1. Rows tagged `origin = "user"` are never touched (admin's manual additions are sovereign). Rows tagged `origin = "model_master"` may be updated by the deployer (including / included FK adjustments during master-rename via 4b-rename or master-merge via 4c-merge-master) but **never deleted by the deployer** (see "No auto-deletion" below).

Plan line: `🔗 Permission inclusions (cross-module, new)` block (see Stage 3 plan vocabulary).

**4j. Seed master manager role (Branch B only).** Right after 4c-promote moves the entity into the master, snapshot the current members of `<original_module>_manager` into `<master>_manager`. One-time copy at promotion (not a dynamic link; new `<original>_manager` members added later don't auto-inherit master stewardship). Runs unconditionally regardless of which Stage 2d-branch-b option (1–4) the user picked — the role exists in all four; the seed is independent of any hierarchy inclusion the user added on top.

Mechanics:

```bash
# Read original manager role members
semantius call crud read_user_role '{"filters": "role_id=eq.<original_manager_role_id>"}'
# For each member, create_user_role into <master>_manager (idempotent: read first, skip if user already in master_manager)
semantius call crud create_user_role '{"data": {"user_id": <user_id>, "role_id": <master_manager_role_id>}}'
```

Plan line: `🌱 Seeded <master>_manager with N members from <original>_manager`.

**Gate B fires** if the seed produces zero members (the original module's manager role is empty). Surface as 🟡 in the plan with explicit user confirmation per Gate B (defined at the end of this file).

**4k. Persona provisioning + RACI.** **Skipped entirely under the Stage 2.5 `basic` projection** (no personas, no RACI). For each persona named in the spec's frontmatter `persona` list (cross-checked against §9.1 RACI `actor` column at parse time).

**Mode pre-step.** Resolve the module's RACI mode: **honor the spec's `**RACI mode:**` line** if present (the analyst already asked — do NOT prompt). If absent (old spec / headless analyst run), apply the catalog-aware fallback: `living` when ≥1 module already uses RACI (`GET /processes?limit=1` non-empty, or any `modules.settings.raci_mode = living`), else `documentation`. If the live instance lacks the RACI engine (no `processes` entity registered), force `documentation`. Surface the resolved mode in the Stage 3 plan (`🧭 RACI mode: <mode>`). **Role creation (point 1) and the write-tier grant happen in both modes**; gate-grant compilation (point 2) is the **documentation** realization; the **living** realization (below) adds the catalog matrix + live-enforcement rules.

1. **Idempotent role check.** Compute the persona slug as lowercased snake-case (UPPER-CASE hyphen-separated → lowercase underscores): `RECRUITING-RECRUITER` → `recruiting_recruiter`. Then `read_role --single by slug=<persona_slug>`.
   - **Exit 0 (exists)**: reuse. Never recreate under a different module; persona roles are global to the tenant once minted.
   - **Exit 1 (missing)**: `create_role` with `slug = <persona_slug>`, `role_name = <UPPER-CASE original>`, `origin = "model"`, `module_id = <installing-unit module id>` (so the persona role is tracked under whoever first introduces it), and **`catalog_role_code = <UPPER-CASE original persona name>`** (provenance lineage; the catalog persona this role was provisioned from, stamp as a VALUE, never `create_field` the column; write-once).
2. **Grant resolution per RACI row.** For each parsed §9.1 RACI row whose `actor` is this persona AND `kind = persona`:
   - For `raci = responsible | accountable`: walk the row's parsed grant list (from the `realization` column's `grant gates [<list>]` form). For each gate code in the list, **resolve the actual permission code using the row's `grant_module` column** (the entity-owning-module lookup result). The resolved code = `<grant_module>:<verb>`. NEVER assume the installing-unit prefix — the gate's prefix follows the entity, which may live in another module if a previous install created it there.
   - Idempotent grant: `read_role_permission --single by role_id=eq.<persona_role_id>&permission_id=eq.<resolved_perm_id>` → `create_role_permission` on exit 1. The grant FK points at whatever module currently owns the gate's entity.
   - Also grant the persona on the entity's write tier (`<entity_owning_module>:<tier>` where `<tier>` is the suffix of the entity's resolved `edit_permission` — i.e. the `manage` / `admin` / `<narrow_suffix>` value Stage 1 derived from the entity's §3 `**Edit permission:**` line). The spec carries the write tier as that `**Edit permission:**` line, not as a literal `write tier` column (that column name is the blueprint's; the analyst transforms it into `**Edit permission:**` on emission). Same idempotent pattern.
   - For `raci = consulted`: grant an advisory read on the gate's owning module (`<entity_owning_module>:read`). Idempotent. The row's `consult_mode` (`read` / `notify` / `block`) is **not** behaviorally distinguished in `documentation` mode — all three collapse to the advisory-read grant. The `notify` / `block` semantics are realized only in `living` mode (carried on the `raci_assignments` row and enforced by the `has_consultation` C-block rule + the `emits_events` notify trigger; see the living-mode materialization below).
   - For `raci = informed`: defer to Stage 4m (handoff wiring) — no role grant; the notification is a side effect.
3. **Skill actor rows.** RACI rows where `kind = skill` resolve to a **role held by an agent user** (`users.is_agent = true`), the agent-native parallel to a persona. Idempotent: `read_role --single by slug=<skill_slug>` → `create_role` on miss (`origin = "model"`); ensure an agent service user exists (`read_user` by a stable external_id → `create_user` with `is_agent = true` on miss) and hold the role via `create_user_role` (idempotent). Then treat the skill's role_id exactly like a persona's for grants and (in living mode) `raci_assignments`. _(The matrix-level "Accountable must be human" guard and JIT agent tokens are not enforced here.)_
4. **Idempotency**: persona provisioning is safe to re-run; a second-installer's run on an existing persona just adds grants the first run didn't cover. The role itself is reused.

Plan line per persona: `👥 Persona: <slug> (<N> grants on <list of grant modules>)`.

**Living mode — materialize the RACI matrix + enforcement.** When the resolved RACI mode is `living`, after role + write-tier grants, materialize the analyst's RACI plan via the generic `postgrestRequest` tool (the `crud` server exposes no dedicated `create_process` verb — use `{method, path, body}` against the registered RACI tables). All emissions are idempotent (GET-by-natural-key → POST on miss):

1. **`processes`** — for each Processes-catalog row: `GET /processes?module_id=eq.<id>&process_key=eq.<key>` → `POST /processes {module_id, process_key, name, description, ordering}` on miss (existing row whose `name`/`description`/`ordering` drifted → `PATCH`). Capture the `id`.
2. **`raci_assignments`** — for each `raci_assignments[]` row, resolve `role_slug` → role_id and `process_key` → process_id, then `GET /raci_assignments?process_id=eq.&role_id=eq.&raci=eq.` → `POST /raci_assignments {process_id, role_id, raci, consult_mode, origin:"system"}` on miss. **Pre-verify at most one `accountable` per process** before POST (clean error; the platform also enforces a partial unique index `idx_raci_one_accountable`).
3. **`process_gates`** — for each `process_gates[]` row: `GET /process_gates?process_id=eq.&entity=eq.&gate_kind=eq.&to_state=eq.` → `POST /process_gates {process_id, entity, gate_kind, to_state, state_column, emits_events}` on miss. Setting `emits_events = true` is what drives the platform's emit trigger (→ `raci_events` → `raci_notify` queue) for C-notify / I.
4. **Enforcement rules** — author each `enforcement_rules[]` entry as a `validation_rule` (A-gate, C-block) via `update_entity`, or a `select_rule` (ownership / row-scope) via the Stage 4f mechanism — the same path the modeler already uses for §8.2 rules. The A-gate `{"is_raci_actor": [...]}` is the living realization of an approval gate (what `documentation` mode would otherwise hand-author as a `validation_rule`).
5. **Per-module flag** — `update_module` (or `PATCH /modules`) to set `modules.settings.raci_mode = "living"`, so future installs read it (the adaptive-default signal).

Plan lines: `🧭 RACI mode: living`, `⚖ Processes: <N>`, `🔗 RACI assignments: <N> (A/R/C/I breakdown)`, `🚪 Process gates: <N> (<M> emit)`, `🛡 Enforcement rules: <N>`, `🤖 Agent actors: <list>`.

In `documentation` mode, none of the above runs — point 2's grant compilation is the whole realization.

**4l. Functional-ownership default grants.** **Skipped entirely under the Stage 2.5 `basic` projection.** Walk the parsed §9.2 `functional_ownership` index. For each row `{responsibility, business_function, default_role, default_tier}`:

1. Resolve the named `default_role` to a live tenant role. For the baseline three (`viewer`, `manager`, `admin`), use the installing unit's default roles (`<slug>_viewer` / `<slug>_manager` / `<slug>_admin`, with `-`→`_` applied to `<slug>` per the role-slug normalization rule in 4a, so a hyphenated module slug still resolves to the underscore-only role that was actually created). For named functions whose role isn't a baseline, the deployer attempts to find a tenant role whose `role_name` matches the business function (case-insensitive); on no match, surface a 🟡 informational row in Stage 5 with the recommendation that the user create the role manually before re-running.
2. Resolve the named `default_tier` (`:read` / `:manage` / `:admin`) to the installing unit's permission code (`<slug>:read` etc.).
3. Idempotent grant: `read_role_permission --single` → `create_role_permission` on exit 1.

Plan line: `🏢 Functional ownership: owner = <function>.<role>, contributor = <function>.<role>`. Per-row grants summary in Stage 5.

**4m. Boundary-crossing handoff wiring.** **Skipped entirely under the Stage 2.5 `basic` projection** (handoffs are part of the lifecycle-gating surface basic access drops). For each parsed §6.2 outbound and §6.3 inbound handoff row whose `event_category` is `lifecycle` or `state_change`:

1. Verify the source entity's §7 lifecycle table contains the `to_state` named in the row's `transition` column. Parse-time has already enforced this; this is the deploy-boundary re-check.
2. Compute `source_module`: follow the **entity-owning-module rule** — the source_module is the source entity's CURRENT owning module slug in the live catalog, not the installing unit. When the source entity is an `embedded_master` whose catalog owner is absent, the source_module IS the installing unit (the entity's current owning module IS the installing unit). When catalog owner is present, the source_module is the catalog module.
3. If the platform exposes a transition trigger registry (`transition_event_triggers` or equivalent), call the appropriate `create_*` CLI to wire the trigger: `(source_module, source_entity, from_state, to_state, event_name, event_category)` → target module's handler. Today the platform may not expose this; in that case, emit a 🟡 informational row in Stage 5: *"Handoff `<source>.<entity>.<event>` → `<target>.<module>` not wired (no trigger registry support); the analyst's spec documents the intent."*
4. **Entity-event handoffs** (`event_category = entity_event`) don't have a state to bind; wire as a raw insert/update/delete listener (when supported) or surface as 🟡.

Same reconciliation semantics as 4n: when a handoff was emitted under a non-catalog source_module and the catalog owner later installs, the handoff re-attribution is part of 4n's sweep (the source_module column is updated to the catalog module).

Plan line: `📡 Handoff: <source_module>.<source_entity>.<event> _(<event_category>)_ → <target_module>`. Per-row status in Stage 5.

**4n. Permission reconciliation on owner-module change.** Fires whenever Branch-B promotion (4c-promote) moves an entity to a new owning module AND Stage 2i queued the entity for reconciliation. Per the entity-owning-module rule, the entity's gates / overrides must now bear the new owner's prefix.

Procedure (per affected entity):

1. **Identify accumulated non-catalog prefixes.** Read every permission in the live catalog whose `permission_name` matches the pattern `<prefix>:<verb>` where the verb appears on this entity's §3 / §9 grant lists. Filter to rows whose `<prefix>` is NOT the new catalog owner's slug. Multiple prior non-catalog prefixes are possible — e.g. after `[hiring-starter, ats-recruitment-pipeline]` both ran with `ats-candidate-crm` absent, `candidates` may have gates under BOTH `hiring-starter:` and `ats-recruitment-pipeline:`. Sweep ALL of them.

   ```bash
   # For each verb in the entity's grant list:
   semantius call crud read_permission '{"filters": "permission_name=like.*:%verb%"}'
   ```

2. **Mint catalog-prefixed sibling permissions.** For each `<old_prefix>:<verb>` resolve `<new_prefix>:<verb>`. `read_permission --single by permission_name=eq.<new_prefix>:<verb>` → `create_permission` on exit 1, with `module_id = <new owner's module id>` and `description` copied from the source permission row.

3. **Sibling role_permissions.** For each `role_permissions` row whose `permission_id` is one of the old-prefixed permissions: `read_role_permission --single by role_id=eq.<role>&permission_id=eq.<new_perm_id>` → `create_role_permission` on exit 1. **No deletion** (per the no-auto-deletion symmetric rule); the old-prefixed rows remain as quiet orphans.

4. **Sibling permission_hierarchy.** For each `permission_hierarchy` row referencing an old-prefixed permission (in either `including_permission_id` or `included_permission_id`): re-emit the equivalent edge against the new-prefixed permission (idempotent: `read_permission_hierarchy --single` first). Old rows remain (no-delete).

5. **N-to-1 sweep semantics.** Every grant on every non-catalog prefix gets ONE sibling grant on the catalog prefix. There is no "pairwise" reconciliation across non-catalog prefixes; the catalog prefix is the single target.

6. **Stage 5 summary.** Render a `🔁 Permission reconciliation` block listing every entity reconciled with per-entity (old prefixes → new prefix) and grant-row count.

**4n symmetry across install orderings.** Whether the catalog owner installs first (no work; entity created under catalog owner from the start), mid-sequence (reconciles whatever non-catalog prefixes have accumulated), or last (reconciles every non-catalog prefix), the rule is the same: when an entity's owning module changes via promotion, sweep and sibling-grant.

<!-- DUPLICATE of canonical copy in SKILL.md (Cross-cutting safety invariants). Edit both. -->

**No auto-deletion of catalog records (load-bearing safety rule).** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. This is symmetric across every catalog-record kind the deployer can write. Even `model_master` rows the deployer wrote in a previous run are off-limits for deletion in subsequent runs. The only legal mutation on them is FK adjustment (`including_permission_id` / `included_permission_id`) during master operations.

Specifically:
- **Master-merge** (4c-merge-master): leaves source masters and their unused permissions, default roles, `role_permissions`, and intra-master hierarchy rows in place as quiet orphans. The deployer does not actively detect or report these as orphans either.
- **Master-rename** (4b-rename): updates slugs and names; no deletions, no orphans (rename is in-place updates).
- **Any reduction in the model file** (entity removed, permission removed, role removed): treated as a no-op against the live catalog. The model file shrinking is not a signal to delete; it might be a typo, a refactor in progress, or the author thinking the entity is now obsolete but other consumers still depend on it.

The deployer does not maintain an orphan registry, does not detect orphans in re-runs, and does not surface orphan candidates in the verification report. The rule is a safety boundary against accidentally destroying admin work, not a feature for catalog hygiene.

---

---

## Gate B: steward seed non-empty (fires here, in Stage 4, immediately after 4j)

**Gate B: steward seed non-empty.** Fires in Stage 4 immediately after 4j seeded `<master>_manager`. If member count is 0 (e.g., the original module's manager role was empty), don't fail outright but emit a 🟡 in the plan and require explicit user confirmation:

> *"`<master>_manager` has zero members. `<entity>` will be effectively read-only for everyone until you assign a steward. Proceed?"*

User can choose to proceed anyway, or to abort and assign someone to `<original>_manager` first.

