# Importer Essentials (distilled from use-semantius)

The Step 0 hard-gate read for `semantius-importer`: everything the import workflow needs from `use-semantius`, condensed. This file is a distillation, not the authority — **`../../use-semantius/` wins on any conflict**. Consult the full references on demand:

| Situation | Read |
|---|---|
| FK modeling depth (reference vs parent semantics, junctions, delete modes) | `../../use-semantius/references/data-modeling.md` |
| Permissions and roles beyond what `module-rbac-setup.ts` creates | `../../use-semantius/references/rbac.md` |
| Schema-evolution risk classes, renames, deletions | `../../use-semantius/references/data-modeling.md` → Safe Evolution Patterns |
| PostgREST syntax beyond this file | `../../use-semantius/references/crud-tools.md` |
| Exotic CLI forms, chaining, daemon/env tuning | `../../use-semantius/references/cli-usage.md` |

---

## 1. CLI call forms

```bash
semantius call crud <tool> '{...}'   # inline JSON
... | semantius call crud <tool>     # stdin (no JSON argument = read stdin)
semantius tools crud <tool>          # live JSON schema, only for a tool these files do not cover
```

- **Prefer stdin for any payload carrying free text** (titles, descriptions, enum values, CSV-derived strings): piping bypasses shell quoting entirely. The Bun pattern is `Bun.spawn([...], {stdin: "pipe"})`, write JSON, close.
- **Windows/PowerShell: never invoke a no-argument `semantius call ...` bare.** With no JSON argument the CLI reads stdin until EOF; a persistent PowerShell session never closes it and the call hangs forever (not a network problem — do not retry). Pass `'{}'` explicitly or pipe: `"" | semantius call crud getCurrentUser`.

**Exit codes** (branch on these, never parse stderr for control flow):

| Code | Meaning | Reaction |
|---|---|---|
| 0 | Success | — |
| 1 | Bad args/JSON, **or** `--single` found zero rows | zero-rows is a normal branch on `--single` reads |
| 2 | `--single` found 2+ rows | ambiguity — surface it |
| 3 | Transport failure, CLI retries already exhausted | retry once or twice with backoff, then surface |
| 4 | Tool execution failed (RLS, duplicate key, schema/validation) | surface stderr verbatim |
| 5 | Auth failure (401/403, bad key) | abort immediately, never retry |

## 2. Response shapes

Every `crud` tool returns a JSON **array** by default — including `create_*`/`update_*` (`[{...}]`, not a bare object; a bulk call returns every affected row). Exit 0 with body `[]` means "found nothing", which is success at the protocol layer and not-found at the domain layer — always inspect the body.

- **`--single`**: for reads that must resolve to exactly one row (unique-key lookups). Returns a bare object; exit 1 = none, 2 = ambiguous. **Rejected (exit 1, `SINGLE_ARRAY_INPUT`) when `data` / `body` / `id` / `table_name` is an array** — bulk calls always answer with an array.
- **Never read a new row's id off its own create response.** Re-read by its identifying field (`table_name`, `field_name`, ...) after the create.

## 3. Catalog writes, in mandatory order

`read_*` before every `create_*` — if the read finds it, reuse it. Order: **`module-rbac-setup.ts` (a new module only) → Entity → Fields (one call).** **Batching rule:** every typed `create_*` takes `data` as one object **or an array** (items may have different keys; one request, one transaction, all-or-nothing); `update_*` / `delete_*` take an `id` array with the same `data` for all. Whenever more than one record of the same kind is pending — every new field of the entity — send them in ONE call. A loop of single-record calls is a mistake, not a style choice.

### Module (when the import needs a new one)

Never with `create_*` calls. `SKILL.md` → Stage 4 runs `module-rbac-setup.ts` after the gate, the same command an explicit build uses: it creates the module with its icon, color, permissions, hierarchy, roles, grants and default roles. Take `module_id` from the first line of its output. `--description` is a ≤60-char tagline.

### Entity

`<run-folder>/entity.json`:

```json
{"data": {"table_name": "products", "singular_label": "Product", "plural_label": "Products", "description": "...", "icon_name": "package", "label_column": "product_name", "module_id": 3, "entity_type": "operational_record", "view_permission": "catalog:read", "edit_permission": "catalog:manage"}}
```

```bash
bun "<skill-folder>/../use-semantius/references/call-file.ts" create_entity <run-folder>/entity.json
```

- `icon_name` comes from the finder call in `SKILL.md` → Stage 4, and is left out when no icon fits.
- `entity_type`, `view_permission` and `edit_permission` come from the entity's class and write tier; the rules are in `use-semantius` (`data-modeling.md` → "Classifying an entity", `rbac.md` → "Choosing an entity's permissions"). Never leave the class at `unclassified`.

- `table_name` is **plural snake_case**. `module_id` is required and non-null. `singular_label`/`plural_label` are grammatically symmetric bare nouns ("Product"/"Products", never "Product Name").
- **Auto-created on `create_entity`** — never `create_field` these: `id`, `label`, the `<label_column>` field, `created_at`, `updated_at`. `_label` and `<fk>_label` are read-time projections (absent from the fields catalog, never writable, never import targets). The computed `label` is likewise **not a PostgREST column**: `select=label` fails with `42703` (verified live) — to verify labels, select the `<label_column>` field instead.
- `create_entity` titles the auto-created label field: the label column in words without the entity's singular at its start (`product_name` → "Name"; a column ending in `_number`, `_no`, `_id` or `_code` keeps it: "Product Code"). When the CSV implies a better title, pass it as `label_column_label` in the `create_entity` payload; no `update_field` follows (use-semantius `data-modeling.md` → "Customizing the label field's title").
- **Never create or import into `users`** or other platform built-ins.

### Fields

All of an entity's new fields go into **one** `create_field` call — `data` is an array (the copied `create-fields.ts` runner builds and sends it; items may carry different keys, e.g. `precision` on one and `enum_values` on another). The payload it sends looks like this:

```json
{"data": [
  {"table_name": "products", "field_name": "price", "title": "Price", "format": "number", "precision": 2, "width": "default", "input_type": "default"},
  {"table_name": "products", "field_name": "status", "title": "Status", "format": "enum", "enum_values": ["active", "discontinued"], "width": "default", "input_type": "default"}
]}
```

Properties the importer uses:

| Property | Notes |
|---|---|
| `table_name`, `field_name` | Required. `field_name` must not start with `_` or end with `_id_label` (platform-reserved; rejected). |
| `title` | Human label. |
| `format` | Open vocabulary; the importer passes the csvschema verdict through (`string`, `multiline`, `integer`, `number`, `date`, `date-time`, `boolean`, `enum`, `email`, `url`, ...; also `rating`, `color`, `icon`, see data-modeling.md). `enum` requires `enum_values` (never `select`). Monetary values: `number` + `precision`. |
| `precision` | `number` only; digits after the decimal (default 2). |
| `input_type` | `default`, `required` (mandatory, enforced by the platform), `readonly`, `disabled`, `hidden`. **There is no `required` column and no `is_nullable`** — sending either fails. Never target live `readonly`/`disabled` fields with an import. |
| `field_order` | Display order. **Omit it**: the platform appends each new field after the entity's existing ones in array order, so the CSV column order becomes the display order. Set it only when the user asks for a specific position, after reading the entity's live `field_order` values: the auto-created fields already hold positions (the label field sits at 20), and a tie renders in an unpredictable order without any error. Choose a value strictly between the two live neighbors the field should sit between (e.g. 25 between 20 and 30), or above the highest value below 900000 to put it last. The automatic numbering ignores values from 900000 up (`created_at` and `updated_at` sit at 999998 and 999999); keep every other field below 900000. |
| `width` | `"default"` unless a layout need exists. |
| `unique_value` | `true` enforces DB-level uniqueness (the "mark this field unique" answer; the import then skips rows whose value already exists). On an existing field it fails when live duplicates exist. |
| `searchable` | `true` adds the field to full-text search. |
| `default_value` | Always on a required enum (its automatic default is `''`, which a required enum refuses), and when the zero value is wrong. Always a value, never a label. |
| `reference_table` (+ `reference_delete_mode`) | **Mandates `format: "reference"` or `"parent"`** — never combine `reference_table` with a scalar format. Delete modes: `restrict`, `clear`, `cascade`. |

**Nullability is computed from `format`**: only `reference`, `date`, `date-time` accept NULL; every other format is NOT NULL with a zero-value default when `default_value` is blank (`''`, `0`, `false`, `[]` for `array`, `{}` for other JSON; `0` for `rating` means not rated; an `enum` defaults to `''`, which a required enum refuses; `uuid`, `time`, `duration` and `binary` have no zero value). This drives the empty-cell policy in schema-mapping.md section 7.

## 4. Updates

```bash
semantius call crud update_field  '{"id": "<table>.<field>", "data": {"title": "New Title"}}'   # composite id; data carries ONLY the changing keys
semantius call crud update_entity '{"table_name": "products", "data": {"description": "..."}}'  # keyed by table_name, not numeric id
```

`format` changes only within the same PostgreSQL type (the format → type table in data-modeling.md, e.g. `string` ↔ `multiline` ↔ `html` ↔ `code`); cross-primitive changes are rejected (schema-mapping.md section 9 classifies these).

## 5. postgrestRequest (business rows)

| Parameter | Notes |
|---|---|
| `method` | `GET`, `POST`, `PATCH`, `DELETE` |
| `path` | `/<table>` + PostgREST query string (`?status=eq.active&order=id&limit=1000&offset=0`) |
| `body` | The record payload — the key is **`body`, never `data`** |

- **Bulk insert = array body where every object carries the same keys.** Heterogeneous arrays are rejected with the misleading `PGRST102 Empty or invalid json` (a column-discovery constraint, not an encoding problem). Fill absent values explicitly per the empty-cell policy. (Adding `?columns=a,b` to the path lifts the same-keys rule but makes omitted keys NULL — no `missing=default` on this raw path — so the importer keeps uniform rows. Only the typed catalog tools accept ragged arrays.)
- Row count: `GET /<table>?select=count` returns `[{"count": N}]`.
- Update one row: `PATCH /<table>?<key>=eq.<value>` with the changed fields as `body`.
- Do not send a `prefer` key: the tool has no such input (`Prefer: return=representation` is fixed), so batched upsert is unavailable — see the README roadmap.
- Filter operators: `eq`, `neq`, `gt/gte/lt/lte`, `like`/`ilike`, `in.(a,b)`, `is.null`. Combine with `&` (a top-level comma is not AND — it silently matches nothing).

## 6. Deep links

Read `ui_baseurl` (and `semantius_org`) from `getCurrentUser` — never derive it from `api_baseurl` or hardcode the host. List: `{ui_baseurl}/{module_slug}/{table_name}`; record: append `/{id}`. Paths use the lowercase `module_slug`, never the display name.
