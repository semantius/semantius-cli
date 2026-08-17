# semantius-analyst — changelog

This file records the history of the analyst skill's `CURRENT_VERSION` (and its paired `EXPECTED_BLUEPRINT_VERSION`) and the content-contract changes each version introduced. The current constants and the rules a maintainer must follow when bumping them live in [SKILL.md](./SKILL.md) under "Skill version". The body of SKILL.md is the **current contract**; this file is the **history of how the contract evolved**.

This file is NOT loaded into Claude's context when the skill triggers. Maintainers read it when planning a bump; users read it when investigating why an older-major spec is shaped the way it is. Runtime behavior never depends on this file.

Entries below are newest first. Each entry follows the maintainer template: what changed, why, the new convention as a numbered list, and the major-vs-minor justification. (Pre-`5.0` analyst history lived alongside the architect's CHANGELOG and in git history; this file starts at the `5.0` lockstep bump.)

---

## Unreleased: 2a.1 version-match drift gate + deploy-provenance frontmatter carry-forward

2026-07-05. Closes the owned-entity drift gap: previously the analyst reconciled a spec against its **blueprint** (Reconcile / Rebuild) and deep-inspected only **adopted** entities against live (2h), so prod-side drift on the spec's own OWNED entities surfaced only at modeler-deploy time (a late halt). Two additions, both keyed on a platform-maintained `modules.version` (monotonic integer, bumped on any owned-schema change):

1. **`deployed_version` / `deployed_version_date` / `deployed_related_versions` front-matter (v5.4+)** — written by the MODELER at the end of a clean deploy (its new Stage 5b), NOT by the analyst. Registered in `semantic-spec-template.md` and `stage-11-write.md` (frontmatter block + note 11): the analyst carries them forward **verbatim**, never computes them; absent until first deploy.
2. **Stage 2a.1 version-match gate** — when the module already exists and the spec carries `deployed_version`: `live.version == deployed_version` → no prod drift, skip the owned-entity inspection (O(1) common case); mismatch → deep-inspect owned entities via the 2h machinery and resolve through Stage 3f before editing; absent key or old platform → fall back to full inspection. Also compares `deployed_related_versions` for reused-entity drift.

3. **Drift detection made property-exhaustive.** The 2h index previously captured only 6 field properties, and Stage 3f only resolved field-name / enum / permission-tier / format — so `description`, `default_value`, `precision`/`scale`, `title`, `unique_value`, `reference_delete_mode`, `view_permission`, the v5.4 UI columns, and every JsonLogic block (`select_rule` / `computed_fields` / `validation_rules` / `input_type_rule`) drifted silently. 2h now captures the COMPLETE entity- and field-level property set; new **Stage 3f.6** (generic per-property drift, risk-graded: cosmetic batch review / value-change widget / destructive 🔴 blocker) and **Stage 3f.7** (rule-block drift, per-rule keep-live vs keep-spec) are the catch-alls. The existing Stage 11 "adopted-entity drift resolution complete" gate now enforces completeness across the full set.

Additive / behavioral; optional frontmatter keys omitted until deploy, so 5.3/earlier specs are unaffected. No spec-shape break, no forced major bump.

## Unreleased: 5.4, eleven optional round-trip constructs (entity lines, field markers, frontmatter keys, role-lineage columns)

2026-07-05. `CURRENT_VERSION` bumps MINOR `5.3 -> 5.4`; `EXPECTED_BLUEPRINT_VERSION` stays `"3.0"`. Coordinated with `semantius-optimizer` (`SPEC_VERSION` `5.3 -> 5.4`, the primary emitter) and `semantius-modeler` (whose `EXPECTED_MAJOR` stays `5`, but which now parses and writes the new constructs). These are display / round-trip carriers the optimizer reverse-engineers from a live module; the analyst DOCUMENTS them as optional so authored specs may carry them and Audit / Extend / Rebuild tolerate them. Every construct is OPTIONAL with an omit-when-default rule (emit only when the live value is non-empty AND not the platform default), so a hand-authored spec normally omits all of them and reads identically to a 5.3 spec.

The new optional constructs:

1. **Five §3 entity property lines**, at pinned positions in the entity block: `**Order column:** `<field>`` (after `**Label column:**`; omit when empty), `**Id column:** `<field>`` (omit when `id` or empty), `**Edit mode:** <value>` (after `**Edit permission:**`; bare enum, omit when the default `auto`), `**Cube mode:** <value>` (bare enum, omit when default), and `**Icon URL:** <url>` (before `**Catalog entity code:**`; plain value, no backticks, omit when empty). Each maps to the like-named `entities.*` column the deployer stamps.
2. **Two §3 field Notes markers**: `width: <s|m|w>` (bare value like `precision:`; omit when the default `default`) and `` `searchable` `` (backticked bare marker like `` `unique` ``; emit only when live `searchable` is true). Added to the field-table annotation list and the Notes-formatting note, with a fixed deterministic marker order so authored and reverse-engineered specs stay byte-identical.
3. **Two frontmatter keys** after `naming_mode:`: `logo_color: <hex>` (the modeler honors a provided value and random-fills only when the key is ABSENT) and `home_page: <path>`. Both emit only when set; omit the key otherwise.
4. **Two §9.1 baseline-roles table columns**: the header becomes `| role | baseline grant | origin | catalog role code | reconciliation |` (the two columns inserted before the final `reconciliation`). `origin` / `catalog role code` are OPTIONAL, derived, and display-only, the deployer re-derives both from module type / slug, so they are a round-trip no-op and safe to leave blank / omit in hand-authored specs; present in reverse-engineered ones. The modeler parses the table BY HEADER NAME (not column position) and ignores them as inputs.

Also noted for the pipeline (no analyst change): the optimizer gains a Processes reader; the analyst template already represents the §9 Processes catalog and the modeler already writes it in living-RACI mode.

Files touched: `references/semantic-spec-template.md` (all eleven constructs added as optional, plus the version comment `-> "5.4"`); `SKILL.md` (`CURRENT_VERSION -> "5.4"`, the two prose mentions, and the pre-save `version is "5.4"` check); `references/stage-4-fields.md` (the two field markers + marker order); `references/stage-11-write.md` (the five entity lines as a new item 10, the two frontmatter keys, and the frontmatter-example `version: "5.4"`); `references/stage-9-governance.md` (the two role-lineage columns as display-only); `references/modes-audit-extend-rebuild.md` (the three `version: "5.4"` stamps / checks).

**Major-vs-minor.** MINOR: additive optional lines / markers / keys only. No section is renumbered, no frontmatter key is removed, no existing table column is removed (only two trailing columns are added to §9.1 before its final column), and the reconciliation-annotation set is unchanged. A 5.3 spec still parses on the bumped modeler; an older modeler that ignores the new lines / markers / keys leaves the corresponding columns at their platform defaults with no regression. `version` major stays `5` and the modeler's `EXPECTED_MAJOR` stays `5`. A previously-shipped spec regenerates with any live-non-default constructs present on next optimizer emit.

## Unreleased: §4 Kind vs fk_format rule, outbound-only rows, and A/An article agreement

2026-07-04. A live `it-ops-starter` run produced a §4 Relationship summary the `semantius-optimizer` reverse pass disagreed with on two points, plus a grammar slip in §3 prose. The modeler still deployed correctly (it keys entities by `table_name` and reads FK shape from §3, never from §4's descriptive columns), so the drift was cosmetic-but-wrong — a spec that fails a round-trip against the deterministic extractor. Three template gaps, now closed:

1. **`Kind` had valid values but no application rule.** The §4 template listed `reference | parent | junction` for `Kind` but never said when each applies, so the analyst copied `fk_format` (`parent`) into `Kind` on the junction legs. New rule in the template §4 (and cross-referenced from `stage-4-fields.md` "Junction-table FKs"): `Kind` is the relationship class — `junction` for **every** FK leg of a `junction` entity, otherwise equal to `fk_format` — while `fk_format` stays the physical field format. A junction leg reads `Kind = junction`, `fk_format = parent` (the two columns differ). This matches `semantius-optimizer`'s `relationshipSummary()` (`Kind = entity_type === "junction" ? "junction" : format`).
2. **No rule said §4 is outbound-only.** The analyst emitted a phantom half-empty row for an *inbound* reference (`saas_applications` ← `saas_subscriptions.saas_application_id`) with `—` cells. New rule: exactly one row per outbound `reference`/`parent` field on the `From` entity; never a row for an inbound reference (it already appears under the FK-owning entity), never `—`/blank cells or a `To` that is not a declared entity. The em-dash and reference-resolution gates already reject such a row — the template now tells the analyst not to author it in the first place.
3. **§3 prose hard-coded the article `A`.** The canonical relationship forms began with a literal `A `, so vowel-initial identifiers read ungrammatically (`A `asset_contracts` record`). The template now specifies the indefinite article agrees with the following `table_name`'s initial letter (`An `asset_contracts` …`, `A `saas_subscriptions` …`), matching `semantius-optimizer`'s `/^[aeiou]/i` article computation.

**Minor**: no frontmatter, table-shape, or section-numbering change; `Kind = junction` was already a documented template value. Pure authoring-guidance clarification so forward-authored specs round-trip against the optimizer. `CURRENT_VERSION` stays `5.3`. A previously-shipped spec regenerates with the corrected §4 and article on next write.

## Unreleased: canonical entity order + unnumbered/alphabetical §5 Enumerations

2026-07-04. Two ordering conventions had no formal rule, so a forward-authored spec and a `semantius-optimizer` reverse-engineered one drifted purely on sequence (the `it-ops-starter` round-trip differed on entity order across §2/§3/§4/§5 and on §5 sub-heading numbering, though every value matched). Both sides now sort by the same key, computable identically from the spec and from live state.

1. **Entity order is canonical, not authoring/discovery order.** Sequence entities by `entity_type` tier, then `table_name` A->Z within each tier: (1) `catalog`, (2) `operational_record` / `operational_workflow` / `computed` / `unclassified`, (3) `junction`, then (4) reuse-from built-ins (`users`, …) last. Applies to the `entities:` frontmatter list, §2, §3, §4, and §5. Stated in the spec template's §2 "Entity order (canonical)" note and applied at `references/stage-11-write.md` "Order §3 entities canonically" before §2 is generated. `semantius-optimizer` implements the identical sort (replacing its old `created_at.asc`), and `semantius-architect` adopts it for the blueprint in lockstep.
2. **§5 Enumerations sub-headings are unnumbered and alphabetical.** The sub-heading drops the `5.N` number (now just `` ### `table.field` ``), and the enum blocks are sorted alphabetically by `table.field`. The member values inside each block keep their defined lifecycle/semantic order (never alphabetized). Template §5 updated; `semantius-optimizer`'s `enumerations()` matches.

**Minor**: no frontmatter key, table-shape, or top-level section-number change (§5 stays §5; only its sub-heading loses a number). `CURRENT_VERSION` stays `5.3` and the modeler's `EXPECTED_MAJOR` is untouched (the modeler reads enum values from §3 `Notes`, never §5, and keys entities by `table_name`, not order or §-number). **Version bump deferred to the maintainer** per this file's convention. A previously-shipped spec regenerates with the canonical order and unnumbered §5 on next write.

## Unreleased: M:N verb survives junction decomposition (no longer dropped from §3/§2)

2026-07-03. A live run on `it-ops-starter` decomposed the blueprint M:N edge `asset_contracts covers saas_applications` into the `asset_contract_saas_applications` junction but lost the verb entirely: the spec's §2 drew two bare arrows (`asset_contracts --> asset_contract_saas_applications`) and §3 carried no `relationship_label` on either junction leg. The blueprint said *covers*; the spec said nothing. Root cause was a contradiction in the contract — stage-4 said "set `relationship_label` for every FK field … §2 edge label and this annotation must agree byte-for-byte," while the §2 emitter (`consistency-check.ts:emitSpecMermaid`) and the template's junction convention said `parent`/junction legs are ALWAYS bare "even when §3 declares a relationship_label." The emitter's `row.kind === "parent" ? null` guard won, so the verb was unconditionally discarded.

1. **Stage 4 now preserves the M:N verb on decomposition.** When a junction materializes an `A <verb> B` M:N edge, stamp `relationship_label: "<verb>"` on the junction leg pointing back to the blueprint §5 **source** entity (`asset_contract_id → asset_contracts` carries `"covers"`); the non-source leg stays bare (its inverse verb is not declared anywhere). See `references/stage-4-fields.md` "Preserve the M:N verb."
2. **The §2 emitter renders a leg's `relationship_label` uniformly**, regardless of Kind — the `parent`-forces-null guard is removed. A leg with a declared verb draws `A -->|verb| junction`; a leg without one stays bare. This resolves the byte-for-byte contradiction with stage-4 and matches the template's updated junction convention (`semantic-spec-template.md`).
3. **The mandatory consistency gate now enforces it**: a spec whose §3 declares a junction-leg verb but whose §2 draws the edge bare fails `mermaid ⟺ §3/§4 (derived)` with "regenerate §2 from §3/§4." The verb can no longer be silently lost.

**Minor**: no spec artifact-shape, frontmatter, or section-numbering change — `CURRENT_VERSION` stays `5.3`. Richer content (a `relationship_label` on junction legs, a verb on the §2 source-leg edge) within the existing shape. A previously-shipped spec that dropped an M:N verb will regenerate with the verb present on next write.

## Unreleased: §2 mermaid diagram is generated, never hand-authored; consistency gate now validates diagram direction/verb

2026-07-03. Two independent live runs of the analyst on the identical `it-ops-starter` blueprint produced spec files whose §3 `relationship_label` and §4 `Cardinality` were byte-identical, but whose §2 mermaid diagrams disagreed with each other — one run drew arrows parent→child with the declared verb, the other drew them reversed with a different verb that didn't even match its own §3 declaration. `consistency-check.ts`'s spec-side checks never validated mermaid edges against §3/§4 at all (only that endpoints resolved to known entities), so neither run's inconsistency was caught before the spec was written.

1. **Stage 11 now mandates generating §2 instead of composing it by hand.** Write §3 and §4 first (already fully resolved by that point in reconciliation), then run `bun ".claude/skills/semantius-architect/references/consistency-check.ts" --emit-mermaid "semantius/specs/<slug>-semantic-spec.md"` and paste its output as §2 verbatim. Re-run it whenever §3/§4 change afterward instead of hand-patching §2. See `references/stage-11-write.md` "Generate §2, never hand-author it."
2. **The mandatory consistency gate now actually checks diagram correctness, not just completeness.** `consistency-check.ts` regenerates the canonical §2 from §3/§4 and diffs it edge-for-edge against what's in the file; a mismatched direction or verb is a hard failure (`SKILL.md` "Verification gates" row updated to describe this, not just node/edge presence).
3. **`modes-audit-extend-rebuild.md`'s relationship-integrity check upgraded from a 🟡 eyeball item to a 🔴 mechanically-enforced one**, since it's no longer something a reviewer has to manually notice.

**Minor**: no spec artifact-shape, frontmatter, or section-numbering change — `CURRENT_VERSION` stays `5.3`. Purely a tooling + authoring-workflow fix. A previously-shipped spec whose diagram had drifted from its own §3/§4 will newly fail the gate on next write; that's the fix working, not a regression to accommodate.

## Unreleased: §3 flag removal, frontmatter simplification, `canonical_`→`catalog_` rename, row-scope playbook now analyst-owned

2026-06-27. Downstream half of the platform-schema contract change (architect + use-semantius landed the upstream half; the modeler moves in lockstep). The architect's new blueprint shape removed the §3 `pattern flags` column, renamed §3 `canonical code` → `catalog code`, dropped `system_description` and added `icon_name` to frontmatter, and dropped the `has_*` §8.2 source flags. The analyst absorbs the row-scope / lock / approval authoring those flags used to hint. No version bump — `CURRENT_VERSION` stays `5.3`, `EXPECTED_BLUEPRINT_VERSION` stays `"3.0"` (the architect still stamps `"3.0"`; the prior analyst version was never released, so this folds into `5.3`).

What changed:

1. **Blueprint parse (Stage 1) matches the architect's new shape.** Frontmatter: `system_description` gone, `icon_name` added, `tagline` is now the ≤40-char selector chip (→ `modules.description`). §3 columns: `catalog code` (was `canonical code`, parsed into `catalog_code`), no `pattern flags` column. §8.2 `source flag` vocabulary is `lifecycle` / `owner_edit` / `narrow_write` — the `has_single_approver` named-gate handling is gone.
2. **Catalog provenance reads renamed.** The Stage 2c provenance index and Stage 3 placement read `catalog_owner_module` (was `canonical_owner_module`) and no longer carry `pattern_flags`. Concept rename `canonical_`→`catalog_` across the catalog-owner / re-prefix machinery (incl. the `**Catalog owner:**` spec line label the modeler parses, and `re-prefixed-from <catalog-module>.<verb>`). The authoritative English sense of "canonical" (canonical copy / source / placeholder / empty-section) is unchanged.
3. **Row-scope / locks / approvals are now fully analyst-owned (the substantive change).** A **row-scope playbook** in Stage 7 (S1): per entity with an owner FK, choose **private** (a `select_rule` on the owner column, no override permissions) vs **owner + oversight** (`or(owner==$user_id, has_permission(<slug>:view_all_X))` + the `view_all_` / `manage_all_` `override`-tier permissions rolled up under `:admin`). Encodes the **REPLACE-semantics trap**: a `select_rule` with no `has_permission` disjunct locks admins out. Submit-then-lock / terminal-lock stay Stage 10 `validation_rules` (F6 / F9, unchanged). An approval is a §7 gated transition + §8.1 `workflow-gate` + §9 RACI Accountable — no flag, no §8.2 `has_single_approver` rule.
4. **Dead flag scaffolding removed.** The pre-save `personal_content` and `has_single_approver` coherence checks, the §3-confirm "pattern-flag translation" table (reframed as a behavior-phrasing vocabulary), the `override (personal_content)` / `override (submit_lock)` §8.1 tiers (now plain `override`), and the living-RACI structural-flag mapping (now keyed off the analyst's own Stage 5 / 7 / 10 decisions).
5. **Frontmatter / spec template.** Dropped `system_description`; `tagline` carries the selector-chip text; added `icon_name`. `access_scope` detection reads the top-level `modules.access_scope` column (was `settings->>access_scope`). The Stage 2 `create_module` plan and the module schema note carry `icon_name` / `domain_code` / `access_scope`.

**Minor** (folds into `5.3`): no spec major-shape break an existing released spec would fail on (the prior version was unreleased). The analyst + modeler land together and are coordinated with the platform-schema go-live.

## Unreleased: SKILL.md restructured into a resident spine + per-stage references

2026-06-25. The analyst SKILL.md had grown to 1760 lines (roughly 70k tokens loaded into context on every trigger). Restructured it into a ~400-line resident orchestration spine plus 16 per-stage `references/*.md` files loaded on demand, mirroring the modeler's structure. The writing conventions (near-identically duplicated across all four skills) were extracted to a shared [`../semantius-admin/references/writing-conventions.md`](../semantius-admin/references/writing-conventions.md).

1. **Stays resident** (loaded every run): frontmatter, the three-skill workflow intro, a writing-conventions summary (with the Pre-emit check and Narration restraint kept verbatim), the version constants, the tool-ban list, Step 0/1, the access-control resolution order plus the "What basic authors" contract, the MUST-FIRE widget rule, a new stage-index table plus execution-order note, and the Stage 8 + Stage 11 pre-save verification gates.
2. **Moved to references** (loaded on demand): every per-stage authoring detail (parse, inspect, the Stage 3 placement / collision / confirm / drift widgets, field elicitation, the workflow / input-type / select-rule scans, governance, the write mechanics, and Modes B/C/D).
3. **Verified behavior-preserving.** Every non-separator content line survives in the spine or a reference; all 40 relative links resolve; the six relative links inside moved blocks were re-pathed for their new depth; the four dangling "(See Access-control scope above)" notes now point at the resident contract; the close-out, duplicated between the resident Closing message and the Stage 11 reference, was collapsed to a pointer. Also corrected a pre-existing dangling Step 0 reference (`references/cli-usage.md` to `../use-semantius/references/cli-usage.md`).
4. **Pre-move version-drift fix.** Reconciled four stale version literals (the Stage 11 pre-save check, the Mode C major-assert, and the Mode C/D stamps) from `"5.0"` / `"5.2"` to `"5.3"`, matching the `CURRENT_VERSION` stamp.

**No `CURRENT_VERSION` bump.** This changes SKILL.md's internal organization only: no spec-artifact shape, frontmatter-key, section-numbering, or reconciliation-annotation change, so the analyst/modeler version contract is untouched and the modeler's `EXPECTED_MAJOR` stays put. **Minor** (organizational); deferred to the maintainer like the entries below.

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
