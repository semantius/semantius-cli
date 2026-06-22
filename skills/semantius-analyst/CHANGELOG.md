# semantius-analyst — changelog

This file records the history of the analyst skill's `CURRENT_VERSION` (and its paired `EXPECTED_BLUEPRINT_VERSION`) and the content-contract changes each version introduced. The current constants and the rules a maintainer must follow when bumping them live in [SKILL.md](./SKILL.md) under "Skill version". The body of SKILL.md is the **current contract**; this file is the **history of how the contract evolved**.

This file is NOT loaded into Claude's context when the skill triggers. Maintainers read it when planning a bump; users read it when investigating why an older-major spec is shaped the way it is. Runtime behavior never depends on this file.

Entries below are newest first. Each entry follows the maintainer template: what changed, why, the new convention as a numbered list, and the major-vs-minor justification. (Pre-`5.0` analyst history lived alongside the architect's CHANGELOG and in git history; this file starts at the `5.0` lockstep bump.)

---

## Unreleased: optional-entity question respects the 4-option cap; access-control label and wording plainer

2026-06-22. Two user-facing fixes in Stage 3a (Optional concepts) and Stage 2c (Access control):

1. **Optional-entity question now handles >4 optionals.** Stage 3a told the analyst to fire "a single multiSelect `AskUserQuestion`" with one option per optional entity, but `AskUserQuestion` caps options at 4 per question. On a module with 5+ optionals (e.g. `it-ops-starter` has five) the analyst improvised by merging entities into one combined option, which silently forced an all-or-nothing choice and corrupted the per-slug `.optionals_decided` record. The stage now mandates: never merge entities into a combined option; split across multiple ≤4-option multiSelect questions under one shared header in a single `AskUserQuestion` call (up to 16 optionals), successive calls beyond that; and keep the optional-parts question in its own call so its chip is not mislabeled with the access-control header.
2. **Plainer wording.** The Stage 3a question/header dropped the jargon word "concepts" (`"Optional parts"` / *"Some parts of this module are optional…"*). The Stage 2c access-control option formerly labeled `Full access control` is now `Advanced access control` (basic access is not missing anything — it simply isn't role-gated), and the trailing "add full access control later" reads "add advanced access control later."

**Minor**: user-facing widget wording and option-count handling only. No spec shape, frontmatter contract, or reconciliation-annotation change.

## Unreleased: access-scope default now reads recorded per-module scope, not a permission sniff

2026-06-20. The access-control-scope question's **Recommended** option was defaulting wrong. The old detection treated the instance as "already uses access control" when any non-built-in permission or non-system role existed. But a *basic* deploy also creates `<slug>:read` / `<slug>:manage` permissions and viewer / manager roles, so the sniff could not distinguish basic from full and recommended **Full** on an instance whose other modules were all basic.

New detection: count the live modules whose `modules.settings.access_scope = full` (excluding the module being reconciled). Any row → default Full; none → default Basic. This reads the literal choice each prior deploy recorded, the authoritative per-module signal.

Paired with a modeler change: the modeler now persists `settings.access_scope` on **every** resolution path (not only the step-3 "ask" path), so the signal is populated for every module the pipeline deploys, including the hybrid path where frontmatter already carried the decision.

**Minor** (deferred to maintainer): detection-default change only. No spec shape, frontmatter contract, or reconciliation-annotation change; the `access_scope` frontmatter key and the question/options are unchanged.

## Unreleased: blueprint front-matter key renamed (`fact_sheet_version` → `blueprint_version`)

2026-06-15. The blueprint/spec front-matter version key `fact_sheet_version` was renamed to `blueprint_version` (value unchanged at `"3.0"`; `EXPECTED_BLUEPRINT_VERSION` stays `"3.0"`). The analyst now reads `blueprint_version` from the blueprint and carries it through to the spec front-matter. Coordinated with the architect, modeler, templates, and docs.

**No `CURRENT_VERSION` bump applied** (deferred to the maintainer). By this skill's own bump rule a frontmatter-key change is MAJOR; it was deferred, not skipped.

---

## `5.3` (MINOR) — fixed lifecycle state field name (`workflow_state`); retire `catalog_field_code`

`CURRENT_VERSION` bumps MINOR `5.2 → 5.3`; `EXPECTED_BLUEPRINT_VERSION` stays `"3.0"` and `fact_sheet_version` is unchanged (no blueprint shape change). Two coordinated changes, in lockstep with architect `5.2` and the modeler's parse/verify enforcement pass.

**The new convention.**

1. **The lifecycle state field is named exactly `workflow_state`.** Stage 4 emits, for every entity with a §7 lifecycle, a single required `enum` field named `workflow_state` (values = the §7 `state_name`s in order, default = the initial state) — never `status` / `state` / `lifecycle_state` / `lifecycle_stage`. A non-lifecycle enum that merely looks state-like keeps its domain name.
2. **Stage 3f drift table flips.** The field-name drift pairing now reads "spec uses `workflow_state`, a legacy live entity may have `status` / `state` / `lifecycle_state`", and the resolution for the lifecycle field is a rename/migration to `workflow_state` — Option 1 ("keep the live name") is not offered for it, because the modeler rejects any other name.
3. **`process_gates.state_column` is always `workflow_state`** (was: default `status`, settable per entity).
4. **Retire the `catalog_field_code` read.** The platform is dropping `fields.catalog_field_code`; the Stage 2 provenance index no longer reads it, and field-rename detection falls back to the Stage 3f name/format heuristics. Entity-rename detection via `catalog_entity_code` is unchanged.

**Major-vs-minor.** MINOR: no spec section renumbered, no required key removed, no `fact_sheet_version` change (`workflow_state` is a field name, not a new column). `version` major stays `5`; the modeler's `EXPECTED_MAJOR` stays `5`. The fixed state-field name is a new modeling convention authors follow, which the bump rules classify as MINOR.

---

## `5.2` (MINOR) — composed record labels: derive `label_parent`

`CURRENT_VERSION` bumps MINOR `5.1 → 5.2`; `EXPECTED_BLUEPRINT_VERSION` stays `"3.0"` and `fact_sheet_version` is unchanged (no blueprint shape change). The platform now derives a read-only, read-time `_label` on every entity (its composed label, folded from the parent chain), a `<fk>_label` companion on every reference/parent FK, and accepts an optional `label_parent` entity property naming the one FK that is a record's identity spine. The analyst learns to derive and validate `label_parent`.

**The new convention.**

1. **Derive `label_parent` at Stage 4.** For each owned entity, apply the canonical decision rule: `entity_type = junction` → none (legs auto-combine); self-identifying (intrinsic `label_column` — name / title / code / email) → none; otherwise the FK to the principal subject (the lone `parent` FK by default, else the architect-informed spine from the §5 relationship notes). A `reference` FK may be the spine (`job_applications.candidate_id`).
2. **Emit an optional `**Label parent:** `<fk>`` line in §3** (`semantic-spec-template.md`, after `**Entity type:**`), omitted when none. The deployer stamps it into `entities.label_parent`.
3. **Validate in Stage 9** that every `label_parent` names a real reference/parent FK on its entity, never targets a junction, never sits on a junction, and that the cross-entity `label_parent` graph is acyclic — each a 🔴 blocker.
4. **Reserved field names + N-ary junctions.** Field-naming guidance bans `_`-prefixed and `*_id_label` field names (platform-reserved for `_label` / `<fk>_label`). Junction guidance generalizes from two legs to **N** legs, with the association-class caveat: an N-ary link carrying its own attributes or a lifecycle is `operational_record` / `operational_workflow`, not `junction`.

**Major-vs-minor.** MINOR: the `**Label parent:**` line is a new optional per-entity sub-block — 5.1 specs still parse, and an older modeler that ignores the line just leaves `label_parent` null with no regression. No structural table changed, no frontmatter key removed, `fact_sheet_version` untouched.

**Companion changes.**

- `references/semantic-spec-template.md`: new optional `**Label parent:**` per-entity line after `**Entity type:**`; version comment bumped to `# currently "5.2"`.
- Modeler lands a lockstep delta (`EXPECTED_MAJOR` stays `5`) — parses the `**Label parent:**` line, stamps `label_parent` on `create_entity` / `update_entity`, extends the auto-generated skip list with `_label` / `<fk>_label`, guards field names against the reserved patterns, and verifies `label_parent` round-trips.
- Architect lands `5.1` (MINOR) in lockstep — N-ary junction clarification at all junction-classifier sites + an identity-spine note in §5 relationship guidance (prose only; no blueprint column added).

---

## `5.1` (MINOR) — provenance-in-platform: consume catalog provenance, carry it through

`CURRENT_VERSION` bumps MINOR `5.0 → 5.1`; `EXPECTED_BLUEPRINT_VERSION` bumps to `"3.0"` (major 3). The architect bumped `fact_sheet_version 2.2 → 3.0` (MAJOR) by inserting two §3 columns — `canonical code` (the canonical uber-model code) and `entity_type` (the closed 6-way class). The analyst consumes both and carries them through.

**The new convention.**

1. **Parse blueprint §3 by header NAME, not column position** (columns were inserted mid-table); capture `entity_type` + `canonical code` and carry both to the spec. Older 2.x blueprints route to Mode D Rebuild.
2. **Retire the Stage 2 sibling-file scan** — read authoring intent from the live catalog's provenance columns (`canonical_owner_module`, `catalog_entity_code` / `catalog_field_code`, `pattern_flags`, `catalog_entity_aliases`) instead; the workspace scan stays only as a pre-provenance fallback.
3. **Emit the provenance carriers in the spec** so the modeler can stamp them: per-entity `**Catalog entity code:**` and `**Entity type:**` lines, plus a `**Catalog alias:**` line on a reuse/merge reconciliation.

**Major-vs-minor.** MINOR: the spec additions are new optional per-entity lines (an older modeler ignores them — the columns stay at their empty defaults), so the spec major stays `5` and the modeler's `EXPECTED_MAJOR` stays `5`. Lands in lockstep with architect `5.0` (`fact_sheet_version 3.0`) and the modeler's stamping pass.

---

## `5.0` (MAJOR) — §2 Permissions summary retired; §8.1 / §9.1 canonical; keep-with-placeholder empty sections

`CURRENT_VERSION` bumps MAJOR `4.2 → 5.0`, with the modeler's `EXPECTED_MAJOR` bumping `4 → 5` and the architect landing `4.3` in lockstep. Two coordinated contract changes ship together so the pipeline bumps once, not twice.

**Change B (breaking — this skill's major) — §2 Permissions summary retired; §8.1 / §9.1 canonical.** The spec no longer carries the §2 Permissions summary table. The §8.1 Permissions catalog and the §9.1 Permission hierarchy — including the `<slug>:manage → <slug>:<narrow>` rollup row that previously lived only in §2 — are now the canonical permission surface. Removing a structural table is a breaking spec-structure change: specs emitted by ≤4.2 carry §2 and must be regenerated to deploy on the bumped modeler (`major != EXPECTED_MAJOR` rejects them at Stage 1). The analyst stamps `version: "5.0"`.

**Change A (non-breaking) — keep-with-placeholder empty-section convention.** Every canonical top-level / numbered spec section is now always present; an intentionally-empty section carries the canonical placeholder `_(none: <short reason>)_` (lowercase `none`, **colon not em-dash**; bare `_(none)_` allowed) rather than being omitted or carrying a legacy free-text string.

**The new convention.**

1. **New input tolerance.** The architect now keeps every canonical blueprint section (plus its §5.3 / §6 sub-blocks) with `_(none: …)_` when empty. A section whose only body is that placeholder is parsed as **"present, empty" (zero rows)** — identical to an absent section. Wherever the parse assumed "section absent = empty" it now equally treats "section present with `_(none: …)_` = empty" (detect via `^_\(none\b`). The placeholder is never mistaken for a data row and never carried into the spec as content. Old-form `_(no … )_` stubs are still stripped; the canonical `_(none: …)_` is NOT cruft.
2. **New emission rule.** Empty canonical spec sections (§4 Relationship summary, §5 Enumerations, §6 Cross-model link suggestions, §7.1 🔴 Decisions needed, §7.2 🟡 Future considerations) keep their heading and carry `_(none: <short reason>)_`. The retired legacy strings `None.` / `No enumerations defined.` / `No cross-model link suggestions.` are forbidden, as are omission and bare empty headings. The §7.1 deploy gate keys on unresolved 🔴 *items*, not on any literal string, so `_(none: …)_` is safe.
3. **§3 per-entity sub-blocks (Computed fields / Validation rules / Input type rules / Select rule) stay omit-when-empty** — they are per-entity field-level blocks, not numbered navigation anchors.

**Version-pairing.** `EXPECTED_BLUEPRINT_VERSION` is reconciled to the architect's stamped `"2.2"` (its major stays `2`, so the comparison — which is major-only — is unchanged; the literal now matches the architect's actual stamp, killing the `2.0` ↔ `2.1` ↔ `2.2` skew). The analyst's preflight blueprint check is restated as a major-only comparison so it no longer rejects the architect's own `2.2` output. Lands in lockstep with architect `4.3` and modeler `EXPECTED_MAJOR = 5`.

**Major-vs-minor.** MAJOR: a structural table (§2 Permissions summary) was removed — breaking, and the two skills must move in lockstep. Change A is non-breaking on its own (new tolerance + canonical placeholder emission) but ships in the same lockstep bump.

**Companion changes.**

- `references/semantic-spec-template.md`: §5 / §6 / §7 empty-section guidance unified to the canonical `_(none: <short reason>)_` placeholder; the version comment bumped to `# currently "5.0"`.
- Architect lands `4.3` (MINOR) in lockstep — keep-with-placeholder blueprint convention (`fact_sheet_version 2.1 → 2.2`) + the §9.1 `manage → narrow` rollup row.
- Modeler lands `EXPECTED_MAJOR = 5` (MAJOR) in lockstep — recognizes the canonical `_(none: …)_` form in its §6 read; rejects pre-`5.0` specs carrying §2 until regenerated.
