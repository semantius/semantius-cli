# semantius-optimizer — changelog

This file records the history of the optimizer's reverse-extraction contract: the live-to-spec mapping rules implemented in `references/spec-extract-lib.ts`. The current `SPEC_VERSION` constant and the compatibility rules a maintainer must follow when bumping it live in [SKILL.md](./SKILL.md) under "Schema compatibility". The body of SKILL.md is the current contract; this file is the history of how the extractor's coverage evolved.

This file is NOT loaded into Claude's context when the skill triggers. Maintainers read it when planning a change; users read it when investigating why an extracted spec is shaped the way it is. Runtime behavior never depends on this file.

Entries below are newest first. `SPEC_VERSION` tracks the analyst's `CURRENT_VERSION` in lockstep; an entry that adds a reader within the existing shape does not bump it.

---

## Description under the 1024-character limit (`SPEC_VERSION` unchanged)

2026-09-28. The description was 1156 characters; the read list and mechanism detail were condensed, every trigger phrase and exclusion kept. Now 995.

## 5.8: entity families and enum labels

2026-09-28. `SPEC_VERSION` 5.7 → 5.8 in lockstep with the analyst. The platform added `is_a` / `has_a` key types (`entities.id_refentity`) and `{"value", "label"}` enum entries; the extractor now reads both back.

1. **Families.** A based entity (`id_type` `is_a` / `has_a`) emits `**Key type:**`, `**Key prefix:**` for `is_a` (prefix now also for `is_a`, not only `typeid`), and `` **Based on:** `<id_refentity>` ``; it emits no `**Label column:**` / `**Label parent:**` / `**Order column:**` (the platform sets them from the base). Its Relationships prose starts with the canonical family sentence, and §2 gets a dotted edge (`<entity> -.->|is a kind of| <base>` / `-.->|extends|`) after the relationship edges, matching `consistency-check.ts --emit-mermaid`.
2. **Cross-module related entities.** Related-table discovery also follows `id_refentity`, and a related non-built-in entity owned by another module now renders as a `reuse-from <module>.<table>` block (like a built-in: no Fields table) instead of an empty create-new block. §9.1 keeps a cross-module hierarchy row only when it is a family edit grant (this module's permission including the base's `edit_permission`).
3. **Enum labels.** Notes `enum_values:` list values only; §5 emits `` - `value` - Label `` for a pair and `` - `value` `` otherwise.
4. **Round-trip:** new `fixture-family.json` / `expected-family.md`; the basic and full goldens changed only in the `version` line.
5. **Fix: live extraction lost its slug.** The argument filter dropped `argv[0]` whenever `--from-fixture` was absent (`fixtureIdx + 1` is `0`), so `spec-extract-lib.ts <slug> [outfile]` read the outfile as the slug (or failed with the usage message). Found by extracting a live family module on the tests instance; the fixture path was unaffected, which is why the round-trip stayed green.

## 5.7: `SPEC_VERSION` follows the analyst (class-99 rule codes)

2026-09-26. `SPEC_VERSION` 5.6 → 5.7 in lockstep with the analyst. Validation rules are emitted verbatim from live state, so live rules already carry the class-99 `code` plus the `name` identifier; the extractor needs no mapping change. `fixture-full.json` now carries a class-99 rule (`"code": "99001", "name": "retire_needs_permission"`) and both goldens were regenerated (the version line, plus that rule entry).

---

## Platform: name-keyed permissions (reader only; `SPEC_VERSION` unchanged)

2026-09-26. The platform keys `permissions` by `permission_name` (no numeric id), `permission_hierarchy` rows link `including_permission_name` to `included_permission_name`, and the module record references `manage_permission` / `admin_permission` by name. `spec-extract-lib.ts` now indexes permissions by name, computes the `included in :admin?` closure over names, filters the module's hierarchy edges by name, and reads the baseline role grants from the module's name references. The emitted spec is byte-identical (both round-trip goldens unchanged); the fixtures `fixture-basic.json` / `fixture-full.json` were converted to the live shape.

---

## 5.6: extractor emits the entity key type

`SPEC_VERSION` `5.5` → `5.6` (2026-09-26), in lockstep with the analyst. `entityDetail()` emits `**Key type:** <id_type>` right after `**Id column:**` when live `id_type` is not the default `auto_increment`, and `**Key prefix:** <id_prefix>` after it when the type is `typeid`: bare values, no backticks, the same omit-when-default rule as `**Edit mode:**`. Both read off the `entities` row already loaded; no new CLI reads. Built-in blocks emit neither (as with the other entity lines).

Round-trip eval: `fixture-full.json` gains `id_type` / `id_prefix` on its entities (`assets` `typeid` / `asset`, `vendors` `uuid`, `asset_vendors` default) and `fixture-basic.json` the defaults; goldens regenerated (version stamp, plus the three new lines in `expected-full.md`). `bun evals/round-trip/check.ts` is green.

Files: `references/spec-extract-lib.ts`, SKILL.md (version), `evals/round-trip/{README.md,fixture-basic.json,fixture-full.json,expected-basic.md,expected-full.md}`.

## Unreleased: routing exclusion for semantius-transfer

Description only, `SPEC_VERSION` unchanged (2026-09-26). "Export" and "snapshot" in the trigger list also match moving a module with its records between hosts, or backing it up as a restorable file, which this skill cannot do (it writes a markdown spec, no records). The description now routes those to the new `semantius-transfer` skill.

## 5.5: byte-alignment with the pure-skeleton template; modeler-accepted tiers; offline round-trip eval

`SPEC_VERSION` `5.4` → `5.5` (2026-08-19), in lockstep with the analyst. The analyst template is now a pure skeleton (see the analyst CHANGELOG); this entry makes the extractor agree with it literal-for-literal and fixes four emitter defects that produced specs the analyst or modeler rejected.

1. **`**Label column:**`** is omitted when live `label_column` is null/empty (both the owned and the built-in block) instead of emitting `` `null` `` — a junction without a local label is valid.
2. **§8.1 `tier`** is always a modeler-accepted value: `narrow` when the suffix is an owned entity's `edit_permission` suffix; `override` for `view_all_*` / `manage_all_*` (tested before the rule test, since overrides are wired into `select_rule` via `has_permission`); `workflow-gate (rule)` when the code occurs in an owned entity's `validation_rules` / `select_rule` JSON; else `workflow-gate (lifecycle)`. A bare `workflow-gate` (a modeler 🛑) is no longer emitted. **`included in :admin?`** is derived from the live hierarchy (`✓` iff `<slug>:admin` transitively includes the permission; `-` for the `baseline-admin` row; `✓` everywhere when no admin permission exists).
3. **§9.1 reconciliation cells** are `♻ exists` (U+267B, no VS16) — the reverse pass reads live state, so every role / hierarchy edge exists by construction. The `### 9.1` key is `module_slug` uppercased (template `{{SYSTEM_SLUG_UPPER}}`), not `domain_code`.
4. **`access_scope`-aware placeholders.** §8.2, §9.2 and the empty Processes line keep the "access_scope is basic" reason under `basic` and say "not extracted from live state by semantius-optimizer; author by hand" otherwise (previously the basic text was hardcoded for `full` modules too). The RACI surface (`**RACI mode:**` / `**RACI realization:**` / RACI plan) is never emitted, not even as a placeholder: `consistency-check.ts` keys its `raci_mode` provenance gate on the `**RACI realization:**` literal.
5. **`**Processes:**`** caption is bare (the template's parenthetical was authoring commentary). **§6** carries `### Outbound handoffs` / `### Inbound handoffs` placeholders after the link-table placeholder (template v5.5; the platform exposes no handoff registry to read back). **Mermaid** emits `classDef builtin` only when a built-in takes part in an edge and `classDef master` only for a non-builtin `reuse-from` / `promote-to-master` entity in an edge (the architect checker's criterion); previously `classDef builtin` was unconditional.
6. **`--from-fixture <json>`** renders from a JSON snapshot of the live reads (`main()` split into `loadLive()` → `render()`; `read()` and the read order are untouched). **`evals/round-trip/check.ts`** (fixtures `basic` + `full`, committed goldens, `--update`) diffs the render against the goldens, runs `consistency-check.ts` on it, and lints the analyst template's skeleton against the extractor (zero em-dashes; every skeleton heading / emitted table header appears in the source; `NOT_EMITTED_BY_OPTIMIZER` lists the §6 / §8.2 / RACI / §9.2 tables it never emits). SKILL.md "Verifying the extractor" points here; the stale `master-it-ops-starter` anchor is gone. Category A/B in SKILL.md corrected (§8.2, §9.2 and the RACI surface are Category B). Stale template line-number references in the source replaced by section anchors.

Files: `references/spec-extract-lib.ts`, SKILL.md, `evals/round-trip/{check.ts,README.md,fixture-basic.json,fixture-full.json,expected-basic.md,expected-full.md}`.

## Unreleased: extractor emits the deploy-provenance keys (`deployed_version` / `deployed_version_date` / `deployed_related_versions`)

2026-07-05. `frontmatter()` now emits the deploy-provenance keys from live state: `deployed_version` = the module's `modules.version`, `deployed_version_date` = `modules.version_date`, and `deployed_related_versions` = a `slug: version` map of every other module this spec reuses an entity from (computed in `main()` from the reference-target entities' owning modules). Unlike the authoring-only `reconciled_*` / `source_blueprint` keys the extractor drops, these are live truth, so a reverse-engineered spec carries them and is trivially in-sync (the analyst's 2a.1 drift gate reads `deployed_version == live.version` until prod next changes). Guarded on `mod.version` presence, so an older platform (no `version` column) omits all three. Pairs with the modeler's Stage 5b stamp and the analyst's 2a.1 gate. No `SPEC_VERSION` bump (additive optional keys within the v5.4 shape); validated with `bun build`.

## 5.4: extractor now emits the v5.4 constructs — entity identity-spine / UI / icon lines, the `width` + `searchable` Notes markers, the `logo_color` / `home_page` frontmatter keys, §9.1 role lineage columns, and the §9 Processes catalog

2026-07-05. MINOR bump: `SPEC_VERSION` "5.3"→"5.4" (matches the analyst's `CURRENT_VERSION`; the modeler's `EXPECTED_MAJOR` stays `5` — this is not a major change). The analyst template and modeler parser were extended for the same v5.4 constructs against the shared canonical syntax doc; this entry is the optimizer's (primary emitter) half. Every new construct obeys the universal omit-when-default rule — it is emitted ONLY when the live value is non-empty AND not the platform default (defaults determined from `semantius info crud create_*`), so an authored and a reverse-engineered spec stay byte-identical. No section-numbering or table-shape change beyond the two additive §9.1 columns.

1. **`entityDetail()` now emits five v5.4 §3 entity lines** at the canonical pinned positions (canonical syntax §1):
   - **`**Order column:** `<order_column>`** — backticked `field_name`, right after `**Label column:**`; omitted when empty/null.
   - **`**Id column:** `<id_column>`** — backticked `field_name`, after `**Order column:**`; omitted when the platform default `id` (or empty). Every live entity reads back `id_column = "id"` unless overridden.
   - **`**Edit mode:** <edit_mode>`** — bare enum value, no backticks, right after `**Edit permission:**`; omitted at the platform default `auto` (verified via `create_entity` schema + all 44 live rows read back `auto`).
   - **`**Cube mode:** <cube_mode>`** — bare enum value, no backticks; omitted at the platform default `auto` (the live DB default; note the modeler's `stage-1-parse.md:108` prose says `disabled`, but the live column default and every live row is `auto`, which is what round-trips).
   - **`**Icon URL:** <icon_url>`** — plain URL value, NO backticks; omitted when empty/null.
   All five read straight off the `entities` row already loaded (`order_column`, `id_column`, `edit_mode`, `cube_mode`, `icon_url`); no new CLI reads.

2. **`mapNotes()` now round-trips two more §3 Notes markers** in the canonical deterministic order (canonical syntax §2):
   - **`width: <value>`** — bare value like `precision:`, in its canonical slot after `parent label`; omitted at the platform default `default` (verified via `create_field` schema + live rows: `default`/`s`/`m`/`w`).
   - **`` `searchable` ``** — backticked bare marker like `` `unique` ``, kept adjacent to `` `unique` ``; emitted ONLY when live `searchable` is true. Both read off the field row already loaded; no new CLI reads.

3. **`frontmatter()` now emits two v5.4 module presentation keys** after `naming_mode:` (before `entities:`), each only when non-empty: **`logo_color: <hex>`** and **`home_page: <path>`**. These are top-level `modules` columns (NOT under `settings`), read off the already-loaded module row.

4. **`governance()` §9.1 baseline-roles table gains two lineage columns.** New header `| role | baseline grant | origin | catalog role code | reconciliation |` (`origin` + `catalog role code` inserted before the final `reconciliation`); each role row emits live `roles.origin` / `roles.catalog_role_code`. Display-only / derived (the deployer re-derives both from module_type/slug), so the round-trip is a functional no-op; the modeler parses §9.1 by header name and ignores them as inputs.

5. **`governance()` now reads and emits the §9 Processes catalog** (previously a hardcoded empty placeholder). No typed `read_process` CRUD tool exists, so the processes are read via the generic `postgrestRequest` GET `/processes?module_id=eq.<id>&order=ordering.asc` — the same table + filter the modeler writes in living-RACI mode (`../semantius-modeler/references/stage-4-execute.md:389`). New `emitProcesses()` helper renders the analyst template's exact catalog shape (`../semantius-analyst/references/semantic-spec-template.md:311-315`): the `**Processes:**` caption line, then a `| process_key | name | description | ordering |` table sorted by `ordering` then `process_key`. When there are no processes the `_(none: ...)_` placeholder is kept. A read failure is non-fatal: the block stays as the placeholder and a `⚠ FLAG` is written to stderr.

**Minor / major unchanged.** Additive emit coverage plus two additive §9.1 columns; the modeler's `EXPECTED_MAJOR` is untouched. A module previously carrying any of these values regenerates with them on the next extract.

## Unreleased: extractor now emits the four §3 behavior blocks and the cube_type / parent-label / default_value annotations it previously dropped

2026-07-05. A three-skill audit confirmed the reverse extractor had NO readers for four §3 entity/field behavior blocks and several §3 Notes annotations, so snapshotting a live module into a spec and redeploying silently stripped data-integrity / RLS / dynamic-UI logic and dropped authored annotations. The analyst template (`../semantius-analyst/references/semantic-spec-template.md`) already defined the exact byte-format for each; the extractor simply never read them. Closes that silent round-trip loss. All changes are new readers within the existing spec shape; `SPEC_VERSION` stays `5.3`.

1. **`entityDetail()` now emits the four §3 behavior blocks** for every non-builtin entity (the `BUILTINS` branch still returns early with its minimal block), after the Fields table and the Relationships prose, each emitted only when its live value is non-empty, in the template's order (`semantic-spec-template.md:141-192`):
   - **Computed fields** from `entities.computed_fields` (JSON array). Template `:141-153`.
   - **Validation rules** from `entities.validation_rules` (JSON array). Template `:155-168`.
   - **Input type rules** assembled from each field's `input_type_rule` (per-field JsonLogic object) into an array of `{ "field", "jsonlogic" }` entries in field order. Template `:170-184`.
   - **Select rule** from `entities.select_rule` (a single JSON object, not an array). Template `:186-192`.
   All four render with the template's fence style: `**Heading**`, a blank line, a ```json fence, the 2-space pretty-printed JSON (`JSON.stringify(value, null, 2)`), the closing fence, and a trailing blank line. New helpers `emitJsonBlock`, `inputTypeRules`, and `isNonEmpty` centralize the omit-when-empty rule (`null` / `[]` / `{}` are all treated as empty). No new CLI reads: `computed_fields` / `validation_rules` / `select_rule` are already loaded on the entity, and `input_type_rule` is already loaded on each field.

2. **`mapNotes()` now round-trips three previously-dropped §3 Notes annotations** (template `:131`, `:135`), in a fixed deterministic append order after the existing ref / precision annotations (`… , precision, cube_type, parent label, default`):
   - **`cube_type`** — emitted as a bare value (no quotes, e.g. `cube_type: dimension`) when `fields.cube_type` is present and not the platform default `"auto"`.
   - **parent label** — emitted as `parent label: "<singular_label_parent>" / "<plural_label_parent>"` (double-quoted, matching the template) when a parent FK carries either label override.
   - **`default_value` completeness** — a `number`-format field with a `default_value` now emits `default: "<v>"` alongside its `precision`, and a reference / FK field with a `default_value` emits it too. Enum keeps its default inline inside its `enum_values` annotation (unchanged); excluding only `enum` from the unified `default:` emit closes the number / ref gaps without double-emitting. Since these annotations never round-tripped before, this establishes their canonical order.

**Minor / no bump.** No frontmatter key, table-shape, or section-numbering change; `SPEC_VERSION` stays `5.3` and the modeler's `EXPECTED_MAJOR` is untouched. Purely additive read coverage so a reverse-engineered spec stops dropping authored behavior blocks and annotations. A module previously snapshotted with any of these present regenerates with them on the next extract. Byte-format note: the JSON blocks depend on the analyst side using the same 2-space `JSON.stringify` indentation, and the annotation append order above must stay consistent with the analyst's Notes-column authoring for an authored and a reverse-engineered spec to stay byte-identical.
