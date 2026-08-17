# semantius-optimizer — changelog

This file records the history of the optimizer's reverse-extraction contract: the live-to-spec mapping rules implemented in `references/spec-extract-lib.ts`. The current `SPEC_VERSION` constant and the compatibility rules a maintainer must follow when bumping it live in [SKILL.md](./SKILL.md) under "Schema compatibility". The body of SKILL.md is the current contract; this file is the history of how the extractor's coverage evolved.

This file is NOT loaded into Claude's context when the skill triggers. Maintainers read it when planning a change; users read it when investigating why an extracted spec is shaped the way it is. Runtime behavior never depends on this file.

Entries below are newest first. `SPEC_VERSION` tracks the analyst's `CURRENT_VERSION` in lockstep; an entry that adds a reader within the existing shape does not bump it.

---

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
