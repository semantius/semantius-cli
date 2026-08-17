# Stage 9 + 9.5: FK validation and RACI / persona reconciliation

*Reference for `semantius-analyst` (Stages 9 and 9.5).*

## Stage 9: Cross-tier FK reconciliation (validation-only)

The blueprint carries authoritative `write tier` per §3 row and authoritative `fk_format` per §5 row, so Stage 9 is a **validation-only** sweep:

1. **Confirm every entity's `write tier`** from §3 lines up with §8.1 permissions: a `:manage` row has a `<slug>:manage` permission; a `:admin` row has a `<slug>:admin` permission; a `:read` row is reference-only (no write tier). Mismatch → 🔴 blocker (the architect should have caught it).
2. **Confirm every FK column's resolved `fk_format`** matches the blueprint's intent. If the blueprint declares `fk_format: parent` for an edge whose child-tier is broader than the parent-tier, that's a structural inconsistency (the architect's cross-tier check failed) → 🔴 blocker.
3. **Validate cross-tier FK shapes:** child-tier should be no broader than parent-tier. The blueprint's `fk_format` and `delete_mode` MUST already encode the downgrade (cross-tier edges emit `reference` + `restrict` or `clear`, never `parent` + `cascade`). If the analyst finds a `parent` + `cascade` cross-tier edge that should have been downgraded, this is a 🔴 architect-side bug; surface the row and ask the user to re-run the architect.
4. **Validate `label_parent` is internally consistent.** For every entity carrying a `**Label parent:**` line (derived in Stage 4): the named field must be a real `reference`/`parent` FK declared on that entity in §3, and must NOT target a `junction` entity; and the line must NOT appear on a `junction` entity. A violation is a 🔴 blocker (a failure here means the derived spine name and the field list disagree). The `label_parent` graph across entities must be acyclic; a suspected cycle is a 🔴 blocker.

The analyst does not auto-rewrite FK shapes here. The blueprint carries the answer; this stage only confirms it is internally consistent. There is no "ask the user about each suspicious FK" widget — the architect rule emits the right shape upstream.

---

## Stage 9.5: §9 RACI + persona reconciliation (dual-path)

The blueprint's §9 governance section is the authoritative carrier of baseline roles + permission hierarchy + RACI realization + functional ownership. This stage reconciles each row against the live catalog and emits drift annotations.

**Two paths, chosen by RACI mode.** The platform's live-RACI engine (catalog tables `processes` / `raci_assignments` / `process_gates` / `raci_events`; operators `is_raci_actor` / `has_consultation`) lets this stage run one of two ways per module:
- **`documentation` mode (default):** compile the RACI matrix into RBAC grants (Step 3 documentation path). The process axis, the R/A/C/I letters, and agent actors are not stored live.
- **`living` mode:** plan the live RACI rows (`processes`, `raci_assignments`, `process_gates`) and the enforcement rules (`is_raci_actor` / `has_consultation`) the deployer authors — **in addition to** the baseline tier grants that table access still requires. The matrix becomes queryable and enforced live.

**Step 0 derives the mode** (below; auto-derived from instance state, NOT a user question). Steps 1–2 (RBAC scaffolding) and 4–5 run in both modes; Step 3 branches.

> **`access_scope = basic` short-circuit.** When the resolved scope is `basic`, this whole stage reduces to its baseline: force `documentation` mode (`raci_mode = documentation`; there is no Enable-RACI widget), emit only the viewer + manager roles (role slugs normalized `-`→`_` per Step 1) and the single `<slug>:manage → <slug>:read` hierarchy row, and skip RACI realization, the Processes catalog, and §9.2 functional ownership (emit each as `_(none: basic access)_`). No `persona` frontmatter. (See the "What basic authors" access-control contract in SKILL.md.)

**Step 0 — RACI mode (auto-derived from instance state; NOT a user question).** Whether this module is `living` or `documentation` is decided by the catalog, never by a prompt. The only meaningful signal is whether the instance already runs RACI, and that is a fact about live state, not a user preference; surfacing it as a widget duplicated the basic-vs-advanced access-control question (see "Access-control scope"). Derive it silently:

- **Honor an explicit signal first, if present:** an architect `raci_mode` frontmatter hint, or the triggering request explicitly asking for live / enforced / audited process rules ("enforce RACI", "with live approvals and an audit trail"). Either one pins the mode.
- **Otherwise compute from live state:** is any module already using RACI? (`GET /processes?limit=1` non-empty, or any `modules.settings.raci_mode = living`). **`living` when ≥1 module already does; `documentation` when none do.** A greenfield instance with no RACI elsewhere derives `documentation` (do not impose live-process overhead on a setup that is not using it); an ATS added to an org already running RACI derives `living`.
- If the live instance lacks the RACI engine entirely (no `processes` entity registered), force `documentation`.
- **Do NOT fire an `AskUserQuestion` for this.** There is no Enable-RACI widget. The user's single access-control decision (basic vs advanced) was already made at "Access-control scope"; selecting documentation vs living is this derivation's job, not a second prompt.
- **Record the derived `raci_mode` and its provenance:**
  - **Frontmatter:** `raci_mode: <living|documentation>` and `raci_mode_source: <computed-default|non-interactive>` (`computed-default` for the value derived on an interactive run; `non-interactive` for headless runs). This gate no longer produces `user-answer` (there is no widget to answer).
  - **§9 header line:** `**RACI mode:** \`<living|documentation>\`` (must match the frontmatter `raci_mode`).
  - **Customizations file:** persist `.raci.<module_slug>.mode` and `.raci.<module_slug>.source` to `$CUSTOMIZATIONS_FILE` via `yq`, so the derived choice is reused (and hand-editable) on re-deploys.
  - **Mechanical backstop:** the Stage 11 pre-save gate (resident in SKILL.md under "Verification gates"; the `consistency-check.ts` run) still rejects any spec that carries a RACI matrix but is missing `raci_mode` / `raci_mode_source`, or whose §9 line disagrees with frontmatter.

**Step 1 — Baseline-role drift.** Walk §9.1 baseline roles. **Normalize every role slug to the platform's `roles.slug` rule (`^[a-z0-9_]+$`) before emitting it to the spec: replace each `-` with `_`.** `module_slug` and the permission prefix derived from it may contain hyphens, but `roles.slug` may not, so the blueprint's `<system_slug>_<tier>` form (e.g. `ben-admin_viewer`) becomes `ben_admin_viewer` in the spec. This is the ONE place the normalization lives: the spec's §9.1 `role` column then carries the resolved, deploy-ready slug, and the deployer creates it verbatim without ever re-deriving `<slug>_<tier>`. Apply the identical `-`→`_` rule to every role-slug reference in the §9.1 RACI-assignment `role (slug)` column and the §9.2 functional-ownership rows, so all three sections resolve to the same role. Then, for each normalized row `<role_slug> | <slug>:read` etc., look up the role by `slug`. If missing, mark `✨ persona role to be created` for the deployer's Stage 4a-scaffold to mint. If present with mismatched `module_id` (a prior install attached it to a different module), mark as 🟡 drift; the spec carries an `**Reconciliation:** role-drift-on-module-id` note.

> **v5.4 baseline-roles table columns — `origin` and `catalog role code` (OPTIONAL, derived, display-only).** The §9.1 baseline-roles header is `| role | baseline grant | origin | catalog role code | reconciliation |` (the two columns inserted before the final `reconciliation`). They carry live `roles.origin` / `roles.catalog_role_code`, which the deployer RE-DERIVES from module type / slug, so round-trip through them is a functional no-op. The analyst leaves them BLANK (or omits the two cells) in a hand-authored spec; `semantius-optimizer` fills them from live state in a reverse-engineered one. They are NOT drift inputs — Step 1 above reconciles only `role` + `baseline grant`, never `origin` / `catalog role code`. Older 5.3 specs carry the 3-column form and still parse (the modeler reads the table by header name).

**Step 2 — Permission-hierarchy drift.** Walk §9.1 hierarchy rows. For each `<perm_A> includes <perm_B>` edge:
- Look up `permission_hierarchy` by composite key (`including_permission_id`, `included_permission_id`). Missing → spec carries `✨ hierarchy edge to be added` (deployer's Stage 2a-scaffold step 3 mints it). Mismatched `origin` is 🟡 drift.
- Validate both perms appear in §8.1. Missing → 🔴 blocker (architect-side bug; the §9 hierarchy can't reference a perm that doesn't exist).

**Step 3 — Actor resolution + per-mode realization.** Walk §9.1 RACI rows. First resolve every actor to a `role_id`:
- **Persona** (`kind = persona`): compute the slug (lowercased, underscored, hyphens → underscores): `RECRUITING-RECRUITER` → `recruiting_recruiter`. Look up the role by `slug`; missing → mark `✨ persona role to be created` (deployer's Stage 4k mints it).
- **Skill** (`kind = skill`): resolve to a **role held by an agent user** (`users.is_agent = true`) — the agent-native parallel to a persona. Compute the slug the same way; missing → mark `✨ agent-held role to be created` **and** `✨ agent user to be provisioned` (deployer's Stage 4k). No separate `personas` / `skills` record — the matrix is `role_id`-only.

Then realize, **by RACI mode:**

**_`documentation` mode (default)_** — compile to grants:
- For each `raci = responsible | accountable` row → compute the granted permission codes. **Apply the entity-owning-module rule** (decision #3 from the plan): for each gate the actor is R for, look up the gate's *owning entity's current module slug* in the live catalog. The grant uses `<entity_owning_module>:<verb>` — NEVER the installing-unit slug, unless the entity's current owning module IS the installing unit. Mark each `✨ persona grant to be added` for Stage 4k.
- For each `raci = consulted` row → mark `✨ advisory read grant to be added`.
- For each `raci = informed` row → mark `✨ notification side-effect to be wired` (deployer's Stage 4m if the platform exposes triggers; otherwise a 🟡 informational row).

**_`living` mode_** — plan the live RACI rows + enforcement. **The baseline tier grant is still emitted** (RLS is permission-based, so an actor still needs the write tier to touch the table; the entity-owning-module rule still applies to it). On top of that:
- **`processes`** — one row per Processes-catalog entry: `{process_key, name, description, ordering, module_id = installing unit}`. **Carry `name` and `description` through VERBATIM** — copy them byte-for-byte from the blueprint Processes catalog. They are authoritative reference content (often PCF-sourced); do NOT paraphrase, summarize, reword, shorten, fix grammar, or "clean up" the description. Rewriting it breaks traceability to the source taxonomy. Set `ordering` from catalog order. Reconcile against live `GET /processes?process_key=eq.`: reuse on match, else mark `✨ process to be created`.
- **`raci_assignments`** — one row per RACI cell: `{process_id, role_id, raci, consult_mode}`. Mark `✨ raci assignment to be added`. **Verify at most one `accountable` per process** (the platform enforces a partial unique index; the analyst pre-checks for a clean error).
- **`process_gates`** — bind `(entity, to_state, gate_kind)` to the process. **Emit `state_column` as `workflow_state`** — the fixed lifecycle state field name (every entity with a §7 lifecycle stores its state there). Never emit any other column name; the deployer rejects a `state_column` that isn't `workflow_state`. Set `emits_events = true` when the process has any `consulted (notify)` or `informed` actor. Mark `✨ process gate to be added`.
- **Enforcement rules** (the deployer authors these as `validation_rule` / `select_rule`, same mechanism as Stage 10):
  - **A (accountable):** an approval `validation_rule` calling `{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}` — this is the living realization of the approval gate (what `documentation` mode hand-authors as a `validation_rule`).
  - **C = block:** a pre-transition `validation_rule` calling `{"has_consultation": ["<entity>", "<to_state>", {"var": "<id_column>"}]}`. Sequence it AFTER the notify transition (the consulted party must be notified before the gate can pass).
  - **C = read / R-ownership / owner-scoped rows:** the existing ownership `select_rule` (`$old.<owner> == $user_id`) read-scope; keep the advisory read grant.
  - **C = notify / I:** no rule — the `process_gates.emits_events` flag drives the platform's emit trigger → `raci_events`.
- **Behavior realization (living only)** — when the entity has an approval gate, a submit-then-lock rule, or owner-scoped rows (the analyst's Stage 5 / 7 / 10 decisions), realize them as live RACI checks instead of hand-authored rules: an approval → the approval gate above + at-most-one-A; submit-then-lock → R-ownership + a `submit_lock` `process_gate`; owner-scoped rows → the ownership `select_rule`. In `documentation` mode these stay hand-authored.

**Step 4 — Functional ownership.** Walk §9.2 rows. For each `responsibility | business function | default role | default tier`:
- The named default role gets the named default tier on this module's baseline. Mark `✨ functional ownership grant to be added` for the deployer's Stage 4l.
- Functional ownership maps the named `business function` (a real organizational unit) to a deployer-resolvable role at deploy time. The analyst doesn't auto-resolve here; the deployer's Stage 4l does the mapping (or surfaces a prompt if the function name doesn't match any live role).

**Step 5 — Boundary-crossing handoffs and re-prefix annotations.** Per Writing Convention 10 on the architect, the §6.2 / §6.3 handoffs for embedded_master entities whose catalog owner is absent are emitted under the installing unit. The analyst carries them verbatim into the spec's §6, with the source_module set to the entity's current owning module (which may BE the installing unit, per the entity-owning-module rule). On master-install, the deployer's Stage 4n re-attributes the handoff to the new catalog owner module.

For every gate / override on an `embedded_master` entity whose catalog owner is absent in the live catalog, **emit `**Reconciliation:** re-prefixed-from <catalog-module>.<verb>` on the permission code in the spec's §8.1**. This is the analyst's signal to the deployer that the gate is reconciliation-eligible — when the catalog owner later installs and Branch-B promotion fires, the deployer's Stage 4n sweeps every re-prefixed-from-annotated permission and creates sibling perms under the catalog prefix.

The spec's §9 mirrors the blueprint's §9 verbatim (carry-forward), with one transform: role slugs are normalized `-`→`_` per Step 1, because the blueprint's hyphenated `<system_slug>_<tier>` form is invalid as a `roles.slug`. The deployer creates the spec's normalized slug verbatim. The reconciliation annotations live on the affected gates / overrides in §8.1, not in §9.
