# Schema Mapping Reference

How to turn a `get_csvschema` result into a Semantius field plan: the introspection contract, the format mapping, the review rules (enums, reserved columns, FK candidates, label column), the empty-cell policy, and the change-classification rules for existing entities.

This file is the importer's rulebook. The mechanics of every CLI call it names (`create_field` payload shapes, nullability, `--single` reads) live in `use-semantius` and win on any conflict.

---

## 1. The csvschema contract

The `semantius` CLI ships a built-in local `utils` MCP server (no server connection, paths resolve relative to the current working directory):

```bash
semantius call utils/get_csvschema '{"path": "c:/data/products.csv"}'
semantius call utils/get_csvschema '{"path": "./products.csv", "maxRecords": 10000}'
```

| Input | Meaning |
|---|---|
| `path` | CSV file path, absolute or relative to cwd. Required. |
| `maxRecords` | Data records to inspect. `-1` (default) reads the whole file. The parser streams, so full-file inspection works on very large files; pass a positive number only when a quick partial scan is explicitly wanted. |

On success the tool returns `{outputPath, schema}` inline **and** writes the same `schema` JSON to `<file>.csvschema.json` next to the CSV. Keep the file; the import script reads it. On failure nothing is written and the result is an error envelope:

```json
{"error": {"code": "FILE_NOT_FOUND", "message": "...", "path": "..."}}
```

Codes: `FILE_NOT_FOUND`, `NOT_A_FILE`, `PERMISSION_DENIED`, `EMPTY_FILE`, `NO_HEADER_ROW`, `PARSE_ERROR`, `READ_ERROR`, `WRITE_ERROR`, `INVALID_ARGUMENT`, `INVALID_OPTION`, `UNKNOWN_ERROR`. Surface the message and stop; there is nothing to continue with.

### Output shape (CLI v0.8.3+)

`schema` is a wrapper object, not a bare array:

```json
{
  "id_mode": "id",
  "record_count": 110,
  "fields": [
    {
      "header": "List Price",
      "field_name": "list_price",
      "col_no": 4,
      "format": "number",
      "precision": 2,
      "required": true,
      "input_type": "required",
      "sample_values": [19.99, 24.5, 8]
    }
  ]
}
```

Top level:

| Property | Meaning |
|---|---|
| `id_mode` | How to reach a primary key: `"id"` (the file carries a usable integer `id` column), `"move"` (the first column is an integer `*id` column whose data should move into `id`), or `"none"`. Drives the id policy in section 4. |
| `id_move_column` | Raw header of the column to move into `id`. Present **only** when `id_mode` is `"move"`. |
| `record_count` | Data records actually inspected. Below the file's row count when `maxRecords` capped the scan. On a full scan this is the import's expected parsed-row count (section 9). |
| `fields` | One entry per column, in column order. |

Per field:

| Property | Meaning |
|---|---|
| `header` | The raw CSV header, verbatim. The import script keys rows by this. |
| `field_name` | Normalized snake_case suggestion, unique within the file: lowercase, non-alphanumerics collapsed to `_`, leading/trailing `_` trimmed; an empty header becomes `field_<col_no>`; collisions get numeric suffixes (`_2`, `_3`); names that would end in the reserved `_id_label` suffix are suffixed away from it. A **suggestion**: the skill still verifies it (sections 3 and 4) and the user can override. Note: a header like `2024 Revenue` yields the digit-leading `2024_revenue`, which is mechanically valid here but worth a rename in review (e.g. `revenue_2024`). |
| `col_no` | 1-based column position. |
| `format` | The Semantius-aligned field format. Currently observed values: `integer`, `number`, `date`, `date-time`, `email`, `url`, `string`, `boolean`, `enum`. The set is **open** — future CLI versions may add values, and the skill passes any format through (section 2 fallback rule), so an unknown value is never an error. |
| `precision` | Max decimal places seen; `0` for every non-numeric base format. |
| `required` | `true` = no empty cell was seen in any inspected row; `false` = at least one exists. A statement about the CSV with **no `create_field` counterpart** — never send it. |
| `input_type` | `"required"`, present **only** when `required` is `true`. The derived property that IS sendable to `create_field`; treated as a proposal the user can downgrade (section 6). |
| `enum_values` | Present only for `format: "enum"`: the distinct values, **always strings**. |
| `sample_values` | Present for every non-enum format: the distinct values seen, capped at 11. JSON numbers for numeric formats, verbatim strings otherwise (so `007` keeps its leading zeros). These are unique values, not the first N rows. |

### Detection quirks you cannot see in the output

These rules are baked into the introspector and are load-bearing for the review steps below. They are not inferable from any single file's output.

1. **Enum overrides at low cardinality.** Any column with 10 or fewer distinct non-empty values is reported `enum`, even when every value is an integer, a number, or a date. A numeric status code column, a 1-to-5 rating, or a small FK id column will arrive as `enum` with string `enum_values`. Section 3 exists because of this.
2. **Boolean detection is exact-pair.** `boolean` fires only when the column's distinct values are exactly one of these pairs (case-insensitive): `0|1`, `f|t`, `false|true`, `n|y`, `no|yes`. The raw pair is preserved in `sample_values`; the import script needs it for coercion.
3. **Identifier heuristic.** Numeric-looking columns with leading zeros (`007`) or a uniform fixed length (zip codes, SKU codes) are deliberately kept `string`. Never "upgrade" them to `integer`; the leading zeros are data. The verdict is authoritative: if you believe the column is genuinely numeric rather than an identifier, propose the change as a question to the user per the section 2 format-override rule — do not silently send `integer` (or any other override) into the mapping or `create_field`. This applies whether or not the sampled values carry leading zeros; a uniform-length id column is still an identifier by default.
4. **`date` vs `date-time`.** Values must be ISO (`YYYY-MM-DD` prefix). A column is `date` only when every value carries the identical time-of-day signature (plain dates, or all midnight); otherwise `date-time`.
5. **Semantic formats refine strings and beat enum.** `email` / `url` are detected by elimination (one invalid non-empty value disqualifies the column; empties only clear `required`). They only ever refine a would-be `string` column, and a detected semantic format **wins over the boolean/enum checks**: a column of five distinct addresses stays `email` with `sample_values`, never `enum` with `enum_values`. A bare `www.example.com` is not a `url` (no protocol); `mailto:` links are not urls (no host).
6. **`required: false` only means an empty was seen.** With `maxRecords` limited, a column can scan `required: true` while later rows contain empties. When in doubt, introspect the whole file (the default).
7. **Capped scans degrade everything — id detection included.** `id_mode` is computed from the *finalized* fields, resolved in order: `"id"` (some field is `integer` named exactly `id`) beats `"move"` (the **first** field is `integer` with a name ending in `id` — `customer_id`, `uid`); otherwise `"none"`. Because quirks 1 and 3 run first, a small scan can enum-ify or string-ify a real id column and silently suppress detection (verified: a 5-record scan of a file whose full scan yields `id_mode: "id"` reports `"none"` and all-enum fields). Full-file scans are the default for a reason.

Source of truth for this contract: `semantius-cli/src/local-tools/csv-schema.d.ts` (and the vendored `csv-schema.js` next to it). If output from a live run disagrees with this section, trust the live run and flag the drift.

---

## 2. Format mapping

The vocabulary is aligned, so most formats pass straight into `create_field`:

| csvschema `format` | Semantius `format` | Extras on `create_field` | Script coercion (section 7 for empties) |
|---|---|---|---|
| `integer` | `integer` | | parse as integer |
| `number` | `number` | `precision: <precision>` | parse as float |
| `date` | `date` | | pass ISO string through |
| `date-time` | `date-time` | | pass ISO string through |
| `boolean` | `boolean` | | map the detected raw pair to `true`/`false` |
| `string` | `string`, or `multiline` when the field name matches the multiline heuristic (`description`, `notes`, `body`, `comment`, `summary`, `details`, `rationale`) | | pass through |
| `enum` | reviewed first, see section 3 | `enum_values: [...]` when confirmed | pass through |

**Fallback rule: any `format` not in the table passes through verbatim.** The table documents the formats whose handling has nuances; it is guidance, never an allowlist. A format without a row (`email`, `url`, anything a future CLI version emits) is sent to `create_field` as-is (together with `precision`, `enum_values`, and `input_type` when present), passed through untouched by the import script's coercion, and gets the string-family empty-cell default (`""`) unless the platform's nullability rule marks it NULL-capable. A new format must never break or block the skill.

**The introspection verdict is gold — default to it, and never override it silently.** Every `format` (and `precision`, `enum_values`, `input_type`, and the boolean pair) in the csvschema output is a deliberate decision produced by the detection rules of section 1, not an accident. Pass it through to `create_field` unchanged unless there is a genuine, domain-level reason to change it. If you are confident the verdict is wrong for the data (e.g. a heuristic `string` id column that is really a numeric measurement, or an enum that is really an integer), that override is a **user decision, not a mapping edit**: raise it in the mapping review as an `AskUserQuestion` that states the introspected format, the proposed override, and the reason, and defaults to the introspected format. Silently changing a column's format in the mapping is editorializing the source's declared type — the exact mistake this rule exists to prevent. A mapping that differs from the csvschema verdict without a recorded user decision is a defect.

Additional `create_field` properties per column: `title` (Title Case of the field name unless the raw header is already a better human title), `width: "default"`, the util's `input_type` when present (section 6), and an explicit **`field_order` in increments of 10 starting at 30** (30, 40, 50, ... following the mapping's column order; 10 and 20 are already occupied by every entity's auto-created fields). The platform preserves explicit `field_order` values regardless of creation order, and the tens spacing leaves room to slot fields in later. Because order is explicit, the position of a field inside the create call carries no meaning, and field creation goes out as **one bulk `create_field` call** (an array of all the field objects) through the copied `create-fields.ts` runner (import-script-template.md) instead of one call per column.

Monetary columns (price, cost, amount, total): always `number` with `precision`, per `use-semantius` data-modeling rules.

**Never send `required` to `create_field`.** There is no such column; the platform models mandatoriness as `input_type: "required"` (which the util already derives, section 6) and computes nullability from `format`.

---

## 3. Enum review (mandatory for every `enum` column)

Because of quirk 1, treat every `enum` verdict as a claim to verify, not a fact. Re-derive the base type from `enum_values`:

| All `enum_values` are... | Verdict |
|---|---|
| a recognized boolean pair (quirk 2 list) | `boolean` |
| integer strings (`"1"`, `"42"`) | ambiguous: `integer` vs genuine enum. Decide by meaning: quantities and measurements are `integer`; codes and ratings can be either; ask the user when unclear |
| numeric strings with decimals | `number` (with `precision` re-derived from the values) |
| ISO dates / datetimes | `date` / `date-time` |
| a handful of short lowercase tokens (`draft`, `active`, `archived`) | genuine `enum`; keep `enum_values` as-is (sorted, deduped) |
| longer free text, names, or values that clearly continue beyond the sample | `string`; the low cardinality is an artifact of a small file |

Genuine enum extras: consider whether the CSV plausibly contains every lifecycle value. A 30-row export may miss states. When the user knows more values exist, add them to `enum_values` now; adding later is also possible via `update_field`.

Columns whose values look like ids of another table are FK candidates, not enums (section 5).

---

## 4. Field names and reserved columns

The util's `field_name` suggestions are mechanically valid. The skill still verifies two things per column:

**Semantic quality.** `qty` might be better as `quantity`; a header like `Cust.` deserves a human decision. Present the full mapping table and let the user rename anything before writes.

**Digit-leading names.** The normalizer can produce names like `2024_revenue` (from `2024 Revenue`). Mechanically valid, but propose a rename in the review (`revenue_2024`) — some downstream tooling rejects unquoted digit-leading identifiers.

**The primary-key policy (active this iteration).** Every entity has a primary key column named by its **`id_column`** property — platform default `id`, customizable per entity. The two target paths differ:

**New entity (create path)** — this is where `id_mode` applies: the wrapper tells you whether the file brings a usable primary key, and the (deferred) preservation design below is about exactly this case. Until it is re-enabled, **report** the detection ("this file carries a usable primary key; preservation lands in a later iteration") and apply the classic policy. Entities this skill creates keep the platform default `id_column` of `id`.

**Existing entity (reuse path)** — `id_mode` is **ignored**: the entity already has its primary key. Read the actual `id_column` from `read_entity` (never assume `id`) and apply the collision policy plus the payload guard.

| Column | Default resolution | Alternatives (one question for all collisions) |
|---|---|---|
| a CSV column whose field name equals the target's primary key column (`id` on a new entity, the live `id_column` on an existing one) | rename to `external_id`, offer it as the **unique natural key** (`unique_value: true`) for idempotent, updatable re-imports | skip the column |
| `id_move_column` (new entity, `id_mode: "move"`) | keep as its own `integer` field, offer as unique natural key | skip |

**Why deferred:** explicit-id imports leave the platform id sequence behind and the first platform-side insert collides (verified live). The full preservation design, the sequence rule, and the repairing RPC's SQL live in the README under "Deferred design"; it returns once the `fix_id_sequence` RPC is installed.

**Other reserved-name collisions.** `label`, the `<label_column>` field, `created_at`, and `updated_at` are auto-created; `_label` and `<fk>_label` are read-time projections. None may be targeted by `create_field`:

| Normalized field name | Default resolution | Alternatives (present all collisions in one question) |
|---|---|---|
| `created_at`, `updated_at` | skip (platform-owned timestamps; the platform sets its own) | rename to `source_created_at` / `source_updated_at` when the historical values matter |
| `label` | rename to `source_label` | skip; or choose it as the label column (section 6), which makes it the auto-created field |
| anything ending `_id_label` or starting `_` | already avoided by the util's normalizer; if a manual rename reintroduces it, reject the rename | |

**Manual renames to reserved names are rejected in the review loop**: the target entity's `id_column` (default `id`, read from the live entity — never assumed), `label`, `created_at`, `updated_at`, and the chosen label column are never valid `field_name` targets. As a second line of defense the import script **silently strips the entity's primary key column from every payload** (insert and PATCH) while id preservation is deferred — a mapping mistake cannot reintroduce explicit-id inserts and the sequence desync they cause (import-script-template.md design rule 2; the script reads `id_column` from mapping.json, filled from the live entity).

Record every decision in the mapping (section 8); renamed columns keep their raw `header` key so the script can still find them in the CSV.

---

## 5. FK candidates

A column is an FK candidate when its field name ends in `_id`, or matches an existing `table_name` (singular or plural) from a catalog sweep (`read_entity '{}'`), and its values look like identifiers of that table.

Offer `format: "reference"` + `reference_table` (with `reference_delete_mode: "restrict"` unless the user says otherwise) only when **both** hold:

1. The target entity exists in the live catalog.
2. The user confirms the CSV values are that table's actual `id` values.

Otherwise keep the column scalar (`integer` or `string` as introspected) and note in the mapping that it can be converted to a reference later. Looking up target ids from natural keys (e.g. the CSV holds category *names*, not ids) is out of scope for this skill's import script; flag it and keep the column scalar, or let the user pre-process the CSV.

`format: "parent"` (composition, cascade delete) is almost never right for an imported flat file; suggest it only when the user describes the relationship as ownership.

---

## 6. Label column and mandatoriness

**Label column.** Every new entity needs `label_column`. Ranking for the proposal:

1. A column named `name`, `title`, or `*_name` / `*_title`.
2. Otherwise the required `string` column with the highest uniqueness in `sample_values`.
3. Otherwise ask; any human-identifying string column works.

The user confirms (or picks another column) in the mapping review. Mechanics for a new entity:

- Pass the chosen field name as `label_column` on `create_entity`. The platform **auto-creates** that field (plus a computed `label` field reading from it).
- Therefore **exclude the label column from the `create_field` list** and **keep it in the import mapping**; the script writes to it like any other column.
- The auto-created label field's `title` defaults to `singular_label`. When the CSV column implies a more specific title ("License Plate", "Product Code"), follow up with `update_field` to set the title, per data-modeling.md "Customizing the `label` field's title". This is the rename path for the default label field; `singular_label` itself stays the bare symmetric noun.

**Mandatoriness.** The util already derives `input_type: "required"` (present only on columns with no empty cells). Treat it as the **proposal**: default to sending it through, but let the user downgrade any column to `"default"` in the review — a full-file scan can still be a lucky sample, and a later import of a sparser file would start failing. Columns without the property get `input_type: "default"`. Never send `required` itself.

---

## 7. Empty-cell policy

The platform computes nullability from `format`: only `reference`, `date`, and `date-time` columns accept NULL; every other format is NOT NULL with an auto-default. The import script must therefore send, for an empty CSV cell:

| Target format | Empty cell sends | Note |
|---|---|---|
| `date`, `date-time`, `reference` | `null` | |
| `string`, `multiline` | `""` | |
| `integer`, `number` | `0` | When the column has empties and zero would be a lie (a missing measurement is not a zero), surface it once during mapping review: keep `0`, keep the column as `string`, or drop the column |
| `boolean` | `false` | Same caveat as numbers when absence differs from "no" |
| `enum` | ask during review: add an explicit `"unknown"`-style value to `enum_values`, send `""`, or drop the column | |

**Uniform keys.** Every object in a batch POST carries **every** mapped key, with empties filled per this table, never omitted. PostgREST rejects heterogeneous arrays with the misleading `PGRST102 Empty or invalid json`.

---

## 8. The mapping artifact (`mapping.json`)

The review loop's output and the **single runtime input** for every script in the run folder: `render-plan.ts` renders the mapping table and plan facts from it, `create-fields.ts` creates fields from it, `import.ts` imports by it. One entry per CSV column plus the shared config — nothing about the run is stated anywhere else, so the rendered plan and what actually executes can never disagree.

```json
{
  "table": "products",
  "id_column": "id",
  "natural_key": "external_id",
  "on_exists": "update",
  "expected_records": 110,
  "batch_size": 250,
  "columns": [
    {
      "header": "id",
      "field_name": "external_id",
      "format": "integer",
      "title": "External ID",
      "field_order": 30,
      "unique_value": true,
      "empty_value": 0,
      "disposition": "create"
    },
    {
      "header": "Product Code",
      "field_name": "product_code",
      "format": "string",
      "title": "Product Code",
      "input_type": "required",
      "empty_value": "",
      "disposition": "label"
    },
    {
      "header": "Is Active",
      "field_name": "is_active",
      "format": "boolean",
      "title": "Is Active",
      "field_order": 40,
      "bool_pair": {"true": "Yes", "false": "No"},
      "empty_value": false,
      "disposition": "create"
    },
    {
      "header": "created_at",
      "field_name": null,
      "disposition": "skip",
      "reason": "platform-owned column"
    }
  ]
}
```

Top-level keys:

| Key | Meaning |
|---|---|
| `table` | Target `table_name`. |
| `id_column` | Copied from the target entity's live `id_column` property (`read_entity`; `id` for entities this skill just created). The import script's payload guard keys on it. |
| `natural_key` | Optional. Names the **field** (not header) that identifies a row across re-imports. |
| `on_exists` | Meaningful only with a natural key: `"insert"` skips rows whose key already exists; `"update"` synchronizes them — unchanged rows untouched, changed rows updated, new rows inserted. Update mode requires the key field to be unique (`unique_value: true`); with a non-unique key only `"insert"` is available and the skill says so. |
| `expected_records` | The introspection wrapper's `record_count` on a full scan; `null` when the scan was capped. The import verifies `parsed` against it (section 9). |
| `batch_size` | Optional insert batch size (default 250, sane range 200–500). |

Per column:

| Key | Meaning |
|---|---|
| `header` | Always the raw CSV header — the import script keys rows by it, so renamed columns keep their raw `header`. |
| `field_name` | The Semantius field name (payload key); `null` on skipped columns. |
| `disposition` | `"create"` (needs `create_field`) / `"exists"` (targets a live field) / `"label"` (the label column: auto-created by `create_entity`, imported, never `create_field`) / `"skip"` (not imported; the entry stays in the file with a `reason`, so a re-run shows the same picture). |
| `format` | The format the import coerces into: the csvschema verdict, or the **live** field's format when the diff chose coerce-into-live (section 9). |
| `empty_value` | The section 7 resolution, sent for empty cells. |
| `bool_pair` | On `boolean` columns: the raw values (original casing) that map to `true`/`false`. |
| `title`, `field_order`, `precision`, `enum_values`, `input_type`, `unique_value`, `searchable`, `default_value`, `reference_table`, `reference_delete_mode` | The full `create_field` payload data, carried per column so `create-fields.ts` can build the exact call (`field_order` in increments of 10 starting at 30 per section 2). Required on `create` columns; harmless elsewhere. |

---

## 9. Existing entities: field diff and change classification

When the target entity already exists, diff the approved mapping against the live fields (`read_field '{"filters": "table_name=eq.<table>"}'`). Never target live fields with `input_type` `readonly` or `disabled`, and never the `_label` / `<fk>_label` projections.

Four diff buckets:

| Bucket | Meaning | Import impact |
|---|---|---|
| **Matched** | Name matches, format identical or script-coercible into the live format | import targets it |
| **Missing live** | CSV column has no live field | needs `create_field`, or the column is dropped |
| **Mismatched** | Name matches, format differs | classified below |
| **Extra live** | Live field with no CSV column | fine when nullable or auto-defaulted; a live `input_type: "required"` field absent from the CSV is a **blocker** (constant value, drop requirement, or abort) |

**The user is always shown the classified change report before anything is written.** Every needed change is labeled possible or impossible:

### Possible (executable on request)

| Change | Mechanism |
|---|---|
| Add a field | `create_field` |
| Make a field required / optional | `update_field` with `input_type: "required"` / `"default"` |
| Change `precision` on a `number` field | `update_field` |
| Add values to `enum_values` | `update_field` (extend, never silently remove values that live rows may use) |
| Format change within the same Postgres primitive | `update_field`, e.g. `string` ↔ `multiline` ↔ `html` ↔ `code` (all text) |
| Retitle a field, adjust `field_order` / `width` | `update_field` |

`update_field` is keyed by the composite id: `{"id": "<table>.<field>", "data": {...}}`, and the payload carries **only** the changing keys.

### Impossible (never attempt; offer the alternatives)

| Change | Why | Alternatives |
|---|---|---|
| Format change across Postgres primitives (`string` → `date`, `integer` → `string`, `number` → `boolean`, ...) | The platform rejects it; existing data cannot be retyped in place | coerce in the import script into the **live** format when lossless (e.g. CSV `integer` into live `string`); drop the column; or abort and let the user remodel |
| Removing `enum_values` in use | Would orphan existing rows | leave the value; treat the CSV's smaller set as a subset |
| Touching auto-generated fields (`id`, `label`, `<label_column>` structure, `created_at`, `updated_at`) | Platform-owned | section 4 renames on the CSV side instead |

Coercion direction matters: a CSV `integer` column imports losslessly into a live `string` field; a CSV `string` column does **not** import into a live `integer` field unless every value parses. When the user picks coerce-in-script, the script validates per row and routes failures to the failed-rows capture rather than aborting the batch.

In compare-only mode this classified report is the deliverable: render it and stop, zero writes.

When a natural key and `on_exists: "update"` are in play, the report also states how existing rows will be treated: matched-and-identical rows are left untouched, matched-but-differing rows are updated with the CSV's values, and rows only in the CSV are inserted.

**Row-count expectation.** On a full scan, the wrapper's `record_count` is the number of data records the import should parse; the verification stage checks `parsed === record_count` and treats a mismatch as a parsing defect to surface (delimiter trouble, embedded newlines), not as noise.
