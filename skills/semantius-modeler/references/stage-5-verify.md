# Stage 5: Verify (modeler reference)

_Read this when the workflow reaches Stage 5. The stage map is in SKILL.md._

## Stage 5: Verify

After all creates are done, emit the **structured verification report** ("Structured Stage 5 report" below, a fixed shape) with explicit counts and the result of every check, not a single ✓. The report groups facts by category so any drift between intended and actual deploy is visible at a glance.

**Narration (per the Narration-restraint rules in SKILL.md (Writing conventions)).** The per-area checks below run **silently**: no *"verifying X..."* trail, no narrated re-run when a check has to be re-issued (fix any tooling hiccup quietly), no machinery named in chat. Only the final report is surfaced, and it reads in plain language, counts and **display names** (module names, table Plural Labels, role names), never internal vocabulary, slugs, column names or bare numeric ids. The checks themselves still compare by natural key. The report is a result the user cares about (what is now live); the work that produces it is not.

### Per-area checks

1. **Module scaffold integrity (every module touched).** **This area is mechanized by [`scaffold-lib.ts`](./scaffold-lib.ts) `verifyScaffold(cfg)`** — the deploy script calls it as its last step *inside* `runDeploy`, so it throws and halts on any drift instead of relying on the agent to perform the checks by hand (this is the Stage 5 step that got skipped — "I only did a manual spot-check" — in past deploys, shipping broken scaffolds under a success message). Fold its returned findings into the report below. The checks it runs, for reference: load the module by `module_slug=eq.<slug>`, then assert every reference column on the module row against its expected natural key. The three permission references store the `permission_name` itself, so compare them directly; the three role references are numeric FKs, so **dereference each and assert the natural key matches the expected value** (reading a numeric FK alone is not enough; a non-null FK can still point at the wrong row).
   - Under `access_scope: custom` the scaffold checks in this area are skipped (the modeler wrote no permission, role or module reference); only the provenance round-trip below runs.
   - `module.view_permission` equals `<slug>:read`.
   - `module.manage_permission` equals `<slug>:manage`.
   - `module.admin_permission` is null (basic) OR equals `<slug>:admin`.
   - **Every permission row declared by this model has `module_id = <module.id>`.** For each `<slug>:*` row from the §8.1 Permissions catalog, `read_permission --single` by `permission_name` and assert `.module_id == <module.id>`. A NULL or mismatched `module_id` is a 🛑 — the permission resolves by name (so hierarchy and role-permission joins still work, masking the defect from a casual smoke test), but module-scoped queries (`?module_id=eq.<id>`) silently miss it, and per-module RBAC audits report drift. Stage 4's scaffold step 2 backfills this column on **every** deploy (both on create and on the exit-0 converge path), so a Stage 5 hit means that backfill did not land — re-issue the `update_permission` to set the column and halt if it still will not take, rather than reporting the deploy as clean.
   - `module.default_viewer_role_id` dereferences to the role whose `slug` is the viewer row in the spec's §9.1 baseline-roles table (read verbatim, not reconstructed as `<slug>_viewer` from the module slug), with `module_id == <module.id>` (a role carrying the right slug but a NULL or mismatched `module_id` is an orphan — invisible in the module's governance panel; the role-side analog of the permission `module_id` check above), `origin ∈ {"model", "model_master"}` matching the module's type (a role left at the default `origin = "user"` was created without the provenance stamp — a 🛑), and a `role_permissions` row linking it to `<slug>:read` (verify via `read_role_permission` filtered on the resolved `role_id` + `permission_name`).
   - Same for manager and admin roles.
   - If any reference is null where the model expected a value, or if a non-null reference holds (or dereferences to) the wrong natural key, surface as 🛑. Name what failed in the report's Checks block by display name — never as a bare `id=N` — so the user can recognize it without cross-referencing.
   - **Provenance round-trip (catalog lineage, every module touched).** The FK checks above confirm the *scaffold* landed; this confirms the *lineage stamp* landed. Read the module row and compare its provenance against the spec front-matter (the same keys Stage 4a stamps):
     - `module.catalog_module_code` is **non-empty** and equals the spec source (the catalog blueprint code, else `system_slug`).
     - `module.domain_code` == front-matter `domain_code` (top-level column).
     - `module.icon_name` == front-matter `icon_name` (top-level column), or `box` when the deploy reported the front-matter name as not a Lucide icon.
     - `module.settings.module_kind` == front-matter `module_kind` **when** the front-matter carried a non-empty, non-null value (not required otherwise — the key is optional and informational; a spec without it must not produce a `settings.module_kind` stamp, and its absence live is not a finding).
     - `module.settings.naming_mode` == front-matter `naming_mode`.
     - `module.settings.catalog_snapshot` == front-matter `reconciled_against_catalog_snapshot` (note the key rename: front-matter `reconciled_against_catalog_snapshot` lands in `settings.catalog_snapshot`).
     - `module.access_scope` == the spec's `access_scope` (top-level column). Skipped under `custom`, where the modeler never writes it.
     - `module.settings.promotion_decisions` is present and matches **when** the front-matter carried it (not required otherwise).
     - An empty/missing `catalog_module_code`, any missing top-level provenance column (`domain_code` / `access_scope` (not checked under `custom`) / `icon_name`), or any missing `settings.*` key the front-matter declared, is a 🛑 — the module deployed but its lineage did not, which silently breaks the analyst's re-reconcile, behavior discovery, and the `use-*` discovery skills (all of which read these values to group the catalog and detect drift). Stage 4a stamps every key on **both** the create and the update-reconcile path, so a Stage 5 hit means the stamp did not land — re-issue `create_module` / `update_module` with the full provenance payload (4a checklist) and halt if it still will not take, rather than reporting the deploy as clean.

2. **Master promotion (per promoted entity).**
   - Entity's `module_id` matches the master module's id.
   - Master module's `module_type = "master"`.
   - Count of live records in the entity matches the pre-move count.
   - Every `reference_table = "<entity>"` FK across the catalog still resolves (no orphans).
   - `<master>_manager` role member count >= seed count.

3. **Cross-module hierarchy (per inclusion created).**
   - Row exists with the expected `(including_permission_name, included_permission_name)` pair.
   - Cross-module bridge rows have `origin = "model_master"` (covers both intra-master chains and consumer-to-master bridges).
   - No rows were created with `origin = "user"` overwriting prior admin intent (paranoia check; should be impossible per Stage 4i idempotency).

4. **Merged JSON arrays (master entities only).**
   - Every entry has a non-null `source_module` (entries without it are treated as `"user"`).
   - **No `name` duplicates** within `validation_rules` on an entity, regardless of `source_module`. The natural key is `name` alone; `source_module` is reconciliation metadata, not part of the uniqueness key. (`code` is not unique: it is the rule's SQLSTATE error code.)
   - **Every model-authored `validation_rules[].code` matches `^99[0-9]{3}$`** (class 99). Platform-tagged entries (`source_module: "platform"`) carry class-90 codes and are exempt.
   - **No `name` duplicates** within `computed_fields` on an entity, same rule.
   - Pre-merge entries from non-current sources are still present (preserved across re-runs per 4e-merge rule 4).

5. **Per-entity field counts and labels:**
   - `read_entity` on each owned entity, confirm live `label_column` equals the spec's `**Label column:**` value; being set is not enough. A different value is a 🛑, not a pass: re-point it with `updateEntity(t, { label_column })`, which makes the spec's existing column the label without renaming the current one, and halt if it will not take. Exceptions: a based entity (`**Based on:**`: its `label_column` is set from its base by the platform, so confirm it equals the base's) and an `entity_type: junction` entity whose spec omitted the `**Label column:**` line (valid: the platform composes its `_label` from the parent legs; a null live `label_column` there is expected, not a finding).
   - **Owning `module_id`.** For every entity this deploy owns (`create-new` / `rename-incoming-from` → this module; `promote-to-master` → the master module), assert live `entities.module_id` equals the expected module id. A NULL or mismatched value is a 🛑 — the platform is documented to reject a null `module_id` on create, so a live NULL means the create either omitted it or it was nulled later; the entity then belongs to no module and is invisible to module-scoped queries. Stage 4c sets this on create and converges it on the same-module path, so a Stage 5 hit means that did not land — re-issue the `update_entity` and halt if it still will not take. (Reused/built-in entities are out of scope: they keep their source module's id.)
   - `read_field` per entity, confirm field count matches the model (minus auto-generated).
   - Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`).
   - **`unique_value` round-trips.** For each field whose §3 Reference / Notes carry the `unique` marker, confirm live `unique_value` is `true`; for every field without it, confirm `false`. A mismatch is a 🛑 — re-issue `update_field` with the model value (adding `unique_value: true` to a populated column fails if duplicates exist; surface that and route to dedup rather than looping). This is the deploy-side guard the analyst/optimizer `unique` round-trip depends on; a silent drop of a declared natural-key uniqueness is exactly the defect it catches.
   - **Lifecycle state field name (`workflow_state`).** For every entity that has a lifecycle (carries a `workflow-gate (lifecycle)` permission or a `process_gates` row), confirm the live entity has a field named exactly `workflow_state`. A lifecycle state stored under any other field name is a 🛑 — the Stage 1 parse gate should have caught it pre-write, so a Stage 5 hit means the gate was bypassed.
   - **`label_parent` round-trips.** For every owned entity whose spec carries a `**Label parent:**` line, confirm live `entities.label_parent` equals the named FK field; for every owned entity without the line, confirm live `label_parent` is null/absent. A mismatch is a 🛑 — the composed `_label` would fold on the wrong spine, or not at all. While here, confirm the deploy did **not** materialize `_label` / `<fk>_label` as real `fields` rows (a `read_field` hit on a `_`-prefixed or `*_id_label` name means the reserved-name guard was bypassed).
   - **Key type round-trips.** For every entity this deploy created whose spec carries `**Key type:**`, confirm live `entities.id_type` equals it (and `id_prefix` equals `**Key prefix:**` for `typeid` / `is_a`, and `id_refentity` equals `**Based on:**` for `is_a` / `has_a`); for every entity it created without the line, confirm live `id_type` is `auto_increment` and `id_refentity` is null. A based entity's fields read back as its own only (`read_field table_name=eq.<entity>`); its base's fields stay on the base. A mismatch is a 🛑 that no re-run can repair (the key type is locked once the table exists): report it plainly and route the user to the analyst, since fixing it means rebuilding the entity. For an existing `typeid` entity whose prefix Stage 4c synced, confirm live `id_prefix` equals the spec's.
   - **Enum round-trip (by value).** For each enum field, live `enum_values` holds the spec's §5 entries: compare values in order, and for a bullet with a label or hints compare only the keys the spec states (`label`, and each stated `color`, `icon`, `description`) key by key, never as JSON (jsonb reorders object keys on read-back). An icon stated as `none`, or reported by the deploy as not a Lucide icon, is compared as no icon. A hint the spec does not state is not checked: it is kept from live (`mergeEnumEntries`). A value mismatch is a 🛑; a label or hint mismatch is re-synced by `update_field` with the `mergeEnumEntries` result (cosmetic, records store values).
   - **Entity provenance round-trip (every owned entity).** Beyond `module_id` and `label_parent` above, assert the lineage/class stamp landed (the entity analog of the module provenance check in §1): `catalog_entity_code` is **non-empty** (the catalog code, default `table_name`); `entity_type` matches the spec's `**Entity type:**` and is one of the 6 CHECK values (`unclassified` only when the spec omitted it, never `''`); `catalog_owner_module` matches the spec's `**Catalog owner:**` line (or `''` when the line is absent / the entity was promoted into its catalog home). An empty `catalog_entity_code` or an out-of-set `entity_type` is a 🛑 — the entity deployed but its catalog identity did not, breaking the analyst's re-reconcile and the `use-*` discovery skills exactly as a missing module stamp does. Re-issue `create_entity` (or `update_entity` for the value-only columns; `catalog_entity_code` is write-once, settable only while still empty) and halt if it will not take. Built-in / `reuse-from` entities are out of scope — they keep their own stamp.
   - **Field provenance round-trip (every field this deploy created).** For each field Stage 4d / 4g / 4h created via `create_field` in this run, plus the `label_column` field of every entity this run created (stamped in the post-create pass, see Stage 1 "Label-column description and provenance"), assert live `fields.catalog_field_code` is **non-empty** and equals the spec's `field_name`. Other platform-generated columns (`id`, `label`, `created_at`, `updated_at`) are out of scope. An empty value is a 🛑: the field deployed without its design-time identity, so a later field rename cannot be joined back to the blueprint. `catalog_field_code` is write-once but settable while still empty, so re-issue `update_field` with the value and halt if it will not take. Fields that existed before this deploy are out of scope (their stamp, or its absence, predates this run; never overwrite a non-empty value).

5a. **Text-fidelity round-trip (every entity and every field this deploy touched).** For each entity, compare live `description`, `singular_label`, `plural_label` against the parsed model values **byte-for-byte**. For each field declared in the model, compare live `description` and `title` against the model byte-for-byte (for the `label_column` field, "the model" is its §3 **Label**, which the platform-derived title from `singular_label` almost never matches — see the Stage 1 "Title correction" note). Any mismatch is a Stage 5 **blocker**, not an advisory: surface the entity / field, quote both strings with their byte counts, **re-issue the offending `create_*` / `update_*` with the model-sourced text, then re-read and re-compare. Do not report the deploy successful while any text-fidelity mismatch remains** — a "recommend and move on" here is exactly how the label-title and field-description drift reached production. Catches every failure mode the "Data fidelity" section enumerates: truncation (live byte-count shorter than model), normalization (live missing backticks / apostrophes / Unicode the model carried), and empty-string-clobber on `update_field` (live empty where model is non-empty). Equivalent round-trip applies to permission `description` against the §8.1 Permissions catalog `description` cell. The check is cheap (every relevant column is already in the `read_entity` / `read_field` / `read_permission` response from earlier verification steps) and is the single load-bearing assertion that catches data-mutation regressions before the user does.

**Comparing JSON columns.** `computed_fields`, `validation_rules`, `select_rule`, and `input_type_rule` are stored as `jsonb`, which does not preserve object key order (a rule sent as `{code, name, message, description, jsonlogic}` reads back with its keys reordered). Compare them structurally (parse both sides, sort object keys recursively, then compare; array order IS significant), never as raw JSON strings. A string compare reports every rule as drifted and makes every re-run re-send them. The same rule applies to the Stage 4 create-or-diff decisions (4c ♻️ sync, 4e, 4f).

6. **Read-side rules round-trip**: for every entity whose model carried a `Select rule` block, `read_entity` and confirm the live `select_rule` equals the model's parsed object. For every field whose model carried an `Input type rules` entry, `read_field` and confirm the live `input_type_rule` equals the entry's `jsonlogic`. A round-trip mismatch is a Stage 5 defect — quote the diff to the user and offer a retry of the offending `update_*` call. The platform's constraint checks usually surface the failure at Stage 4f instead, so a Stage 5 catch here is rare; when it does fire, it's almost always a transient/concurrency issue worth a single retry before escalating.

7. **Live RACI engine (living mode only).** When Stage 4k ran in `living` mode, round-trip every artifact it materialized — this is the verify counterpart to the five-batch 4k living-mode write, and without it a mid-sequence 4k failure is invisible to Stage 5:
   - **`modules.settings.raci_mode == "living"`** on the module record.
   - For each Processes-catalog row: a `processes` row exists with the expected `process_key` under this module (`GET /processes?module_id=eq.<id>&process_key=eq.<key>`), with `name` / `description` / `ordering` matching the spec.
   - For each `raci_assignments[]` row: a live assignment exists for the resolved `(process_id, role_id, raci)` with `consult_mode` matching. **Assert at most one `accountable` per process** (the platform's partial unique index `idx_raci_one_accountable` also enforces this; a Stage 5 catch means the Stage 4k pre-check was skipped).
   - For each `process_gates[]` row: a live gate exists for `(process_id, entity, gate_kind, to_state)` with `emits_events` matching — a C-notify / I gate that lost `emits_events = true` silently breaks the `raci_events` → `raci_notify` queue.
   - Each `enforcement_rules[]` entry landed as the expected `validation_rule` (A-gate `is_raci_actor`, C-block `has_consultation`) or `select_rule` on its entity — round-trip the JsonLogic as in checks 4 and 6.
   - Any missing or drifted artifact is a 🛑, named in the report by process name and role name: a half-materialized matrix enforces partial governance (e.g. an A-gate present but its `accountable` assignment missing locks the transition for everyone). In `documentation` mode this whole check is skipped — the grant compilation is already covered by the persona-grant round-trip.

### Structured Stage 5 report

The report has one fixed shape. Render it exactly as specified here, every run:

- **One fenced code block**, opening with `=== Verification report ===`. Nothing of the report goes outside it; the "Decided for you after your go-ahead" section (fast runs) follows it.
- **The blocks below, in the order listed, under their headings verbatim.** A block is left out only where its row in the tables says so; no block not listed here is ever added.
- **Each line takes one of the forms shown, and nothing else.** No other fact goes on a line (no record-id prefixes, lifecycle states, "a kind of", shared-module hints, rule counts), and no prose paragraph goes anywhere in the report. Anything the forms have no place for stays out.
- **Plain words only.** Modules by display name (`module_name`), tables by Plural Label, fields by their title, roles by `role_name`. Never a module slug, `table_name`, `permission_name`, numeric id, `origin`, `module_type` or any other column name; the Writing Conventions ban list in SKILL.md applies to every line. A permission is named by its level (view, edit, admin) or, for any other permission, by the action its description names (*retire assets*).
- **Lines of at most 80 characters.** A longer line wraps onto an indented continuation line, so the report never scrolls sideways.

```
=== Verification report ===

Modules
  IT Service Management            ✓ updated
  Parties                          ✓ new, shared by several modules

Roles
  IT Service Management Viewer     ✓ 12 people   view
  IT Service Management Manager    ✓ 3 people    edit
  Parties Viewer                   ✓ new, 0 people   view
  Parties Manager                  ✓ new, 3 people   edit
                                     (people copied from IT Service
                                     Management Manager)

Tables (2)
  Vendors                          ✓ moved to Parties, 247 records kept,
                                     12 links updated
  Incidents                        ✓ 8 fields added

Access inclusions
  IT Service Management: admin includes edit       ✓
  IT Service Management: edit includes view        ✓
  IT Service Management view includes Parties view ✓ new

Rules on shared tables
  Vendors: 4 calculated fields, 7 save checks
    two modules had a save check named 'email_required': kept the
    IT Service Management one, renamed the other 'email_required_itam'

Checks
  Module setup                     ✓
  Tables and fields                ✓
  Names and descriptions           ✓
  Choice lists                     ✓

Counts
  modules: 1 created, 1 updated
  tables: 1 updated, 1 moved
  fields added: 8
  permissions added: 2   roles added: 2   access inclusions added: 1
  warnings (🟡): 0   problems (🛑): 0

✓ Verification passed.
🔐 Access level: view, edit and admin.
✅ Done. 1 module created, 1 updated; 2 permissions, 1 access inclusion
   and 8 fields added.
```

| Block | Rendered | Line forms |
|---|---|---|
| Modules | always | `<Module>  ✓ new` / `✓ updated` / `✓ no changes`; a module whose `module_type` is `master` adds `, shared by several modules`. |
| Roles | every module the deploy wrote roles for; left out under `access_scope: custom` | `<role_name>  ✓ <N> people  <level>`; a role created in this run starts its status with `new, `; a shared module's manager role seeded from another role adds the continuation `(people copied from <role_name>)`. |
| Tables (N) | always | `<Plural Label>  ✓` then one of: `new, <N> fields` / `<N> fields added` / `<N> fields added, <M> changed` / `no changes` / `moved to <Module>, <N> records kept, <M> links updated`. |
| Access inclusions | every inclusion this run checked; left out under `access_scope: custom` | `<Module>: <level> includes <level>` inside one module; `<Module> <level> includes <Module> <level>` across modules; status `✓`, plus ` new` when this run created it. A failed check 3 shows `🛑` on the line, with one indented line saying what is wrong. |
| Rules on shared tables | only when a shared module's table carries merged rules | `<Plural Label>: <N> calculated fields, <M> save checks`; each name clash settled adds one indented line saying what was kept and what was renamed. A failed check 4 shows `🛑` on the table's line, with one indented line per problem. |
| Checks | always | The fixed lines `Module setup` (check 1), `Tables and fields` (checks 2 and 5, keys and uniqueness included), `Names and descriptions` (5a), `Choice lists` (the enum round-trip in 5), and `Visibility and field display rules` (6, only when the design has any). Each is `✓` or `🛑`; a `🛑` line is followed by one indented line per problem, naming the table and field by label and saying what is wrong (*Assets: Serial Number should not repeat, but it can*). |
| Counts | always | `modules`, `tables` (created, updated, moved), `fields added`, then `permissions added`, `roles added`, `access inclusions added` on one line, then `warnings (🟡)` and `problems (🛑)`. A count of zero is left off the first three lines; the two on the last line always show. |

After Counts come these blocks, each rendered only when it has at least one line, in this order:

```
Ownership
  Recruiting Admin                 owns this module, given admin access
  Legal Manager                    helps run it, given edit access

Business roles (3)
  Recruiter                        ✓ new   hire candidates, edit
  Hiring Manager                   ✓ existed   approve offers, edit
  Sourcer                          ✓ new   publish postings, edit

Permissions kept here until their home module is installed (3)
  hire candidates
  approve offers
  view all candidates

Permissions moved to their home module (2)
  Candidates: hire candidates → ATS Candidate CRM, 3 role grants kept
  Candidates: view all candidates → ATS Candidate CRM, 2 role grants kept

Handoffs to other modules (1 connected, 1 recorded only)
  ✓ Candidates: hired → HCM Lifecycle Workflows
  🟡 Job Applications: rejected → ATS Talent Pools
     recorded, not connected: the platform cannot start it yet

Links not added, other table not installed (2)
  💤 Job Offers → Background Checks
  💤 Job Offers → Offer Versions

Steps skipped (1)
  ⚠️ Job Offers: approved: <the reason, verbatim>

Icons not deployed (2)
  🟡 Job Applications, Stage: Screening: "filter-funel" is not an icon, shown with none
  🟡 Module icon: "brief-case" is not an icon, shown as box

Business process rules (2)
  Offer Approval                   ✓
  Onboarding                       ✓
  assignments: 8 (2 accountable, 3 responsible, 2 consulted, 1 informed)
  one accountable role per process ✓
  gated steps: 3 (2 send notices)
```

| Block | Rendered when | Line forms |
|---|---|---|
| Ownership | Stage 4l applied grants | one line per functional-ownership row: the role, `owns this module` or `helps run it`, the level granted |
| Business roles | Stage 4k provisioned personas | one line per persona: `new` or `existed`, then the actions and levels it carries |
| Permissions kept here until their home module is installed | Stage 4a-scaffold re-prefixed permissions | one line per permission, by action |
| Permissions moved to their home module | Stage 4n ran | one line per permission: table, action, the module it moved to, grants kept |
| Handoffs to other modules | Stage 4m ran | `✓` per connected handoff; `🟡` per one recorded only, with the continuation line shown |
| Links not added, other table not installed | a presence-conditional link was skipped | `💤 <table> → <other table>` |
| Steps skipped | a ⚠-flagged lifecycle row was skipped | `⚠️ <table>: <state>: <reason>` |
| Icons not deployed | the deploy script printed `iconFindings` lines (an icon not in the bundled Lucide list) | `🟡 <Plural Label>, <Field Label>: <Entry Label>: "<name>" is not an icon, shown with none`; `🟡 Module icon: "<name>" is not an icon, shown as box`. Each counts as a warning (🟡) in Counts |
| Business process rules | Stage 4k ran in `living` mode (check 7) | one line per process by name, then the assignment, accountable and gated-step lines; any failure is `🛑` with one indented line naming the process and role |

**Closing lines**, at the end of the code block, in this order:

1. **Read-visibility callout**, one line per table whose `select_rule` this deploy created, changed or removed: *"⚠️ <Plural Label>: from now on people see only rows where <the rule in plain words>. Check that this is intended."* It mirrors how a change to who can edit a table is called out: a visibility change has the same "why can't I see X anymore" failure mode.
2. **Verdict:** `✓ Verification passed.` when the problem count is 0; otherwise `🛑 Verification failed: <N> problems, listed under Checks.`
3. **Access level (mandatory):** *"🔐 Access level: <plain words>."*, in the same words as the Stage 3 plan line (`basic` "view and edit"; `advanced` "view, edit and admin"; `gated` "the admin takes the restricted steps"; `raci` "business roles take the restricted steps"; `custom` "permissions set up by hand, left as they are").
4. **Summary line**, for anyone reading the run log: *"✅ Done. <N> modules created, <N> updated; <N> permissions, <N> access inclusions, <N> tables and <N> fields added."*, leaving off any count of zero, followed, when they apply, by *"Built-in tables used: Users."*, *"Fields added to built-in tables: <N>."* and *"Visibility rules: <N>. Field display rules: <N>."* Wrapped at 80 characters like every other line.

### "Decided for you after your go-ahead" (fast runs only)

> **Fast flow, after the go-ahead:** end the verification report with this section ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 6), placed after everything else in the report and before the Closing Contract's `---`; don't ask.

Build it from `.tmp_admin/<run_id>/auto-picks.md` (the `run_id` is in the `Run context:` line), the log every skill in this run appended to with `log_pick`. Read it silently. Each log line (`<skill> | <decision> | <pick> | <basis> | touches: <module>`) becomes one bullet in plain words, the decision and what was picked; never show the skill name, the basis, or raw identifiers (the Writing Conventions ban list applies):

```
**Decided for you after your go-ahead**

Changes to other modules:
- <decision and pick, one line per log line whose touches: names another module>

In this module:
- <every other log line, grouped by skill (design, matching, deploy) in log order>

Say "change" and what you want different to revisit any of these.
```

"Changes to other modules" comes first and holds only the lines whose `touches:` names another module; leave the group out when it is empty. A missing or empty log leaves the whole section out. Never render this section in a guided-flow or expert-flow run. The Closing Contract follows: the `---`, then the status line, the link, the spec download link, and the sample-data question.

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

**Narration.** None. This is internal bookkeeping; the front-matter change (visible in the user's `git diff`) is the receipt. Do **not** add a line to the closing block — the Closing Contract's lines are fixed (SKILL.md) and the version stamp is not one of them.

### Gates

Two integrity gates fire outside Stage 5 and are defined where they fire (not here):

- **Gate A** (pre-write planned-state integrity check): `references/stage-3-plan.md`; fires in Stage 3 before any Stage 4 writes.
- **Gate B** (steward seed non-empty): `references/stage-4-execute.md`; fires in Stage 4 immediately after 4j.

---

## Closing Contract

The Closing Contract (clean-deploy call-to-action, sticky-footer behavior, and the halt carve-out) is defined in `SKILL.md` (the spine) so it stays resident across follow-up turns even after this file is compacted.

