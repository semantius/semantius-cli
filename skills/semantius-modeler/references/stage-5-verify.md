# Stage 5: Verify (modeler reference)

_Read this when the workflow reaches Stage 5. The stage map is in SKILL.md._

## Stage 5: Verify

After all creates are done, emit a **structured verification report** with explicit counts and FK consistency checks, not a single ✓. The report groups facts by category so any drift between intended and actual deploy is visible at a glance.

**Narration (per the Narration-restraint rules in SKILL.md (Writing conventions)).** The per-area checks below run **silently**: no *"verifying X..."* trail, no narrated re-run when a check has to be re-issued (fix any tooling hiccup quietly), no machinery named in chat. Only the final report is surfaced, and it reads in plain language, counts and **natural keys** (module slugs, entity Plural Labels, `permission_name`s), never internal vocabulary or bare numeric ids. The report is a result the user cares about (what is now live); the work that produces it is not.

### Per-area checks

1. **Module scaffold integrity (every module touched).** **This area is mechanized by [`scaffold-lib.ts`](./scaffold-lib.ts) `verifyScaffold(cfg)`** — the deploy script calls it as its last step *inside* `runDeploy`, so it throws and halts on any drift instead of relying on the agent to perform the checks by hand (this is the Stage 5 step that got skipped — "I only did a manual spot-check" — in past deploys, shipping broken scaffolds under a success message). Fold its returned findings into the report below. The checks it runs, for reference: load the module by `module_slug=eq.<slug>`, then for every FK column on the module row, **dereference the FK and assert the natural key matches the expected value**. Reading the FK column alone is not enough; a non-null FK can still point at the wrong row.
   - `module.view_permission` (text) equals `<slug>:read`. (No deref needed; the column itself stores the natural key.)
   - `module.manage_permission_id` dereferences to a permission whose `permission_name = <slug>:manage`. (Issue `read_permission --single` by `id=eq.<module.manage_permission_id>` and assert the returned `permission_name`.)
   - `module.admin_permission_id` is null OR dereferences to `<slug>:admin`.
   - **Every permission row declared by this model has `module_id = <module.id>`.** For each `<slug>:*` row from the §8.1 Permissions catalog, `read_permission --single` by `permission_name` and assert `.module_id == <module.id>`. A NULL or mismatched `module_id` is a 🛑 — the permission resolves by name (so hierarchy and role-permission joins still work, masking the defect from a casual smoke test), but module-scoped queries (`?module_id=eq.<id>`) silently miss it, and per-module RBAC audits report drift. Stage 4's scaffold step 2 backfills this column on **every** deploy (both on create and on the exit-0 converge path), so a Stage 5 hit means that backfill did not land — re-issue the `update_permission` to set the column and halt if it still will not take, rather than reporting the deploy as clean.
   - `module.default_viewer_role_id` dereferences to the role whose `slug` is the viewer row in the spec's §9.1 baseline-roles table (read verbatim, not reconstructed as `<slug>_viewer` from the module slug), with `module_id == <module.id>` (a role carrying the right slug but a NULL or mismatched `module_id` is an orphan — invisible in the module's governance panel; the role-side analog of the permission `module_id` check above), `origin ∈ {"model", "model_master"}` matching the module's type (a role left at the default `origin = "user"` was created without the provenance stamp — a 🛑), and a `role_permissions` row linking it to `<slug>:read` (verify via `read_role_permission` filtered on the resolved `role_id` + `permission_id`).
   - Same for manager and admin roles.
   - If any FK is null where the model expected a value, or if a non-null FK dereferences to the wrong natural key, surface as 🛑. Quote the row in the report by natural key — never as a bare `id=N` — so the user can recognize what failed without cross-referencing.
   - **Provenance round-trip (catalog lineage, every module touched).** The FK checks above confirm the *scaffold* landed; this confirms the *lineage stamp* landed. Read the module row and compare its provenance against the spec front-matter (the same keys Stage 4a stamps):
     - `module.catalog_module_code` is **non-empty** and equals the spec source (the catalog blueprint code, else `system_slug`).
     - `module.domain_code` == front-matter `domain_code` (top-level column).
     - `module.icon_name` == front-matter `icon_name` (top-level column).
     - `module.settings.module_kind` == front-matter `module_kind`.
     - `module.settings.naming_mode` == front-matter `naming_mode`.
     - `module.settings.catalog_snapshot` == front-matter `reconciled_against_catalog_snapshot` (note the key rename: front-matter `reconciled_against_catalog_snapshot` lands in `settings.catalog_snapshot`).
     - `module.access_scope` == the Stage 2.5 resolved scope (top-level column).
     - `module.settings.promotion_decisions` is present and matches **when** the front-matter carried it (not required otherwise).
     - An empty/missing `catalog_module_code`, any missing top-level provenance column (`domain_code` / `access_scope` / `icon_name`), or any missing `settings.*` key the front-matter declared, is a 🛑 — the module deployed but its lineage did not, which silently breaks the analyst's re-reconcile, behavior discovery, and the `use-*` discovery skills (all of which read these values to group the catalog and detect drift). Stage 4a stamps every key on **both** the create and the update-reconcile path, so a Stage 5 hit means the stamp did not land — re-issue `create_module` / `update_module` with the full provenance payload (4a checklist) and halt if it still will not take, rather than reporting the deploy as clean.

2. **Master promotion (per promoted entity).**
   - Entity's `module_id` matches the master module's id.
   - Master module's `module_type = "master"`.
   - Count of live records in the entity matches the pre-move count.
   - Every `reference_table = "<entity>"` FK across the catalog still resolves (no orphans).
   - `<master>_manager` role member count >= seed count.

3. **Cross-module hierarchy (per inclusion created).**
   - Row exists with the expected `(parent, child)` pair.
   - Cross-module bridge rows have `origin = "model_master"` (covers both intra-master chains and consumer-to-master bridges).
   - No rows were created with `origin = "user"` overwriting prior admin intent (paranoia check; should be impossible per Stage 4i idempotency).

4. **Merged JSON arrays (master entities only).**
   - Every entry has a non-null `source_module` (legacy entries treated as `"user"`).
   - **No `code` duplicates** within `validation_rules` on an entity, regardless of `source_module`. The natural key is `code` alone; `source_module` is reconciliation metadata, not part of the uniqueness key.
   - **No `name` duplicates** within `computed_fields` on an entity, same rule.
   - Pre-merge entries from non-current sources are still present (preserved across re-runs per 4e-merge rule 4).

5. **Per-entity field counts and labels:**
   - `read_entity` on each custom entity, confirm `label_column` is set.
   - **Owning `module_id`.** For every entity this deploy owns (`create-new` / `rename-incoming-from` → this module; `promote-to-master` → the master module), assert live `entities.module_id` equals the expected module id. A NULL or mismatched value is a 🛑 — the platform is documented to reject a null `module_id` on create, so a live NULL means the create either omitted it or it was nulled later; the entity then belongs to no module and is invisible to module-scoped queries. Stage 4c sets this on create and converges it on the same-module path, so a Stage 5 hit means that did not land — re-issue the `update_entity` and halt if it still will not take. (Reused/built-in entities are out of scope: they keep their source module's id.)
   - `read_field` per entity, confirm field count matches the model (minus auto-generated).
   - Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`).
   - **`unique_value` round-trips.** For each field whose §3 Reference / Notes carry the `unique` marker, confirm live `unique_value` is `true`; for every field without it, confirm `false`. A mismatch is a 🛑 — re-issue `update_field` with the model value (adding `unique_value: true` to a populated column fails if duplicates exist; surface that and route to dedup rather than looping). This is the deploy-side guard the analyst/optimizer `unique` round-trip depends on; a silent drop of a declared natural-key uniqueness is exactly the defect it catches.
   - **Lifecycle state field name (`workflow_state`).** For every entity that has a lifecycle (carries a `workflow-gate (lifecycle)` permission or a `process_gates` row), confirm the live entity has a field named exactly `workflow_state`. A lifecycle state stored under any other field name is a 🛑 — the Stage 1 parse gate should have caught it pre-write, so a Stage 5 hit means the gate was bypassed.
   - **`label_parent` round-trips.** For every owned entity whose spec carries a `**Label parent:**` line, confirm live `entities.label_parent` equals the named FK field; for every owned entity without the line, confirm live `label_parent` is null/absent. A mismatch is a 🛑 — the composed `_label` would fold on the wrong spine, or not at all. While here, confirm the deploy did **not** materialize `_label` / `<fk>_label` as real `fields` rows (a `read_field` hit on a `_`-prefixed or `*_id_label` name means the reserved-name guard was bypassed).
   - **Entity provenance round-trip (every owned entity).** Beyond `module_id` and `label_parent` above, assert the lineage/class stamp landed (the entity analog of the module provenance check in §1): `catalog_entity_code` is **non-empty** (the catalog code, default `table_name`); `entity_type` matches the spec's `**Entity type:**` and is one of the 6 CHECK values (`unclassified` only when the spec omitted it, never `''`); `catalog_owner_module` matches the spec's `**Catalog owner:**` line (or `''` when the line is absent / the entity was promoted into its catalog home). An empty `catalog_entity_code` or an out-of-set `entity_type` is a 🛑 — the entity deployed but its catalog identity did not, breaking the analyst's re-reconcile and the `use-*` discovery skills exactly as a missing module stamp does. Re-issue `create_entity` (or `update_entity` for the value-only columns; `catalog_entity_code` is write-once, settable only while still empty) and halt if it will not take. Built-in / `reuse-from` entities are out of scope — they keep their own stamp.

5a. **Text-fidelity round-trip (every entity and every field this deploy touched).** For each entity, compare live `description`, `singular_label`, `plural_label` against the parsed model values **byte-for-byte**. For each field declared in the model, compare live `description` and `title` against the model byte-for-byte (for the `label_column` field, "the model" is its §3 **Label**, which the platform-derived title from `singular_label` almost never matches — see the Stage 1 "Title correction" note). Any mismatch is a Stage 5 **blocker**, not an advisory: surface the entity / field, quote both strings with their byte counts, **re-issue the offending `create_*` / `update_*` with the model-sourced text, then re-read and re-compare. Do not report the deploy successful while any text-fidelity mismatch remains** — a "recommend and move on" here is exactly how the label-title and field-description drift reached production. Catches every failure mode the "Data fidelity" section enumerates: truncation (live byte-count shorter than model), normalization (live missing backticks / apostrophes / Unicode the model carried), and empty-string-clobber on `update_field` (live empty where model is non-empty). Equivalent round-trip applies to permission `description` against the §8.1 Permissions catalog `description` cell. The check is cheap (every relevant column is already in the `read_entity` / `read_field` / `read_permission` response from earlier verification steps) and is the single load-bearing assertion that catches data-mutation regressions before the user does.

6. **Read-side rules round-trip**: for every entity whose model carried a `Select rule` block, `read_entity` and confirm the live `select_rule` equals the model's parsed object. For every field whose model carried an `Input type rules` entry, `read_field` and confirm the live `input_type_rule` equals the entry's `jsonlogic`. A round-trip mismatch is a Stage 5 defect — quote the diff to the user and offer a retry of the offending `update_*` call. The platform's constraint checks usually surface the failure at Stage 4f instead, so a Stage 5 catch here is rare; when it does fire, it's almost always a transient/concurrency issue worth a single retry before escalating.

7. **Live RACI engine (living mode only).** When Stage 4k ran in `living` mode, round-trip every artifact it materialized — this is the verify counterpart to the five-batch 4k living-mode write, and without it a mid-sequence 4k failure is invisible to Stage 5:
   - **`modules.settings.raci_mode == "living"`** on the module record.
   - For each Processes-catalog row: a `processes` row exists with the expected `process_key` under this module (`GET /processes?module_id=eq.<id>&process_key=eq.<key>`), with `name` / `description` / `ordering` matching the spec.
   - For each `raci_assignments[]` row: a live assignment exists for the resolved `(process_id, role_id, raci)` with `consult_mode` matching. **Assert at most one `accountable` per process** (the platform's partial unique index `idx_raci_one_accountable` also enforces this; a Stage 5 catch means the Stage 4k pre-check was skipped).
   - For each `process_gates[]` row: a live gate exists for `(process_id, entity, gate_kind, to_state)` with `emits_events` matching — a C-notify / I gate that lost `emits_events = true` silently breaks the `raci_events` → `raci_notify` queue.
   - Each `enforcement_rules[]` entry landed as the expected `validation_rule` (A-gate `is_raci_actor`, C-block `has_consultation`) or `select_rule` on its entity — round-trip the JsonLogic as in checks 4 and 6.
   - Any missing or drifted artifact is a 🛑, quoted by natural key (`process_key`, role `slug`): a half-materialized matrix enforces partial governance (e.g. an A-gate present but its `accountable` assignment missing locks the transition for everyone). In `documentation` mode this whole check is skipped — the grant compilation is already covered by the persona-grant round-trip.

### Structured Stage 5 report

```
=== Verification report ===

Modules:
  itsm                       ✓ module_type=domain   lineage✓   permissions=2/2  default_roles=2/2
  vendors_master  (NEW)      ✓ module_type=master   lineage✓   permissions=2/2  default_roles=2/2

Roles (deployer-managed, origin ∈ {model, model_master}):
  itsm_viewer                ✓ origin=model         12 members   carries itsm:read
  itsm_manager               ✓ origin=model         3 members    carries itsm:manage
  vendors_master_viewer      ✓ origin=model_master  0 members    carries vendors_master:read
  vendors_master_manager     ✓ origin=model_master  3 members    carries vendors_master:manage  [seeded from itsm_manager]

Entities:
  vendors                    ✓ moved itsm → vendors_master   247 records intact   12 FKs repointed
  incidents                  ✓ 8 fields added                 no drift

Permission hierarchy:
  itsm:admin → itsm:manage           ✓ origin=model
  itsm:manage → itsm:read            ✓ origin=model
  itsm:read → vendors_master:read    ✓ origin=model_master    (NEW)

Merged JSON arrays:
  vendors.computed_fields:    4 entries  (3 from itsm, 1 from itam, 0 conflicts)
  vendors.validation_rules:   7 entries  (5 from itsm, 2 from itam, 1 conflict resolved)
  conflicts:
    - validation_rules code 'email_required' had two source models;
      kept itsm version, renamed itam version to 'email_required_itam'

Counters:
  modules created:    1
  modules updated:    1
  entities moved:     1
  entities updated:   1
  fields added:       8
  permissions added:  2  (origin=model)
  roles added:        2  (1 origin=model, 1 origin=model_master)
  hierarchy added:    3  (2 origin=model, 1 origin=model_master)
  warnings (🟡):      0
  blockers (🛑):      0

✓ Verification passed.
```

Counters at the bottom break down by `origin` so any drift between what the deployer was supposed to create and what actually landed is visible in one place. No orphan section; the deployer does not detect or report orphans (per Stage 4 "No auto-deletion").

**Additional report sections** (rendered immediately after Counters, before the final ✓ line):

```
Functional ownership grants (4l):  applied N rows
  owner = Recruiting.admin (granted hiring-starter:admin)
  contributor = Legal.manage (granted hiring-starter:manage)

Personas provisioned (4k):  M personas, K total grants
  recruiting_recruiter        ✓ created   carries [hiring-starter:hire_candidate, hiring-starter:manage]
  hiring_manager              ✓ existed   carries [hiring-starter:approve_offer, hiring-starter:manage]
  recruiting_sourcer          ✓ created   carries [hiring-starter:publish_posting, hiring-starter:manage]
  ...

Re-prefixed permissions (Stage 4a-scaffold):  N permissions
  hiring-starter:hire_candidate        (catalog ats-recruitment-pipeline not installed)
  hiring-starter:approve_offer         (catalog ats-offers not installed)
  hiring-starter:view_all_candidates   (catalog ats-candidate-crm not installed)
  ...

Master-install reconciliation (Stage 4n):  P entities reconciled, Q permissions renamed, R grants re-pointed
  candidates: hiring-starter:view_all_candidates → ats-candidate-crm:view_all_candidates (3 grants → 3 siblings)
  candidates: hiring-starter:hire_candidate → ats-candidate-crm:hire_candidate (2 grants → 2 siblings)
  ...

Boundary-crossing handoffs (Stage 4m):  S wired, T unwired (no trigger registry)
  ✓ hiring-starter.candidates.hired (lifecycle) → hcm-lifecycle-workflows
  🟡 hiring-starter.job_applications.rejected (state_change) → ats-talent-pools (no trigger registry)

Skipped FKs (presence-conditional):  U skips
  💤 job_offers.background_check_id → background_checks (target not installed)
  💤 job_offers.offer_version_id → offer_versions (target not installed)
  💤 job_offers.onboarding_journey_id → onboarding_journeys (target not installed)

Skipped on ⚠ flag:  V skips
  ⚠️ <entity>.<state> — <verbatim reason>

Live RACI engine (Stage 4k living mode):  W processes, X assignments, Y gates, Z enforcement rules
  raci_mode = living          ✓
  processes:                  offer_approval ✓   onboarding ✓
  raci_assignments:           8  (2 A / 3 R / 2 C / 1 I)   ✓ one accountable per process
  process_gates:              3  (2 emit_events)            ✓
  enforcement rules:          offer_approval A-gate ✓   onboarding C-block ✓

✓ Verification passed.
```

Each block is rendered only when it has non-zero content. Personas, functional ownership, and re-prefixed permissions are the most common new lines (most deploys carry §9). Master-install reconciliation and boundary-crossing handoff wiring fire only when their stages execute. Skipped FKs and ⚠ flags are situational. The Live RACI engine block renders only for `living`-mode deploys (in `documentation` mode the persona-grant lines above are the whole RACI realization).

**Compact summary line** (still emitted, for backwards-compatibility with existing logs): *"✅ Done. Created 1 module, 3 permissions, 2 hierarchy rows, 5 entities (2 admin-tier, 3 operational), 47 fields. Reused built-ins: users. Additive fields on built-ins: 2. Applied 2 `select_rule`(s) and 7 `input_type_rule`(s)."*

When the model is on the two-permission fallback (no admin-tier entities), the summary reads "2 permissions, 1 hierarchy row, N entities (all operational)". The admin-tier breakdown is omitted when there are no admin-tier entities. The read-side-rule counts are omitted when both totals are zero (the common case for models that don't use the read-side surfaces).

**Access-control callout (mandatory).** The verification summary names the resolved Stage 2.5 scope on its own line: *"🔐 Access control: Basic (read + edit). Deployed `<slug>:read` + `<slug>:manage`, viewer + manager roles."* or *"🔐 Access control: Full RBAC."* When `basic` was a **projection** of a full-shaped spec, also state what was suppressed and (on a re-deploy that flipped an existing full module to basic) which already-live higher-governance objects are now quiet orphans: *"Skipped N permissions, M roles, K lifecycle gates, P persona grants. L pre-existing gate(s)/role(s) left in place (not deleted; re-deploy under full access to re-activate)."* This is the read-side analog of the access-control choice surfacing in the plan: the user sees, after the fact, exactly which governance the basic choice excluded.

**Read-visibility callout (mandatory when any `select_rule` was created or modified).** Any Stage 4f write that created, changed, or removed an entity's `select_rule` deserves its own one-line callout in the verification summary, separate from the bulk counts: *"⚠️ Applied `select_rule` on `<table_name>`. Callers will now see only rows where `<short-description-of-rule>`. Confirm rollout is the intent."* This mirrors how `edit_permission` tier flips get their own callout (a real RBAC change); read-visibility changes have the same "user noticing 'why can't I see X anymore'" failure mode and benefit from being named in the summary the user reads.

## Stage 5b: Stamp the deploy version into the spec

**Runs only on a clean, fully-completed deploy** (Stage 4 finished without halting; the Stage 5 report shows 0 blockers). Skip entirely on a halted / partial deploy.

The platform maintains two module columns the modeler never writes to the module directly: **`modules.version`** (a monotonic integer the platform bumps on any schema change to the module's owned entities / fields / enum values / permissions) and **`modules.version_date`** (the timestamp of that bump). Together they are the O(1) drift signal the analyst reads on its next run to answer *"has this module changed since it was last deployed?"* — instead of deep-inspecting every entity.

Because every Stage 4 write has now settled and Stage 5 is read-only, the value is stable. Record it back into the spec's front-matter so the analyst can compare against it later:

1. **Read the deployed module's version** by natural key:
   ```bash
   semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'
   # capture .version (integer) and .version_date (ISO 8601 timestamp)
   ```
2. **Read each dependency module's version.** For every DISTINCT other module this spec depends on — each source module named in a `reuse-from <module>.<entity>` or `promote-to-master <master_module>.<entity>` annotation, excluding `semantius_builtin.*` — read its `.version` the same way. These feed `deployed_related_versions`, so drift in a REUSED entity (one owned by another module) is detectable too, not just drift in this module's own entities.
3. **Upsert these front-matter keys into the spec file**, leaving every other byte unchanged:
   ```yaml
   deployed_version: <this module's live .version, integer>
   deployed_version_date: "<this module's live .version_date, ISO 8601>"
   deployed_related_versions:            # omit the whole key when the spec reuses / promotes nothing
     <other_module_slug>: <its live .version>
   ```

**This is the ONLY modification the modeler ever makes to the spec file, and only on a clean deploy.** Do an in-place front-matter upsert of exactly these keys (insert if absent, overwrite if present) and touch nothing else — no section reflow, no re-emission, no reordering. The spec is the user's artifact; this single write-back is the deploy-version stamp, nothing more.

**Graceful degradation.** If `read_module` returns no `version` / `version_date` (the platform predates these columns), skip the stamp silently — do not fail the deploy and do not invent a value. The analyst's gate treats an absent `deployed_version` as *"unknown, inspect fully"*, so an un-stamped spec stays correct, just not optimized.

**Narration.** None. This is internal bookkeeping; the front-matter change (visible in the user's `git diff`) is the receipt. Do **not** add a line to the closing block — the Closing Contract is exactly three things and the version stamp is not one of them.

### Gates

Two integrity gates fire outside Stage 5 and are defined where they fire (not here):

- **Gate A** (pre-write planned-state integrity check): `references/stage-3-plan.md`; fires in Stage 3 before any Stage 4 writes.
- **Gate B** (steward seed non-empty): `references/stage-4-execute.md`; fires in Stage 4 immediately after 4j.

---

## Closing Contract

The Closing Contract (clean-deploy call-to-action, sticky-footer behavior, and the halt carve-out) is defined in `SKILL.md` (the spine) so it stays resident across follow-up turns even after this file is compacted.

