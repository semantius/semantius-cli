# Importer Essentials (distilled from use-semantius)

The Step 0 hard-gate read for `semantius-importer`: everything the import workflow needs from `use-semantius`, condensed. This file is a distillation, not the authority — **`../use-semantius/` wins on any conflict**. Consult the full references on demand:

| Situation | Read |
|---|---|
| FK modeling depth (reference vs parent semantics, junctions, delete modes) | `../use-semantius/references/data-modeling.md` |
| RBAC beyond the module's two standard permissions | `../use-semantius/references/rbac.md` |
| Schema-evolution risk classes, renames, deletions | `../use-semantius/references/data-modeling.md` → Safe Evolution Patterns |
| PostgREST syntax beyond this file | `../use-semantius/references/crud-tools.md` |
| Exotic CLI forms, chaining, daemon/env tuning | `../use-semantius/references/cli-usage.md` |

---

## 1. CLI call forms

```bash
semantius call crud <tool> '{...}'   # inline JSON
... | semantius call crud <tool>     # stdin (no JSON argument = read stdin)
semantius info crud <tool>           # live JSON schema for any tool
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
- **Never read a new row's id off its own create response.** Re-read by natural key after the create.

## 3. Catalog writes, in mandatory order

`read_*` before every `create_*` — if the read finds it, reuse it. Order: **Module → Permissions (one call) → wire module → Entity → Fields (one call).** **Batching rule:** every typed `create_*` takes `data` as one object **or an array** (items may have different keys; one request, one transaction, all-or-nothing); `update_*` / `delete_*` take an `id` array with the same `data` for all. Whenever more than one record of the same kind is pending — both baseline permissions, every new field of the entity — send them in ONE call. A loop of single-record calls is a mistake, not a style choice.

### Module (when the import needs a new one)

```bash
semantius call crud create_module '{"data": {"module_name": "CRM", "module_slug": "crm", "description": "Customer Relationship Management"}}'
semantius call crud create_permission '{"data": [{"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>}, {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>}]}'
semantius call crud update_module '{"id": <module_id>, "data": {"view_permission": "crm:read", "manage_permission_id": <id of crm:manage>}}'
```

- `module_slug`: required, `^[a-z0-9_-]+$`. Permission names are always `<module_slug>:<action>` (slug, never display name).
- Wiring types differ: `view_permission` is the permission **name** (text); `manage_permission_id` is the permission **id** (number). Skipping the `update_module` wiring leaves the module on the `user:read` default.
- `description` is a ≤40-char tagline.

### Entity

```bash
semantius call crud create_entity '{"data": {"table_name": "products", "singular_label": "Product", "plural_label": "Products", "description": "...", "label_column": "product_name", "module_id": 3, "view_permission": "catalog:read", "edit_permission": "catalog:manage"}}'
```

- `table_name` is **plural snake_case**. `module_id` is required and non-null. `singular_label`/`plural_label` are grammatically symmetric bare nouns ("Product"/"Products", never "Product Name").
- **Auto-created on `create_entity`** — never `create_field` these: `id`, `label`, the `<label_column>` field, `created_at`, `updated_at`. `_label` and `<fk>_label` are read-time projections (absent from the fields catalog, never writable, never import targets). The computed `label` is likewise **not a PostgREST column**: `select=label` fails with `42703` (verified live) — to verify labels, select the `<label_column>` field instead.
- The auto-created label field's `title` defaults to `singular_label`; when the CSV implies a better one ("Product Code"), follow up with `update_field` on that field's `title`.
- **Never create or import into `users`** or other platform built-ins.

### Fields

All of an entity's new fields go into **one** `create_field` call — `data` is an array (the copied `create-fields.ts` runner builds and sends it; items may carry different keys, e.g. `precision` on one and `enum_values` on another):

```bash
semantius call crud create_field '{"data": [
  {"table_name": "products", "field_name": "price", "title": "Price", "format": "number", "precision": 2, "width": "default", "input_type": "default", "field_order": 30},
  {"table_name": "products", "field_name": "status", "title": "Status", "format": "enum", "enum_values": ["active", "discontinued"], "width": "default", "input_type": "default", "field_order": 40}
]}'
```

Properties the importer uses:

| Property | Notes |
|---|---|
| `table_name`, `field_name` | Required. `field_name` must not start with `_` or end with `_id_label` (platform-reserved; rejected). |
| `title` | Human label. |
| `format` | Open vocabulary; the importer passes the csvschema verdict through (`string`, `multiline`, `integer`, `number`, `date`, `date-time`, `boolean`, `enum`, `email`, `url`, ...). `enum` requires `enum_values` (never `select`). Monetary values: `number` + `precision`. |
| `precision` | `number` only; digits after the decimal (default 2). |
| `input_type` | `default`, `required` (mandatory in UI), `readonly`, `disabled`, `hidden`. **There is no `required` column and no `is_nullable`** — sending either fails. Never target live `readonly`/`disabled` fields with an import. |
| `field_order` | Display order; the platform preserves explicit values regardless of creation order. Start at 30 and use increments of 10 (30, 40, 50, ...) to leave insertion room — 10 and 20 are already used by the auto-created fields in every entity. |
| `width` | `"default"` unless a layout need exists. |
| `unique_value` | `true` enforces DB-level uniqueness (natural keys for update-mode imports). On an existing field it fails when live duplicates exist. |
| `searchable` | `true` adds the field to full-text search. |
| `default_value` | Only when the platform auto-default is wrong (e.g. a required enum whose starting value is not `enum_values[0]`). |
| `reference_table` (+ `reference_delete_mode`) | **Mandates `format: "reference"` or `"parent"`** — never combine `reference_table` with a scalar format. Delete modes: `restrict`, `clear`, `cascade`. |

**Nullability is computed from `format`**: only `reference`, `date`, `date-time` accept NULL; every other format is NOT NULL with an auto-default (`''`, `0`, `false`, first enum value). This drives the empty-cell policy in schema-mapping.md section 7.

## 4. Updates

```bash
semantius call crud update_field  '{"id": "<table>.<field>", "data": {"title": "New Title"}}'   # composite id; data carries ONLY the changing keys
semantius call crud update_entity '{"table_name": "products", "data": {"description": "..."}}'  # keyed by table_name, not numeric id
```

`format` changes only within the same Postgres primitive (`string` ↔ `multiline` ↔ `html` ↔ `code`); cross-primitive changes are rejected (schema-mapping.md section 9 classifies these).

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
