# semantius-importer

Imports a CSV file into Semantius: introspect the file's schema with the CLI's built-in `utils/get_csvschema`, create or reuse a matching entity (module first if needed), then bulk-load the rows in batches. `SKILL.md` is the runtime contract; this README summarizes what the skill does.

## What it does

- **Introspection** against the csvschema contract: wrapper output (`id_mode`, `record_count`, `fields`), derived `input_type`, open format set with passthrough for formats the skill does not special-case (`email`, `url`, `color`, `icon`, and any other value); `rating` cells are parsed and range-checked.
- **Three run modes**: full import, schema-only (create the entity, import nothing), compare-only (classified diff report, zero writes).
- **Entity + module creation** with correct label-column mechanics, plus a field-by-field diff against existing entities with every needed change classified **possible** (executed on request) or **impossible** (alternatives offered).
- **Target-entity selection**: when no table matches, candidates are ranked by name similarity and field overlap and the user chooses create-new vs use-existing.
- **Batched import**: streaming `csv-parse`, uniform-key batches via stdin-piped `postgrestRequest`, retries, per-row coercion validation, `failed-batches.json`, count verification against the server and against the introspection's `record_count`. The script ships as a real file (`references/import.template.ts`) copied byte-for-byte into the run folder; it reads all run configuration from `mapping.json` at startup — no hand transcription, no per-run placeholders.
- **Deterministic plan rendering**: `references/render-plan.ts` prints the mapping table and every plan count straight from `mapping.json`, so the reviewed table, the pre-write plan, and what executes always agree.
- **Bulk field creation**: `references/create-fields.ts` creates all new fields in **one `create_field` call** (`data` is an array of the field objects, up to 100 per call; the typed tool takes items with different keys and inserts them in one transaction) in the mapping's column order and without `field_order` (the platform appends new fields in array order, so the CSV order is the display order; a column carries `field_order` only when the user pins its position). Idempotent (skips existing fields; a re-run issues zero calls), verified by re-read, fail-fast, and loud: per-field status and the platform's stderr in a result table, nothing swallowed.
- **Insert-only with an optional unique key**: when the file carries an identifying column, the user is asked (in plain words) whether to **mark that field unique**; if yes, `unique_value: true` goes on the field, `mapping.json` records it as `natural_key`, and re-running the import skips rows whose value already exists. Without a unique key every run inserts every row. Existing rows are never modified: there is no "update existing rows" option, and `render-plan.ts` and `import.ts` refuse a mapping whose `on_exists` is anything but `"insert"`.
- **The platform assigns the primary key**: an id-named column of the file is kept as `external_id` (offered to be marked unique), and an `id_move_column` stays an ordinary integer field. The import script strips the entity's primary key column (`mapping.json`'s `id_column`, copied from the target entity's live `id_column`) from every payload, so no mapping mistake can send an explicit id.

## Layout

```
SKILL.md                              runtime contract (stages, gates, decision points)
references/importer-essentials.md     Step 0 hard-gate read: distilled use-semantius subset
references/schema-mapping.md          csvschema contract + mapping/decision rules + mapping.json contract
references/import-script-template.md  run workspace, design rules, mapping.json checklist
references/import.template.ts         the import script (copied byte-for-byte as import.ts)
references/create-fields.ts           bulk create_field runner (one array call per ≤100 fields, fail-fast, --dry-run)
references/render-plan.ts             renders the mapping table + plan facts from mapping.json
CHANGELOG.md                          history (not loaded at runtime)
```
