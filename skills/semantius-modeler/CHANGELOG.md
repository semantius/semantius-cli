# semantius-modeler — changelog

The deployer's `EXPECTED_MAJOR` and the parser version are bumped in lockstep with the analyst skill (`semantius-architect`). This file records the deployer-side delta for each analyst minor / major bump. The current `EXPECTED_MAJOR` constant and the routing rules for older / newer majors live in [SKILL.md](./SKILL.md) under "Schema compatibility"; this file records how the deployer's behavior changed when each contract change landed.

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## Unreleased: §3 flag removal, frontmatter simplification, `canonical_`→`catalog_` rename, `domain_code`/`access_scope`/`icon_name` as top-level columns

2026-06-27. Deployer-side half of the platform-schema contract change (architect + use-semantius landed the upstream half). `EXPECTED_MAJOR` stays `5` — the prior version was never deployed, so there is no installed base to migrate.

Platform columns moved / renamed / deleted, so the deployer's writes change:

1. **Stop stamping `entities.pattern_flags` (column deleted).** Removed the stamp from the Stage 4c provenance payload, the 4c provenance checklist row, the "`pattern_flags` is the trap" block, the Stage 1 derivation (Model-to-Entity Mapping), the SKILL.md provenance list, the `deploy-script-template.md` payload comment, and the Stage 5 entity-provenance assertion. The §3 behavior flags (`personal_content` / `submit_lock` / `single_approver` / `multi_approver`) were never platform-enforced; enforcement always lived in analyst-authored `select_rule` / `validation_rules` + RBAC.
2. **`entities.canonical_owner_module` → `catalog_owner_module`**, and the spec line label `**Canonical owner:**` → `**Catalog owner:**` (the analyst emits it, the deployer parses it — renamed atomically across both skills). Part of the `canonical_`→`catalog_` concept rename, including the re-prefix machinery (`re-prefixed-from <catalog-module>.<verb>`, catalog-prefixed / non-catalog-prefixed permissions, Stage 2i "Catalog-owner detection"). The authoritative English sense of "canonical" (canonical copy / source / built-in list / branches) is unchanged.
3. **`domain_code` / `access_scope` → top-level `modules` columns** (were `modules.settings` keys), plus the **new `modules.icon_name`** column. The Stage 4a create/update payload, the 4a checklist + example, the Stage 2a `create_module` plan, the module schema note, the Stage 2.5 access-scope persist + the detection query (`access_scope=eq.full`, was `settings->>access_scope=eq.full`), and the Stage 5 verify round-trip all read / write the top-level columns now. `modules.settings` keeps `naming_mode` / `module_kind` / `catalog_snapshot` / `promotion_decisions` / `raci_mode`.
4. **`modules.description` ← frontmatter `tagline`** (was `system_description`, removed). `tagline` is now the ≤40-char selector-chip text; the `description` frontmatter key is longer marketing prose, carried only.
5. **Approval cross-check retired (Stage 2j).** The `single_approver` / `has_single_approver` named-gate mechanism is gone; an approval is now a §7 gated transition + its §8.1 `workflow-gate` permission (minted / verified like any §8.1 row) + the §9 RACI Accountable actor. The §8.1 `override` tier no longer carries a `(personal_content)` / `(submit_lock)` parenthetical.

Deploy-time correctness change (the deployer would otherwise write platform columns that no longer exist as `settings` keys / under the old names); no spec-shape change beyond the frontmatter keys above. The `settings.access_scope` / `settings.domain_code` entries further down are now historical — read them as "what was true before this entry."

## Unreleased: plain-language vocabulary pinned (entity vs. field vs. record); access-control label plainer

2026-06-22. Two user-facing wording fixes, both documentation/contract (no executor-code change), `EXPECTED_MAJOR` stays `5`:

1. **Entity / field / record nouns pinned in the Writing Conventions.** The plain-language deploy contract is model-generated and the conventions had no rule keeping the three nouns distinct, so a deploy rendered *"Create 5 records and their fields"* — calling entities "records," which collides with the Stage 6 meaning of "records" (saved rows / sample data). Added a banned-usage bullet: an entity (table) is named by its Plural Label or called a "table" / "record type" (never "records," never "fields"); a "field" is only a column; "records" / "rows" are reserved for data rows. Worked example shows *"Create 5 tables and their fields"* ✅ vs. *"Create 5 records and their fields"* ❌.
2. **Access-control option label.** The Stage-2.5 access-control prompt's `Full access control` option is now `Advanced access control` (basic access is not missing capability, it is simply not role-gated), and the "add full access control later" line reads "advanced."

**Minor**: user-facing prose only. No parser, executor, or schema-compatibility change.

## Unreleased: Stage 6 sample-data count made prescriptive (fixes under-seeding drift)

2026-06-22. A deploy seeded only 2 records per entity despite the Stage 6 question promising 10, because the count lived solely in advisory prose and the script-pattern example demonstrated exactly 2 rows per entity — so agents copied the example, not the instruction. No skill regression; this was runtime drift the prose did not prevent. Three coupled changes to Stage 6, all documentation/contract (no executor-code change), `EXPECTED_MAJOR` stays `5`:

1. **New "How many records" rule.** The default is now stated as *exactly 10 per eligible entity*, framed as a commitment the user's "yes" buys. The only legitimate ways to seed fewer are an explicit user-chosen count or FK-id scarcity on a required field, and both must be surfaced. Adds a pre-run self-check: count `post(...)` calls per entity and add rows until the count is met.
2. **Fixed the misleading script example.** The pattern previously showed 2 hard-coded rows per entity; it now loops over a row array with explicit `... 10 total ...` markers and a banner stating the example is abbreviated for readability only.
3. **Summary must report per-entity counts.** The run step now requires reporting how many records landed per entity, with a reason on any line below the target. Turns silent under-seeding into a visible defect.

## Unreleased: `module_id` is now reliably set + self-healing on permissions, roles, AND entities

2026-06-21. Fixes a deployed defect from the `it-ops-starter` deploy where `module_id` came back NULL on records that the platform/model expects to own a module FK:

- `it-ops-starter:read` / `:manage` permissions: `permissions.module_id = NULL`.
- All five owned entities (`asset_contracts`, `saas_subscriptions`, `service_incidents`, `saas_applications`, `software_licenses`): `entities.module_id = NULL` — no entity pointed at module 1033 at all.

Two distinct root causes, same symptom:

1. **Permissions/roles — create-only scaffold.** Step 2 / step 4 ran `create_permission` / `create_role` *only* on `read_* ` exit 1 and did nothing on exit 0, so a row once minted with a NULL `module_id` could never self-heal; every re-deploy read exit 0 and skipped it. (The prose already said to pass `module_id`, and `rbac.md` shows it — the gap was the missing converge path.)
2. **Entities — `module_id` absent from the create instructions entirely.** The **Model-to-Entity Mapping** table (the authoritative param list the deployer builds `create_entity` from) and the ✨-New prose bullet both enumerated every other column but **omitted `module_id`**, even though `data-modeling.md` documents it as *required on `create_entity`* (null rejected). The deployer faithfully built a payload without it.

Changes:

1. **Stage 4a-scaffold step 2** now *converges* `permissions.module_id` (exit-0 path asserts and `update_permission`s NULL/mismatched values).
2. **Step 4 (default roles)** gets the identical converge guard for `roles.module_id`.
3. **Model-to-Entity Mapping table** now lists `module_id` as a required `create_entity` param (this-module for create-new/rename-incoming; master module for promote-to-master); the **✨-New prose** passes it explicitly.
4. **Stage 4c ♻️ same-module path** converges `entities.module_id` on re-run (repairs a stranded entity instead of skipping it).
5. **Stage 5** — per-area check 1 reworded so a permission `module_id` hit means the Stage 4 backfill didn't land (re-issue + halt); per-area check 5 gains an owning-`module_id` assertion for every owned entity (previously only *promoted* entities were checked).

All four record types (`permissions`, `roles`, `entities`, plus the existing `modules` FK refs) now both set `module_id` correctly on first deploy and converge it on re-deploy. `EXPECTED_MAJOR` stays `5`. Deploy-time correctness/idempotency fix only; no spec-contract change.

Live note: the five stranded `it-ops-starter` entities still carry NULL `module_id` in the instance — a re-deploy now repairs them via the Stage 4c converge path (or an explicit `update_entity ... module_id=1033`).

## Unreleased: persist `settings.access_scope` on every deploy path; access-scope default reads it

2026-06-20. Two coupled changes so the access-scope default reflects what the instance actually uses.

1. **Persist on every resolution path.** The modeler previously recorded `modules.settings.access_scope` only at resolution step 3 (the "undecided → ask" path). In the normal hybrid pipeline the spec frontmatter carries the decision (step 1), so the setting was never written and live module records showed `settings.access_scope = null`. The modeler now writes the resolved value via an idempotent `update_module` at Stage 4a-scaffold on all three paths (frontmatter, prior setting, ask), same pattern as `settings.raci_mode`.

2. **Detection backstop matches the analyst.** The Stage 2.5 default detection no longer sniffs for any non-built-in permission / non-system role (a basic deploy creates those too, so it could not tell basic from full). It now counts live modules whose `settings.access_scope = full` (excluding the module being deployed): any row → default Full, none → default Basic.

`EXPECTED_MAJOR` stays `5`. Behavior change to a deploy-time default and an added idempotent write only; no spec-contract change.

## Unreleased: blueprint front-matter key renamed (`fact_sheet_version` → `blueprint_version`)

2026-06-15. The spec front-matter key carrying the blueprint artifact version was renamed `fact_sheet_version` → `blueprint_version` (value unchanged at `"3.0"`). `EXPECTED_MAJOR` stays `5`; the deployer gates on the spec's `version` major (not this key), so there is no behavior change. Coordinated with the architect and analyst.

**No `EXPECTED_MAJOR` bump applied** (deferred to the maintainer).

---

## Unreleased — access-control scope (basic vs full RBAC); Stage 2.5 backstop

`EXPECTED_MAJOR` stays `5`. Lockstep delta with the access-control change folded into the (unreleased) analyst `5.3` — no version bump, since the analyst was never released. **The architect is not involved** (it is platform-agnostic and never decides access control; the analyst owns the decision because it is platform-aware). Closes the reliability gap where the modeler deployed a spec's full RBAC (permissions, roles, workflow gates, lifecycle gating) unconditionally and never asked whether the user wanted plain read + edit access.

**What changed in the deployer.**

1. **Stage 1 parse** reads an optional `access_scope` frontmatter key (`basic` / `full`); a value outside those two is a 🛑 High blocker.
2. **New Stage 2.5 (Access control scope)** between Stage 2 and Stage 3. Resolution order: spec frontmatter `access_scope` → live `modules.settings.access_scope` (a prior deploy's choice) → detect-and-ask. Detection: an instance "already uses access control" when it carries any non-built-in permission (outside `user:read` / `user:manage` / `admin` / `public:read`) or any non-system role; that flips the default (fresh → Basic, RBAC-in-use → Full). The prompt fires ONLY at the detect-and-ask branch — when the spec or module already carries the choice, the modeler obeys without asking (consistent with "the only confirmation the modeler asks").
3. **Two-permission projection (Stage 4)** when the resolved scope is `basic` and the spec is full-shaped: deploy only `<slug>:read` + `<slug>:manage`, the `manage → read` edge, and viewer + manager roles; force every `edit_permission` to `<slug>:manage`; drop write/read rules that gate on a dropped permission (keep pure-logic ones); skip 4k (personas/RACI), 4l (functional ownership), 4m (handoffs). When the spec is already two-permission-shaped (the hybrid path, analyst authored it basic), the projection is a no-op. The rare entry whose JsonLogic mixes a permission gate with a data-integrity check routes back to the analyst rather than guessing.
4. **Persistence**: Stage 4a writes `modules.settings.access_scope` so re-deploys read the choice back (Stage 2.5 step 2) and never re-ask.
5. **Plan + verification**: a `🔐 Access control:` line in the Stage 3 plan and a mandatory access-control callout in the Stage 5 summary (naming what a projection suppressed, and any pre-existing higher-governance objects left as quiet orphans — never deleted, per the no-auto-deletion rule).

**No bump.** `EXPECTED_MAJOR` unchanged. `access_scope` is a new optional frontmatter key with a defined default (absent = undecided = the backstop resolves it at deploy time, reproducing prior behavior when `full` is chosen). No structural change; every spec authored before this change deploys unchanged. The analyst minor bump was not applied — the analyst was unreleased, so the change folds into the current version (analyst `5.3`). The architect is unchanged.

---

## `v5.3` (MINOR) — enforce lifecycle state field name (`workflow_state`); stop stamping `catalog_field_code`

`EXPECTED_MAJOR` stays `5` (analyst `5.3` is the same major). Lockstep delta with analyst `5.3` and architect `5.2`. Two changes in the deployer.

**What changed in the deployer.**

1. **Enforce the fixed `workflow_state` lifecycle state field.** Stage 1 parse adds a 🛑 High blocker: any spec whose lifecycle state lands in a field not named `workflow_state` FAILS LOUD and routes the user back to the analyst. Detection: a `process_gates[].state_column` ≠ `workflow_state`, or a lifecycle-bearing entity (one with a `workflow-gate (lifecycle)` permission or a `process_gates` row) whose §3 Fields table has no `workflow_state` enum field. Stage 5 adds a live round-trip of the field name. The deployer never silently renames the field.
2. **Stop stamping `catalog_field_code`.** The platform is dropping `fields.catalog_field_code`; `create_field` no longer passes the value, the Model-to-Field mapping and Provenance-stamping rules drop it, and the "three scalar codes" become two (`catalog_entity_code` / `catalog_module_code`). `catalog_role_code` and the rest are unchanged.

**Major-vs-minor.** `EXPECTED_MAJOR` unchanged. The state-field gate is a stricter validation, not a spec-format change — a spec that already uses `workflow_state` deploys unchanged; a legacy spec with a differently-named state field now fails loudly (the intent). No structural change.

---

## `v5.2` (MINOR) — composed record labels: parse / stamp / verify `label_parent`; skip `_label` / `<fk>_label`; reserved-name guard

`EXPECTED_MAJOR` stays `5` (analyst `5.2` is the same major). Lockstep delta with analyst `5.2` and architect `5.1`. The platform added read-time composed labels (`_label` on every entity, `<fk>_label` on every reference/parent FK) and an optional `label_parent` entity property naming the identity-spine FK. The analyst now derives and emits `label_parent`; the deployer stamps and verifies it.

**What changed in the deployer.**

1. **Parse `**Label parent:**`.** Stage 1 captures the new per-entity line into `label_parent` (default null/absent). Added to the Model-to-Entity mapping table.
2. **Stamp `label_parent`.** The ✨-New `create_entity` branch passes `label_parent` only when the line is present (omit → null); the ♻️ same-module branch re-points it via `update_entity` on drift (set to the spec's FK, or clear when the spec omits the line). Unlike the write-once provenance codes it is a normal nullable property — re-pointing is allowed, with no data migration.
3. **Skip the composed-label columns.** `_label` (`ctype: _label`) and every `<fk>_label` (`ctype: fk_label`) join the auto-generated skip set — never `create_field`ed, skipped on every field diff. They never appear in the spec's Fields tables or in `read_field`.
4. **Reserved-name guard (defense-in-depth).** Before any `create_field`, reject any `field_name` starting with `_` or ending in `_id_label` (platform-reserved; the platform also rejects). A spec carrying such a name is an authoring bug → FAIL LOUD, route back to the analyst.
5. **Stage 5 round-trip.** Verify `label_parent` matches the spec (set when the `**Label parent:**` line is present, null otherwise) and that no `_label` / `<fk>_label` column was materialized as a real `fields` row.

`entity_type` stamping already existed (the v5.1 provenance pass) — unchanged here.

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged. The `**Label parent:**` line is an optional per-entity sub-block (5.1 specs still parse; an older deployer that ignores it leaves `label_parent` null with no regression). No structural change, no `fact_sheet_version` bump.

---

## `v5.1` (MINOR) — provenance stamping pass: `catalog_entity_code` / `entity_type` / `catalog_entity_aliases`

`EXPECTED_MAJOR` stays `5` (analyst `5.1` is the same major). Lockstep with analyst `5.1` and architect `5.0` (`fact_sheet_version 2.2 → 3.0`). The analyst began carrying the blueprint's provenance into the spec as per-entity lines; the deployer learned to stamp them onto the platform's v0.1.2 core provenance columns.

**What changed in the deployer.**

1. **Parse the new per-entity lines.** `**Catalog entity code:**` → `catalog_entity_code`; `**Entity type:**` → `entity_type`; `**Catalog alias:**` → an element appended to `catalog_entity_aliases`. Added to the Model-to-Entity mapping table.
2. **Stamp on `create_entity` (write-once codes).** The ✨-New branch stamps `catalog_entity_code` (the CANONICAL code, defaulting to `table_name`), `entity_type` (`'unclassified'` when absent), `canonical_owner_module`, and `pattern_flags` on the same payload. Codes are write-once — never re-sent on a later rename.
3. **APPEND `catalog_entity_aliases` on reuse/merge.** A cross-domain identity renamed onto an existing host appends `{alias_code, source_domain, source_module, decided}` to the host's array (read-modify-write; never rewrite or drop prior elements).

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged; the spec additions are new optional per-entity lines an older deployer ignores (the columns stay at their empty defaults). Stamp-only; no structural change.

---

## `v5.0` (MAJOR) — §2-Permissions-summary retirement finalized; `EXPECTED_MAJOR 4 → 5`; canonical empty-section placeholder recognized

`EXPECTED_MAJOR` bumps from `4` to `5` in lockstep with analyst `5.0` (and architect `4.3`). Two coordinated contract changes land together:

**Change B (breaking, this skill's major) — §2 Permissions summary retired; §8.1 / §9.1 canonical.** The analyst's spec no longer carries the §2 Permissions summary table; the §8.1 Permissions catalog and the §9.1 Permission hierarchy (including the `manage → narrow` rollup row that moved out of §2) are the canonical permission surface. This is a breaking spec-structure change (a structural table removed), so pre-existing `4.x` specs — which carry §2 Permissions summary with the narrow rollup that lived only there — are **non-deploy-safe** and are rejected at Stage 1 (`major != EXPECTED_MAJOR`) until regenerated through the analyst. This is the intended migration signal, not a regression.

**Change A (non-breaking) — canonical empty-section placeholder.** The architect/analyst now keep every canonical section present and write `_(none: <short reason>)_` (bare `_(none)_` allowed) when a section is empty. The deployer's one literal empty-section read — the §6 cross-model-link-suggestions read at Stage 1 — now recognizes the canonical placeholder (detect via `^_\(none\b`), treating it as "section present, empty" (zero rows; Stages 2g / 4h no-op). The retired sentence `No cross-model link suggestions.` is kept only as a grandfathered alias, treated identically. This is a staleness fix, not a runtime change — an empty/placeholder §6 yields zero table rows either way.

**What changed in the deployer.**

1. **`EXPECTED_MAJOR 4 → 5`** at the Schema-compatibility heading, the prose mention, and the error string. The Conflict-Resolution version rows parameterize on the `EXPECTED_MAJOR` symbol and track the constant automatically. The historical "v4.1 contract additions" narrative's `EXPECTED_MAJOR stays 4` clause was rewritten to past-tense.
2. **§6 read recognizes `_(none: …)_`** as the empty-section form (Stage 1 §6 parse), no longer matching only the retired sentence. The placeholder line is never parsed as a table row nor carried forward as data.
3. **`fact_sheet_version` echo reconciled** to `"2.2"` (the architect's stamped value; major `2` unchanged — informational, the modeler does not re-validate it against the architect).

**Folded-in consolidation-era additions verified during the deployer audit (D1–D8):** Stage-1 `consistency-check.ts` pre-deploy gate; the Stage-4 "deploy incomplete, re-run" loud-failure invariant; Stage-5 Per-area check #7 (live-RACI round-trip); 4c-promote / 4h read-before-write tightening; the `promotion_decisions` list-shape parse note; the §6 resolve-at-deploy (5-col hint) read correction; the §9.1 RACI `process` column removed from the parse tuple; the inverted-hierarchy Conflict-Resolution row hardened to additive-only.

**Major-vs-minor.** MAJOR: the spec structural-table removal (Change B) is not backward-compatible — a `4.x` spec carries §2 and a `5.0` spec does not, and the two skills must move in lockstep. Change A is non-breaking on its own (the placeholder recognition is purely additive tolerance), but it ships in the same lockstep bump.

---

## `v4.1` (MINOR) — RACI-mode-aware Stage 4k: sync the live RACI matrix + enforcement (living mode); agent actors

`EXPECTED_MAJOR` stays `4` (analyst `4.2` is the same major). The deployer learns to drive the platform's now-shipped live-RACI engine (`0210_raci.sql`, PR #189) instead of only compiling RACI into `role_permissions`. Lands in lockstep with architect `4.2` and analyst `4.2`. Backward compatible: `documentation` mode is the default and reproduces v4.0 behavior exactly.

**What changed.**

1. **Mode pre-step (Stage 4k).** Resolve the module's RACI mode: honor the spec's `**RACI mode:**` line (the analyst already asked — the deployer does NOT prompt). Absent → catalog-aware fallback (`living` when ≥1 module already uses RACI, else `documentation`); no RACI engine on the instance → force `documentation`. Surface `🧭 RACI mode: <mode>` in the Stage 3 plan.
2. **Living-mode materialization (Stage 4k).** Emit the analyst's RACI plan via the generic `postgrestRequest` tool — the `crud` server exposes **no** dedicated `create_process` verb (confirmed against CLI v0.5.8), so all RACI-table CRUD goes through `{method, path, body}` against `/processes`, `/raci_assignments`, `/process_gates`. Idempotent GET-by-natural-key → POST on miss. Set `process_gates.emits_events = true` for C-notify / I (drives the platform emit trigger → `raci_events` → `raci_notify` queue). Author the A-gate (`is_raci_actor`) and C-block (`has_consultation`) as `validation_rule`s via the existing `update_entity` path — the A-gate replaces the hand-authored `has_single_approver` when living. Set `modules.settings.raci_mode = "living"`. Pre-verify at most one `accountable` per process (the platform also enforces a partial unique index).
3. **Agent actors no longer deferred.** `kind = skill` rows resolve to a role held by an agent user (`users.is_agent = true`) via `create_role` + `create_user` (`is_agent`) + `create_user_role`, then are treated like personas. Removes the v4.0 "🟡 informational … Plan-5 will revisit when the platform exposes the relevant tables" deferral — the platform now exposes them. ("Accountable must be human" enforcement + JIT agent tokens remain platform Phase 3.)
4. **The write-tier grant still flows in both modes.** Living mode is **additive**: RLS is permission-based, so an actor still needs the baseline tier grant to touch the table. Living mode adds the matrix + rules; it does not remove or regenerate `role_permissions`.

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged, `documentation` mode default = v4.0 behavior, all living-mode work is opt-in per module.

---

## `v4.0` (MAJOR) — extended blueprint/spec contract: §9 governance, module_kind, presence-conditional FKs, ⚠ handling, has_single_approver cross-check, entity-owning-module rule + master-install reconciliation

`EXPECTED_MAJOR` bumped from `3` to `4` in lockstep with analyst `4.0` → `4.1`. Files written by analyst `4.x` may carry six new authoring conventions on top of `3.x`:

1. **Frontmatter additions** — `tagline`, `description`, `persona` (flat list), `license`, `module_kind` (informational label; NOT a behavior switch).
2. **§3 `**Reconciliation:** re-prefixed-from <canonical-module>.<verb>` annotation** on workflow gates and pattern-flag overrides for `embedded_master` entities whose canonical owner module is absent.
3. **§5 `delete_mode` / `fk_format` columns** (already covered by the existing field-shape parse; the deployer now consumes verbatim and adds the §5.3b cross-scope vocabulary `none` / `none (required-if-present)` / `⚠ audit`).
4. **§6.2 / §6.3 `transition` column** carrying `<to_state> _(<event_category>)_`.
5. **§7 ⚠ annotations** (`⚠ state-machine shape: <reason>`, `⚠ unresolved gate: <reason>`).
6. **§9 governance section** (baseline roles + permission hierarchy + RACI realization + functional ownership).

Pre-3.0 files are still rejected (the major mismatch is a halt); a 4.0+ deployer reading a 3.x file rejects via the schema-compat gate, routing back to the analyst.

**The failure modes this fixes.**

- **Phantom permissions** — under v3.x, `has_single_approver` rules paraphrased the approve gate; the analyst minted `<slug>:approve_<entity>_approval` and dead role-permission rows landed on deploy. v4.0 cross-checks at the deploy boundary (Stage 2j) that the rule names a permission code that actually appears in §2.
- **Broken non-null restricts** — §5 edges declaring `is_required = true` with absent targets emitted FK columns with non-null restrict, breaking row inserts. v4.0 Stage 4d skips FK column emission for `delete_mode: none (required-if-present)` when the target isn't installed.
- **No persona / functional-ownership provisioning** — §9 didn't exist; baseline roles / hierarchy / RACI were ad-hoc. v4.0 adds Stage 4k (persona provisioning) and Stage 4l (functional-ownership default grants) as authoritative consumers of §9.
- **Embedded-entity "thin shells" with un-minted gates** — when a blueprint embedded an entity whose canonical owner was absent, the entity's gates / overrides were under-emitted. v4.0 Stage 4a-scaffold mints under the installing-unit slug per the entity-owning-module rule; Stage 4n reconciles when the canonical owner later installs (sibling permissions + sibling role_permissions; no deletes).
- **Silent ⚠ provisioning** — v3.x had no concept of soft data-quality flags. v4.0 Stage 4d's ⚠ handling SKIPS or FAILS LOUD rather than silently provisioning a malformed state machine or phantom gate.

**The new convention.**

1. **Stage 1 (Parse)** extended with: new frontmatter (`module_kind`, `tagline`, `description`, `persona`, `license`); §8.1 `re-prefixed-from` annotation; §8.2 `has_single_approver` named-gate extraction; §6 `transition` column; §7 ⚠ annotations; §9 governance sub-indices (baseline_roles / permission_hierarchy / raci / functional_ownership).
2. **Stage 2 new sub-stages:**
   - **2h `module_kind` recognition** — surface in plan summary, no behavior branch.
   - **2i Canonical-owner detection** — for every §8.1 row with `re-prefixed-from`, look up the canonical module live; queue for Stage 4n reconciliation when present.
   - **2j `has_single_approver` cross-check** — re-verify at deploy boundary that the named gate exists in §2.
3. **Stage 3 plan-summary line types added:** `🏷 module_kind`, `👥 Personas to provision`, `🏢 Functional ownership`, `🔁 Re-prefix`, `🔁 Master-install reconciliation`, `⚠️ Skipping on ⚠`, `💤 Skipping FK (presence-conditional)`.
4. **Stage 4 sub-stages added:**
   - **4d extension** — skip FK column emission for `delete_mode: none (required-if-present)` when target absent; honor ⚠ annotations (SKIP / FAIL LOUD).
   - **4a-scaffold extension** — when a §2 row carries `re-prefixed-from`, mint under the installing-unit slug as-is (the analyst already resolved the prefix per the entity-owning-module rule).
   - **4k Persona provisioning** — idempotent role check + grant resolution per RACI row, using the row's `grant_module` column (the entity-owning-module lookup result emitted by analyst v4.1+). Persona-actor rows mint tenant roles; skill-actor rows defer to platform `personas` / `skills` support.
   - **4l Functional-ownership default grants** — walk §9.2; resolve named default_role; idempotent role-permission grant.
   - **4m Boundary-crossing handoff wiring** — wire `transition_event_triggers` (when supported); 🟡 informational rows when the platform doesn't expose the registry yet.
   - **4n Permission reconciliation on owner-module change** — fires when Branch-B promotion moves an entity. Sweeps every accumulated non-canonical prefix (multiple prior installs possible), mints canonical-prefixed sibling permissions, creates sibling `role_permissions` rows, re-emits matching `permission_hierarchy` edges. No deletes (per the no-auto-deletion symmetric rule). Symmetric across install orderings.
5. **Stage 5 (Verify) new structured report sections:** Functional ownership grants, Personas provisioned, Re-prefixed permissions, Master-install reconciliation, Boundary-crossing handoffs, Skipped FKs, Skipped on ⚠ flag.

**The entity-owning-module rule (the load-bearing simplification).** Workflow gates and pattern-flag overrides for entity E are prefixed by E's CURRENT owning module slug, not by the installing unit. The rule applies uniformly to every blueprint shape (`hiring-starter`, `ats-recruitment-pipeline` which is itself master-of-15-and-embedded-of-5, `real-estate-agent`, any future bundle) and to every install ordering. The deployer's behavior on every install is `module_kind`-agnostic — no special "starter" branch. Walked install orderings:

- **First-installer creates the entity** → entity's owning module = the installing unit; gates / overrides get the installing-unit prefix.
- **Later-installer finds the entity already exists** → reuses it via `reuse-from <other-module>.<entity>`; personas grant on existing codes via the row's `grant_module` column. No duplicates.
- **Canonical owner installs (first, mid-sequence, or last) and Branch-B promotion moves the entity** → Stage 4n reconciles every accumulated non-canonical prefix onto the canonical prefix. N prior non-canonical prefixes → N sibling grants per role per verb. No deletes.

**Plan-5 escape hatch.** When the platform later moves to entity-scoped identity (`<entity>:<verb>`), Stage 4n becomes a no-op merge — the prefix never changes because there isn't one. The deployer-side reconciliation obligation disappears entirely; Stage 4n becomes documentation of the rule the analyst already enforces at spec-write time.

**Major bump rationale.** Although the new contract carriers are additive at the syntactic level (new columns, new sub-sections, new frontmatter keys), the changes are not backward-compatible at the **semantic** level: a v3.x deployer reading a v4.x file would silently produce the wrong shape (phantom permissions on `has_single_approver` rules, broken non-null restricts on presence-conditional FKs, no persona provisioning, no master-install reconciliation). The major bump is the honest signal that the two skills must move in lockstep.

**Companion changes.**
- Analyst `4.0` → `4.1` in lockstep (consume-the-blueprint paradigm shift; full per-skill scope in its own SKILL.md).
- Architect `4.0` → `4.1` in lockstep (extended blueprint contract: §3 write tier col, §5 cols, §6 transition col, §7 ⚠, new §9, embedded-entity-governance convention).
- Shared `references/data-modeling.md` (architect + analyst sibling copies): retired "deployable closure" framing; tightened `is_required` to presence-conditional; added "Embedded-entity governance follows the entity, not the role" subsection.

---

## `v3.3` (MINOR) — `permission_hierarchy` column rename (`parent`/`child` → `including`/`included`)

In lockstep with analyst minor `3.5`. The platform renamed two columns on `permission_hierarchy`:

- `parent_permission_id` → `including_permission_id` (the broader permission, the one doing the including; e.g. `crm:manage` when expressing "`crm:manage` includes `crm:read`")
- `child_permission_id` → `included_permission_id` (the narrower permission, the one being included; e.g. `crm:read`)

A row reads as `including_permission_id` ── *includes* ──▶ `included_permission_id`. Old column names are gone, not aliased — sending the old payload shape fails at PostgREST with an unknown-column error. The `id` natural-key format (`"<including>.<included>"`) and the `origin` enum (`"system"` / `"model"` / `"model_master"` / `"user"`, strictly immutable) are unchanged. `EXPECTED_MAJOR` stays at `3`.

**Where the deployer changed.**

1. **Stage 2a-scaffold step 3 (in-module hierarchy chain).** Resolution pattern restated: `includingId = (await read_permission_single("permission_name=eq.<broader>")).id; includedId = (await read_permission_single("permission_name=eq.<narrower>")).id;` then `read_permission_hierarchy --single by including_permission_id=eq.<includingId>&included_permission_id=eq.<includedId>`; `create_permission_hierarchy` payload becomes `{including_permission_id: includingId, included_permission_id: includedId, origin: ...}`. Verification narration renders as `<including_permission_name> → <included_permission_name>` (e.g. `product_roadmap:admin → product_roadmap:manage`, meaning admin *includes* manage).

2. **Stage 4b (in-module rollup chain).** Three-permission models write rows with `including = <slug>:admin, included = <slug>:manage` and `including = <slug>:manage, included = <slug>:read`. Two-permission models write `including = <slug>:manage, included = <slug>:read`. Idempotency read filters use the new field names. The "never invert direction" rule is restated explicitly: the narrower permission must never appear on the including side.

3. **Stage 4i (cross-module bridges).** Master-promotion read inclusion rows use `including_permission_id = <consumer>:read.id, included_permission_id = <master>:read.id, origin = "model_master"` (the consumer's `:read` *includes* the master's `:read`, so holding the consumer's read transitively grants visibility into the master's entities). Manage inclusion follows the same direction. Idempotency reads use the new field names.

4. **Lookup-conventions section.** Numeric-FK callout updated: `permission_hierarchy.including_permission_id` / `.included_permission_id` replace the old pair as the canonical example of resolve-use-discard FK columns. Verification narration example updated to reference `included_permission_id` instead of `child_permission_id`.

5. **No-auto-deletion safety rule.** The wording covering FK adjustments during master-rename / master-merge now names `including_permission_id` / `included_permission_id` as the legal mutations. Behavior unchanged: the deployer never deletes hierarchy rows, regardless of origin.

**Minor bump (not major).** The model file shape, the §2 column shape, and the `Hierarchy parent` column semantics are all unchanged. The change is internal to how the deployer writes the row, and to the natural-key narration the verification report renders. Analyst-side `3.4` and `3.5` files produce identical hierarchy rows on the new deployer; the bump exists to keep the lockstep history honest.

The CLI (`semantius v0.4.2` and later) accepts only the new field names. A `v3.2.1` deployer paired with that CLI fails on hierarchy creates with `PGRST204 — column "parent_permission_id" not found`. Upgrade in lockstep with the CLI.

---

## `v3.2.1` (PATCH) — `create_permission` must pass `module_id`; lookup conventions formalized

In lockstep with no analyst change; pure deployer-side bug fix plus a conventions tightening that prevents the same defect class.

**Bug fix.** Stage 2a-scaffold step 2 previously passed only `permission_name` and `description` to `create_permission`, leaving `permissions.module_id` NULL on insert. The defect was invisible to hierarchy edges and role-permission joins (which resolve by `permission_name` or by FK id, neither needing `module_id`) but produced real catalog drift: permissions were unscoped, so `?module_id=eq.<id>` queries silently missed them and per-module RBAC audits reported drift.

Fix: Stage 2a-scaffold step 2 now passes `module_id = <module.id>` on every `create_permission`. On re-run, a NULL or mismatched `module_id` triggers a corrective `update_permission`. The Conflict Resolution Reference gains a row covering the live-NULL drift case.

**Conventions: natural keys.** New subsection "Lookup conventions: prefer natural keys, never narrate numeric ids" right after Step 0. Three catalog tables carry stable unique natural keys (`modules.module_slug`, `permissions.permission_name`, `roles.slug`). The deployer now:
- always filters reads by natural key (`module_slug=eq.<slug>`, `permission_name=eq.<code>`, `slug=eq.<slug>_<tier>`);
- treats numeric ids as resolve-use-discard write-only artifacts (`role_permissions.permission_id`, `permission_hierarchy.including_permission_id`, `modules.manage_permission_id`, etc.);
- writes natural keys directly into text-FK columns (`modules.view_permission`, `entities.view_permission` / `.edit_permission`, `fields.reference_table`);
- renders every Stage 5 verification line by natural key (`product_roadmap:read`, `product_roadmap_viewer`, `product_roadmap → product_roadmap:manage`) — `id=N` only appears for an orphan FK whose target has no resolvable natural key.

Two Stage 2a-scaffold steps got concrete pattern guidance:
- Step 3 (hierarchy): the `permission_hierarchy` table only exposes numeric FKs, so resolve both ends from `permission_name` at the top of the pass and pass ids in the write payload; narration in chat / verification renders the natural-key form.
- Step 4 (default roles + `role_permissions`): same resolve-use-discard pattern for `role_permissions.permission_id` and `.role_id`. The `roles` table has no `label` column — guidance corrected (older drafts of this skill passed `label` and tripped a PostgREST schema-cache error).

**Stage 5 verification tightened.** Module scaffold integrity check #1 now explicitly says "dereference the FK and assert the natural key matches the expected value" — non-null FKs can still point at the wrong row. Each `manage_permission_id` / `admin_permission_id` / `default_*_role_id` is read back and its target's `permission_name` / `slug` asserted. This catches the `module_id IS NULL` defect class and any future class where a non-null FK exists but points at the wrong row.

No `EXPECTED_MAJOR` change.

---

## `v3.2` (MINOR) — cross-entity JsonLogic primitives pass through transparently

In lockstep with analyst minor `3.2`. No `EXPECTED_MAJOR` change; 3.x files continue to pass the version gate.

The platform now exposes three additional JsonLogic operators inside `validation_rules`, `computed_fields`, and `select_rule` bodies: `{"set_record": ["<name>", "<entity>", <id-expr>, <body>]}`, `{"let": ["<name>", <value-expr>, <body-expr>]}`, and `{"throw_error": "<message>"}`. The deployer already passes these arrays byte-for-byte to `create_entity` / `update_entity`, so the operators travel through the existing path with no parser change. Two adjustments to the deployer's static-analysis posture:

1. **Column-existence check is binding-aware.** The "column must exist on this entity" rule (applied to `select_rule`, `validation_rules`, `computed_fields` JsonLogic) skips column references qualified by a `set_record` or `let` binding name. The bound variable's columns are resolved against the *bound entity's* live shape (or, for built-ins, against the platform's known field list). An unbound column reference that fails to resolve is still a Blocker; a bound reference whose binding entity doesn't exist in the live catalog is a Blocker.

2. **Three new anti-pattern table rows.** (a) `set_record` referencing an entity that doesn't exist in the live catalog → 🛑 Reject; (b) top-level `throw_error` not guarded by an `if` → 🛑 Reject (unconditional throws belong in `edit_permission`, not `validation_rules`); (c) `set_record` inside `select_rule` → ⚠️ Perf warning surfaced in Stage 3 plan, deploy proceeds on user confirmation.

The 3.2 minor is forward-compatible: a 3.1 file parses unchanged against a 3.2 deployer, and a 3.2 file using the operators parses against a 3.1-aware deployer because the operators are syntactically valid JsonLogic the deployer doesn't introspect (the platform-side runtime is what gives them meaning). The two new anti-pattern rules and the column-check loosening fire only when 3.2 operators actually appear in the file.

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
