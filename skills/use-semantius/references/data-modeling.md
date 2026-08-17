# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius, the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

This file covers the schema mechanics: modules, entities, fields, relationships, and safe evolution. Two sibling references cover the rule layers: `jsonlogic.md` (`computed_fields`, `validation_rules`, extension operators, cross-entity lookups, dynamic `input_type_rule`) and `select-rule.md` (row-level read security via `select_rule`).

---

## Mandatory Creation Order

**Always follow this sequence, never skip steps:**

```
Module → Permissions (one call) → (update_module to wire permission refs) → ALL Entities (one call) → Fields (one call per entity)
```

**Batch every step that writes more than one record of a kind** (Golden Rule 7): both baseline permissions in one `create_permission`, every entity of the model in one `create_entity`, all of an entity's fields in one `create_field`. `data` is an array on every `create_*`; items may have different keys; the response is an array. And **create every entity before any field**: a field's `reference_table` (another entity of the model, or the entity itself) must exist when the field is created, which the entities-first order guarantees — no second pass for cross-references or self-references.

1. **Resolve/create module**, `read_module`, then `create_module` if needed. (Chicken-and-egg: the module's `view_permission` / `manage_permission_id` point at permissions that don't exist yet, so create the module first and wire them back in step 3.)
2. **Resolve/create permissions**, one `read_permission` with `permission_name=in.(<slug>:read,<slug>:manage)`, then one `create_permission` call carrying the missing ones
3. **Wire the module's permission references with `update_module`.** `create_module` leaves `view_permission` at the platform default (`user:read`) and `manage_permission_id` / `admin_permission_id` null. Once the permissions exist, point the module at them — skip this and the module header shows `user:read` and the manage/admin pickers are empty:
   ```bash
   semantius call crud update_module '{"id": <module_id>, "data": {"view_permission": "<slug>:read", "manage_permission_id": <id of <slug>:manage>}}'
   ```
   **Mind the column types:** `view_permission` is a **text** column holding the permission *name* (`<slug>:read`); `manage_permission_id` and `admin_permission_id` are **numeric FK** columns holding the permission *id*. The default-role columns wire the same way once roles exist: `default_viewer_role_id` / `default_manager_role_id` / `default_admin_role_id` are numeric role-id FKs (see `rbac.md`).
4. **Create the entities**, one `create_entity` call whose `data` array carries every entity of the model (each with `module_id`, `view_permission`, `edit_permission`); one `read_entity` with `table_name=in.(...)` first
5. **Add fields**, per entity, one `create_field` call whose `data` array carries every domain attribute of that entity (not the auto-generated ones); the FK targets all exist by now

---

## Modules

Every entity **must** belong to a module.

A module has two name fields with distinct jobs:

- **`module_name`** is the unique, human-facing display name shown in the UI module selector and on the module landing page. Keep acronyms as acronyms (`CRM`, `ITSM`, `CMDB`), this is what users read. Matches the source model's `system_name`.
- **`module_slug`** is the lowercase, URL-safe handle — **required and non-empty** (regex `^[a-z0-9_-]+$`; lowercase letters, digits, `_`, and `-`, hyphen now allowed). Used in URLs, in the permission prefix, and by other models that reference this module. Matches the source model's `system_slug` (e.g. `crm`, `itsm`, `ben-admin`). A missing, empty, or malformed slug is rejected with `module_slug must be lowercase alphanumeric, underscore, or hyphen`.

> ⚠️ **`alias` is gone.** Earlier schemas had an `alias` column on modules. It has been removed. Use `module_name` for the display name and `module_slug` for the URL/permission handle.

**Check before creating** (filter on `module_slug` for the URL handle, or on `module_name` for the display name):
```bash
semantius call crud read_module '{"filters": "module_slug=eq.crm"}'
```

**Create module + baseline permissions (always both, in ONE `create_permission` call):**
```bash
semantius call crud create_module '{"data": {"module_name": "CRM", "module_slug": "crm", "description": "Customer Relationship Management"}}'
semantius call crud create_permission '{"data": [
  {"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>},
  {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>}
]}'
```

The `description` field is a compact tagline (≤40 chars) shown beside `module_name` in the selector chip, for acronyms, the plain English expansion (`CRM` → `Customer Relationship Management`); for non-acronyms a 2-4 word disambiguating phrase. Long-form prose belongs elsewhere, not on the module record.

Other optional fields on `modules`: `icon_name`, `domain_code`, `access_scope`, `view_permission`, `logo_url`, `logo_color`, `home_page`, `settings`, `dashboard_config`, see the `crud-tools.md` reference for the full field list. Three of these are top-level module classification columns (set them on `create_module` / `update_module`, not inside `settings`):

- **`icon_name`** — the module's UI icon (an icon-set handle, not a URL; distinct from the entity-level `icon_url` and the module `logo_url`).
- **`domain_code`** — short uppercase business-domain code the module belongs to (`ATS`, `HCM`, `ITSM`, `CRM`). Groups related modules; many modules — and many `catalog_module_code`s — can share one `domain_code`.
- **`access_scope`** — enum `basic` | `full`, default `basic`. `basic` for simple read/edit; `full` when the module needs role tiers, approvals, and lifecycle gating.

Permission naming convention: **always `<module_slug>:<action>`** (e.g., `crm:read`, `crm:manage`). The permission prefix is the slug, not the display name, `crm:read`, never `CRM:read`.

---

## Entities

### Creating an Entity

```bash
semantius call crud create_entity '{
  "data": {
    "table_name": "products",
    "singular": "product",
    "plural": "products",
    "singular_label": "Product",
    "plural_label": "Products",
    "description": "A catalog product available for sale",
    "label_column": "product_name",
    "module_id": 3,
    "view_permission": "catalog:read",
    "edit_permission": "catalog:manage",
    "icon_url": "https://example.com/icon.svg",
    "audit_log": false
  }
}'
```

### Entity Naming Rules

- **`table_name` is always plural snake_case**, `products`, `orders`, `order_lines`, not `product`, `order`, `orderLine`
- **Never create a `users` entity**, Semantius has a built-in `users` table. Any module that needs to reference users must use `reference_table: "users"` pointing at the existing table. Creating a competing `users` or `user` entity will conflict with the built-in table and break authentication.

### Semantius built-in entities: shapes

The platform ships with built-in tables for authentication, RBAC, and integration. **Domain models reference these by `table_name`, never recreate them.** If a domain genuinely needs an extra field on a built-in (e.g. `users.is_agent`), add it via `create_field` after dedup. Never modify or rename existing built-in fields, never change their formats, never replace built-in entities.

#### `users` — authenticated principals

| Field | Format | Notes |
|---|---|---|
| `id` | int32 | PK |
| `external_id` | text NOT NULL | Identifier from the auth provider (IdP) |
| `email` | email NOT NULL | The user's email (login identifier) |
| `display_name` | text NOT NULL | Human-readable name shown across the UI (use this — NOT `name`, `full_name`, `user_name`) |
| `is_disabled` | boolean NOT NULL | True when the account is suspended (inverse of "is_active" — use this name, not `is_active` or `is_enabled`) |
| `settings` | json | Per-user preferences blob |
| `last_seen` | date-time | Last activity timestamp |
| `created_at` / `updated_at` | date-time | Auto |

**Common author mistakes when extending `users` (the deployer skips these as overlapping with built-ins):**

| Don't add | Reason |
|---|---|
| `name`, `full_name`, `user_name` | Use existing `display_name`. |
| `is_active`, `active`, `enabled`, `is_enabled` | Use existing `is_disabled` (inverted semantics, same concept). |
| `username`, `login` | Use existing `email`. |
| `preferences`, `config` | Use existing `settings` json. |
| `disabled_at`, `deactivated_at` | Use `is_disabled` + audit log; no separate timestamp. |

**Legitimately additive fields a domain may want:** `is_agent` (boolean — distinguishes service accounts from humans), `primary_team_id` / `department_id` / `manager_id` (FKs to domain entities), `job_title` (text), `employee_id` (text, external HRIS link). These don't overlap with built-in fields and should be added.

#### `roles` — RBAC roles, system-managed slugs

| Field | Format | Notes |
|---|---|---|
| `id` | int32 | PK |
| `role_name` | text NOT NULL | Human-readable display name (e.g. `"CRM Manager"`) |
| `slug` | text NOT NULL UNIQUE | Stable snake_case handle (e.g. `crm_manager`); acts as a natural-key second primary key. **Regex `^[a-z0-9_]+$` — underscores only, NO hyphens.** This differs from `module_slug` (`^[a-z0-9_-]+$`, which DOES allow hyphens): when you build a role slug from a hyphenated module slug, convert `-`→`_` (module `ben-admin` → role `ben_admin_manager`, never `ben-admin_manager`). A hyphen fails the regex. |
| `description` | multiline NOT NULL | What this role does |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. Set by whoever creates the role; default `user`. |
| `module_id` | reference → modules | Which module owns the role |

> **Origin semantics.** `system` rows are platform built-ins (DB-init seeded, never deleted). `model` rows are created by `semantius-modeler` on a domain module's scaffold. `model_master` rows are scaffold roles on a master module (see master-data promotion design). `user` rows are admin-created via the UI/API. **Slug rename is permitted for `model` / `model_master` / `user`; locked for `system`.**

#### `permissions` — RBAC permissions, natural-key by name

| Field | Format | Notes |
|---|---|---|
| `id` | int32 | PK |
| `permission_name` | text NOT NULL UNIQUE | Code in form `<module_slug>:<action>` (e.g. `crm:read`); the unique index makes this a natural-key second primary key |
| `description` | multiline NOT NULL | What this permission grants |
| `module_id` | reference → modules | Owning module |

#### `permission_hierarchy` — RBAC inclusion graph

| Field | Format | Notes |
|---|---|---|
| `including_permission_id` / `included_permission_id` | both → permissions | Reads as `including_permission_id` *includes* `included_permission_id`. Holding the broader (including) permission transitively grants the narrower (included) one. |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. |

#### `user_roles`, `role_permissions` — junctions

Auto-shape with `user_id` / `role_id` / `permission_id` FKs plus `assigned_at` / `granted_at` audit timestamps. Don't redeclare; reference via FK from your domain entities only if you need to surface RBAC state in a domain query.

#### `webhook_receivers`, `webhook_receiver_logs` — inbound HTTP intake

Used by the integration runtime; domain models almost never touch these.

#### `modules`, `entities`, `fields`, `queues`, `queue_table_events`, `dashboards`

Platform meta-schema. **Never declare in a domain model.** The deployer manages these as a side effect of `create_entity` / `create_field` / `create_module`.

### Key Entity Fields

| Field | Notes |
|-------|-------|
| `table_name` | **Plural** snake_case. Renaming is supported but think twice: integrations, saved queries, and external consumers reference the entity by name. |
| `singular_label` | Human-readable name for **one record** (e.g. `Product`). Must be grammatically symmetric with `plural_label`, if `plural_label` is "Products", this must be "Product", never "Product Name". Field-level titles like "Product Name" belong on the auto-created `label` field, not here (see Customizing the `label` field's title below). |
| `plural_label` | e.g. "Products" |
| `label_column` | Snake_case **field name** that identifies a record (e.g. `product_name`). NOT a human-readable title |
| `module_id` | Required on `create_entity` — must be a valid (non-null) integer module id; `null` is rejected. Find with `read_module`. On `update_entity` it stays optional, but a provided value must still be a non-null integer. |
| `view_permission` | Required, name string (e.g. `"catalog:read"`) |
| `edit_permission` | Required, name string (e.g. `"catalog:manage"`) |
| `icon_url` | Optional, URL to an icon representing this entity in the UI |
| `edit_mode` | Optional. Controls how records open for editing: `auto` (default, system decides), `sidebar`, `modal`, or `page`. Set only when the user has a specific UX requirement. |
| `cube_mode` | Optional. OLAP cube generation: `auto` (default, include in cube) or `disabled`. Set to `disabled` to exclude the entity from cube queries. |
| `audit_log` | Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value. |
| `label_parent` | Optional. Names the **one** FK field that is this entity's identity spine — the parent whose composed `_label` prefixes this record's `_label`. Must name a `reference`/`parent` FK; must **not** target a junction and must **not** be set on a junction. Omit for self-identifying records (then `_label` is just the local label). The analyst derives it; the modeler stamps it. |

### Auto-Generated Fields: NEVER Create These Manually

When `create_entity` is called, the system automatically creates:

| Field | `ctype` | Notes |
|-------|---------|-------|
| `id` | `id` | Primary key (`is_pk: true`) |
| `label` | `label` | Display field reading computed value from `label_column` |
| `<label_column>` | `label` | The actual named field (e.g. `product_name`) with title from `singular_label` |
| `created_at` |, | Timestamp, auto-maintained |
| `updated_at` |, | Timestamp, auto-maintained |
| `_label` | `_label` | **Composed label** — the record's full human-readable label, folded from its parent chain (spine → … → local `label`). Read-only, read-time; **not** in the `fields` catalog. |
| `<fk>_label` | `fk_label` | Companion of every `reference`/`parent` FK named `X` → `X_label` = the referenced row's composed `_label` (e.g. `customer_id` → `customer_id_label`). Read-only, read-time; **not** in the `fields` catalog. |

> ⚠️ Calling `create_field` for any of these will fail or create duplicates.

> ℹ️ **`_label` / `<fk>_label` are platform-owned, read-only, read-time projections.** They are absent from the `fields` catalog (`read_field` never returns them) and are **not user-creatable**. Their names are deterministic, so agents select them by the naming convention — e.g. `select=id,_label,customer_id_label` — with **no discovery call**. Never `create_field`, write, or import into them.

> ℹ️ `searchable` and `is_child` on the entity are **read-only** and computed automatically. `searchable` becomes `true` when any field has `searchable: true`; `is_child` becomes `true` when any field uses `format: "parent"`. Never set these manually.

### Platform provenance / meta columns (core-provided; stamp VALUES only, never create)

Base schema **v0.1.2** ships a set of **core provenance columns** on `entities`, `modules`, and `roles`. They are **registered by core with `ctype = 'core'`** — there is **no `is_core` boolean**; `is_core` is *derived* as `ctype <> ''` and still surfaces in `get_schema()`, so anything reading `is_core` keeps working. Every column is **NOT NULL with an empty default** (`''` for text, `'{}'` for a json object, `'[]'` for a json array, `'unclassified'` for the `entity_type` enum); "absent" is the empty value, never SQL `NULL`.

| Table | Column | Type / default | Meaning |
|---|---|---|---|
| `entities` | `catalog_entity_code` | TEXT `''`, non-unique | Canonical uber-model code (the rename / dialect / silo join key). `table_name` holds the deployed name and may drift; this does not. Empty = created outside the deploy pipeline. |
| `entities` | `catalog_owner_module` | TEXT `''` | Owning-module slug for an `embedded_master` placeholder. Soft pointer, not an FK. |
| `entities` | `entity_type` | TEXT `'unclassified'`, CHECK ∈ 6 (`operational_workflow` / `operational_record` / `catalog` / `junction` / `computed` / `unclassified`) | Data-class axis; `write tier` derives FROM it. |
| `entities` | `catalog_entity_aliases` | JSONB `'[]'`, array | Append-only `{alias_code, source_domain, source_module, decided}` reuse/merge records. |
| `modules` | `catalog_module_code` | TEXT `''`, non-unique | Catalog blueprint / `system_slug` the module was provisioned from. The coarser business-domain grouping is the separate `domain_code` column (many `catalog_module_code`s can share one `domain_code`). |
| `roles` | `catalog_role_code` | TEXT `''`, non-unique | Catalog persona the role was provisioned from. |

**Rules for every skill that writes the catalog:**

- **Never `create_field` these columns** — core provides them. Stamp **values only** (the deployer does this at provision time).
- **Never write `ctype`** — it is privilege-locked. There is nothing to set to mark a column "core"; that is core's job.
- The scalar codes (`catalog_entity_code` / `catalog_module_code`) are **write-once at create**; a later rename touches `table_name` / `module_slug` only. `catalog_entity_aliases` is **append-only** (never rewrite or drop prior elements).
- Test emptiness as `= ''` / `= '{}'::jsonb` / `= '[]'::jsonb` / `= 'unclassified'`, **never `IS NULL`**.

### Customizing the `label` field's title

The auto-created `label` field's `title` defaults to `singular_label`. If the record's identifying value is more specific than the entity name, follow up with `update_field` on the `label` field to set its `title`. Example: an entity `cars` where each record is identified by its license plate, keep `singular_label: "Car"` / `plural_label: "Cars"` (symmetric), then update the `label` field's title to `"License Plate"`. See "Updating and Deleting Entities" below for the `update_field` call shape. Do **not** smuggle the field-level title into `singular_label` (e.g. `"Car License Plate"`), that breaks plural/singular symmetry and propagates "Name"/"License Plate" into every UI surface that renders the entity name.

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries optional `computed_fields` / `validation_rules` JSON arrays
(default `[]`; set on `create_entity`, replaced wholesale on `update_entity`)
that derive values and enforce invariants on every write. Caller-supplied values
for a computed field are silently overwritten.
→ Full reference (evaluation semantics, reserved variables, platform-extension
operators, cross-entity lookups): `jsonlogic.md`.

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity carries a `select_rule` JsonLogic object (default `{}`); when non-empty it
drives a per-row `FOR SELECT` RLS policy. **A non-empty rule REPLACES `view_permission`
for reads — a rule without a `has_permission` disjunct locks out admins.** The same
predicate is also AND-ed into the `UPDATE` / `DELETE` row filter (`edit_permission` AND
rule), so it constrains which rows can be modified, not only read. Adding, modifying,
or removing a rule is medium-risk.
→ Full reference: `select-rule.md`.

---

## Fields

> ⚠️ **The #1 field-creation trap: there is no `required` column.** To make a field mandatory, set **`input_type: "required"`** — never `"required": true`. To make it unique, set **`unique_value: true`**. Sending a `required` key to `create_field` fails: the live tool schema has no such field (confirm any time with `semantius info crud create_field`). Likewise **never send `is_nullable`** — the platform computes nullability from `format`. These are the most common "wrote it from memory" errors; the rest of this section gives the full property list.

### Field Format Quick Reference

Choose `format` carefully. Format **can** be changed after creation, but **only within the same Postgres primitive type**. Same-primitive transitions are allowed (`text → multiline → html`, all `TEXT`); cross-primitive transitions are rejected by the platform (`text → date`, `integer → number`, `date → boolean`). The primitive groupings are visible in the format-to-primitive table later in this reference (under `default_value`). Still pick the format deliberately on the first pass: a later change re-renders the form (input shape) and may require republishing UI surfaces, even though the column data survives.

| Category | `format` values |
|----------|----------------|
| Text | `string`, `text`, `multiline`, `html`, `code` |
| Numbers | `integer`, `int32`, `int64`, `number`, `float`, `double`, use `number` (arbitrary-precision, maps to Postgres `NUMERIC`) for all monetary/currency/amount fields (`price`, `cost`, `amount`, `total`, `balance`, `revenue`, `fee`, `rate`, `salary`, `budget`, `discount`). Pair with `precision` (digits after the decimal; default `2` suits money, set `4`–`6` for tax/FX rates, `0` for integer-like NUMERIC counts). `float`/`double` are binary IEEE-754 and lose cents on rounding, only use them when the user explicitly requests them or the value is inherently imprecise (scientific measurements, ML scores, GPS coordinates) |
| Dates/Time | `date`, `time`, `date-time`, `duration` |
| Boolean | `boolean` |
| Choice | `enum` (also set `enum_values: ["a","b","c"]`) |
| Structured | `json`, `object`, `array` |
| Identifiers | `uuid`, `email`, `uri`, `url` |
| Cross-entity link (independent) | `reference` + `reference_table` |
| Ownership/composition | `parent` + `reference_table` |

> 🛑 **Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. Never combine `reference_table` with scalar formats (`integer`, `uuid`, `string`, etc.). This will always fail.**

**Picking between text formats.** All five resolve to a Postgres `TEXT` column; the format selects the UI input shape. Because they share a primitive, the format **can be changed among them after creation** — `text → multiline → html` is safe and accepted by `update_field`. The choice still matters up front because flipping later re-renders the form and may force a UI republish. Cross-primitive changes (e.g. `text → date`) are rejected by the platform.

- `string` and `text` are **single-line** inputs — names, titles, labels, email-like identifiers, short tags. The form renders a single-line `<input>`. Use these for any field that holds a short value displayed on a single row.
- `multiline` is the **multi-line** input — descriptions, notes, comments, free-form prose, journal entries, scorecard commentary. The form renders a `<textarea>`. Pick `multiline` whenever the field holds prose the user might paste a paragraph into; pick `text` / `string` when the value is a single line. The distinction lives in the column metadata, so the choice is made up front and migrating between them later means dropping and recreating the field.
- `html` renders a rich-text editor on top of HTML storage; reserve for fields that need formatted output (release notes, marketing copy).
- `code` renders a monospace code editor; reserve for stored source / configuration snippets.

Heuristic for the analyst: field names like `*_name`, `*_title`, `*_label`, `*_code`, `*_id` (string identifier), `email_address`, `phone_number`, `url` → single-line (`string` or `text`). Field names like `description`, `notes`, `body`, `comment`, `concerns`, `strengths`, `feedback`, `summary`, `details`, `rationale`, `instructions` → multi-line (`multiline`).

> 🛑 **Reserved field names.** A `field_name` must **not** start with `_` (reserves the entity's own `_label`) or end with `_id_label` (reserves the `<fk>_label` companions). The platform rejects both on create and on rename. Plain `*_label` names (e.g. `status_label`) remain allowed.

### `width` Values

| Value | Use |
|-------|-----|
| `default` | **Default, always use this** unless a specific layout requirement exists |
| `s` | Small (short text, booleans, status badges) |
| `m` | Medium |
| `w` | Wide (long text, descriptions) |

### `input_type` Values

| Value | Meaning |
|-------|---------|
| `default` | Standard editable input, use for most fields |
| `required` | Editable but marked mandatory in UI |
| `readonly` | Displayed but not editable, **never import into this** |
| `disabled` | Greyed out, not editable, **never import into this** — this is the canonical mode for **computed fields** (platform owns the value, caller payloads are silently overwritten on every write; see `jsonlogic.md`) |
| `hidden` | Not shown in forms |

> ℹ️ The composed-label columns `_label` / `<fk>_label` are **always** platform-owned and read-only regardless of `input_type` — they are read-time projections, never authored fields, so this table does not apply to them. Never write or import into them.

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` JsonLogic object that overrides the
static `input_type` per record at form-render time. UI-only and fails open — a field
rendered `hidden` / `readonly` is still writable via API; server-side enforcement
belongs in `validation_rules` (see `jsonlogic.md`).
→ Full reference: `jsonlogic.md`.

### `unique_value`

Set `unique_value: true` only when duplicates would cause data integrity issues (e.g., `email` on contacts, external system keys).

> ⚠️ Adding `unique_value: true` to an **existing** field is medium-risk, will fail if duplicates exist. Warn the user and suggest deduplication first.

### `default_value`: auto-filled by the platform; authors only override

The Semantius column-add trigger picks a sensible default automatically based on `format` and whether the field is required (`input_type: "required"`):

| Format | PostgreSQL type | Auto-default when required |
|---|---|---|
| `string`, `text`, `multiline`, `email`, `url`, …  | `TEXT` | `''` |
| `int32`, `int64`, `integer` | `INTEGER` / `BIGINT` | `0` |
| `number`, `float`, `double` | `NUMERIC` / `REAL` | `0.0` |
| `boolean` | `BOOLEAN` | `FALSE` |
| `json`, `object`, `array` | `JSONB` | `'{}'` |
| `date-time` | `TIMESTAMPTZ` | `CURRENT_TIMESTAMP` |
| `date` | `DATE` | `CURRENT_DATE` |
| `enum` | `TEXT` (with CHECK) | first value in `enum_values` |

Nullability is also computed by format (via the platform's `is_nullable()` rule): **only `reference`, `date`, and `date-time` allow NULL**. Every other format is `NOT NULL` with the auto-default above when required. Non-required fields accept `''`/null as a backfill.

**Rule:** you do **not** need to send `default_value` on `create_field`. Only set it explicitly when the auto-default is wrong for the domain, e.g. a non-zero starting balance, a non-initial enum state (`archived` instead of `draft`), a specific seed string.

- **Enum lifecycle ordering matters.** The auto-default for a required enum is `enum_values[0]`, so list values in lifecycle order (`draft`, `pending`, `new`, `open`, `active` first). If the natural starting value isn't first, either reorder the list or pass `default_value` explicitly.
- **There is no settable `is_nullable` flag** — nullability is computed purely from `format` (the `is_nullable()` rule above): only `reference`, `date`, and `date-time` are nullable. For every other format the column is NOT NULL with the auto-default regardless of `input_type`; declaring the field optional doesn't make it nullable.

```bash
# Required enum on a possibly-non-empty entity — always include default_value
semantius call crud create_field '{
  "data": {
    "table_name": "departments",
    "field_name": "workflow_state",
    "title": "Workflow State",
    "format": "enum",
    "enum_values": ["active", "inactive"],
    "default_value": "active",
    "input_type": "required",
    "width": "default",
    "field_order": 5
  }
}'
```

### `cube_type` Values

Controls how a field participates in OLAP cube generation (only relevant when the entity has `cube_mode: "auto"`).

| Value | Meaning |
|-------|---------|
| `disabled` | Field excluded from cube |
| `auto` | **Default.** System infers dimension or measure from `format` |
| `dimension` | Explicit grouping axis (e.g. category, region, status) |
| `measure` | Explicit numeric aggregation (e.g. revenue, count) |

When to set `cube_type` explicitly:

- `dimension`: categorical fields the user will group or filter by (status, country, product type)
- `measure`: numeric fields the user will aggregate (amount, quantity, duration)
- `disabled`: fields that should be excluded from cube queries even if `cube_mode: "auto"` is set on the entity (e.g. internal audit fields, raw foreign keys)
- `auto`: default; leave unset unless the system inference is incorrect

### Example: Add Fields to an Entity

All new fields of an entity go into **one** `create_field` call — `data` is an array, and the items may carry different keys (`searchable` on one, `precision` on another, `enum_values` + `default_value` on a third; a key omitted from an item takes the column default). One request, one transaction, one array back:

```bash
semantius call crud create_field '{
  "data": [
    {
      "table_name": "products",
      "field_name": "description",
      "title": "Description",
      "format": "text",
      "width": "default",
      "input_type": "default",
      "field_order": 30,
      "searchable": true
    },
    {
      "table_name": "products",
      "field_name": "price",
      "title": "Price",
      "format": "number",
      "precision": 2,
      "width": "default",
      "input_type": "default",
      "field_order": 40
    },
    {
      "table_name": "products",
      "field_name": "workflow_state",
      "title": "Workflow State",
      "format": "enum",
      "enum_values": ["draft", "active", "discontinued"],
      "default_value": "draft",
      "width": "default",
      "input_type": "required",
      "field_order": 50
    }
  ]
}'
```

Three separate `create_field` calls for the three fields would be three round trips with no atomicity — the failure the batching rule (Golden Rule 7) names. Duplicate check first, in one read: `read_field '{"filters": "table_name=eq.products&field_name=in.(description,price,workflow_state)"}'`.

### All Field Properties

| Property | Type | Notes |
|----------|------|-------|
| `table_name` | string | Target entity, required |
| `field_name` | string | Snake_case identifier. Renaming is supported but think twice: views, integrations, and saved queries reference the field by name. |
| `title` | string | Human-readable label shown in UI |
| `description` | string | Explains what the field represents |
| `format` | string | Changeable only within the same underlying database base type (e.g., one string format can swap to another string format). Cannot cross base-type families (string, number, date, boolean, reference). See format table above. |
| `width` | string | `default` (default), `s`, `m`, `w` |
| `input_type` | string | `default`, `required`, `readonly`, `disabled`, `hidden` |
| `field_order` | integer | Controls display order in the UI |
| `searchable` | boolean | Adds this field to the entity's full-text search index |
| `unique_value` | boolean | Enforces uniqueness at database level |
| `enum_values` | array | Required when `format: "enum"`, list of allowed values |
| `precision` | integer (0–18) | For `format: "number"` only, number of digits after the decimal point in the generated `NUMERIC` column. Defaults to `2` (suits money and most measured quantities). Set higher (e.g. `4`–`6`) for tax rates, FX rates, or scientific values; `0` for integer-like counts that still want NUMERIC semantics. |
| `default_value` | string | Override for the platform's auto-default. Only set when the auto-default is wrong for the domain. See `### default_value` above for the auto-default table per format. |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade` |
| `relationship_label` | string | Optional verb describing the relationship (e.g. `"employs"`, `"contains"`). Applies to `reference` and `parent` fields. Used as the edge label in ER diagrams and in navigation breadcrumbs. Always optional, omit when the direction is obvious from the field name. |
| `singular_label_parent` | string | Optional override for the parent entity's singular label, used by `parent` fields only. Useful when one entity has multiple `parent` fields pointing at the same table (e.g. `billing_address_id` vs `shipping_address_id`, both → `addresses`) and the default labels are ambiguous. |
| `plural_label_parent` | string | Optional override for the parent entity's plural label, used by `parent` fields only. Pair with `singular_label_parent`. |
| `cube_type` | string | OLAP cube participation: `disabled`, `auto` (default), `dimension`, `measure`. See `### cube_type Values` above. |
| `icon_url` | string | Optional icon URL for this field in the UI |

---

## Relationships

### Choosing the Right Format

The platform manages nullability internally based on format and delete-mode; there is no `is_nullable` flag to pass. A `reference` with `clear` is optional (can be null); a `parent` with `cascade` is required.

**Read order:** the divergent-permission-scope rule (last two rows) **overrides** the "child is owned by parent" and "M:N junction FK" rows whenever the child's edit tier differs from the parent's. Always evaluate divergence first; fall through to the same-tier rows only when tiers match.

| Scenario | `format` | `reference_delete_mode` |
|----------|----------|------------------------|
| Optional link to independent entity | `reference` | `clear` |
| Required link to independent entity | `reference` | `restrict` |
| Child is owned by parent (**shared permission scope** — child tier == parent tier) | `parent` | `cascade` |
| M:N junction FK, **both parents share the junction's tier** (per-leg test, not table-wide) | `parent` | `cascade` |
| **Lifecycle-bound child with divergent permission scope** (analyst v1.13+) — overrides the two rows above | `reference` | `restrict` (default) or `clear` |
| Lifecycle-bound child with divergent permission scope, accepting silent cascade-delete (high-risk) — overrides the two rows above | `reference` | `cascade` |

**Divergent-permission-scope rule (analyst v1.13+).** `format: parent` semantically asserts that the child shares the parent's permission model. When a child has its own conditional permission gate (a `validation_rules` rule whose JsonLogic invokes `require_permission` (see `jsonlogic.md`) against a workflow permission that the parent does not require, or a §3 `**Edit permission:**` annotation that differs from the parent's tier), `parent` is the wrong shape. Use `format: reference` instead. Pick the delete mode by lifecycle behavior: `restrict` when children must be explicitly cleaned up before the parent (recommended default for audit-logged decision evidence like scorecards or signed offers), `clear` when orphan-survival is acceptable (e.g. an authored note may survive its application being deleted), `cascade` only when the user explicitly accepts the silent cascade-delete trade-off (the shape says "permission scope is divergent" but the platform deletes anyway when the lifecycle owner goes).

### `reference`: Cross-Entity Link (Independent Lifecycle)

Use when the child record is **created independently** and then associated with the parent, it exists and makes sense on its own. Example: a Task is created on its own and linked to a Lead; a Product exists independently of any category. The child can outlive or be reassigned away from the parent.

```bash
# Order has an optional assigned sales rep
semantius call crud create_field '{
  "data": {
    "table_name": "orders",
    "field_name": "sales_rep_id",
    "title": "Sales Rep",
    "format": "reference",
    "reference_table": "users",
    "reference_delete_mode": "clear",
    "relationship_label": "manages",
    "width": "default",
    "input_type": "default"
  }
}'
```

### `parent`: Ownership/Composition (Bound Lifecycle)

Use when the child record is **always created in the context of the parent** and has no meaning outside it, master-detail. Example: an Order Line is created within an Order; a Meeting Attendee is created within a Meeting. You would never create the child record first and link it later.

```bash
# Order line belongs to an order
semantius call crud create_field '{
  "data": {
    "table_name": "order_lines",
    "field_name": "order_id",
    "title": "Order",
    "format": "parent",
    "reference_table": "orders",
    "reference_delete_mode": "cascade",
    "relationship_label": "contains",
    "width": "default",
    "input_type": "default"
  }
}'
```

### M:N Junction Tables

Create a junction entity and add a `parent` field for **each** leg (two for a binary junction, three or more for an N-ary one):

```bash
# Create junction entity (products and tags already exist — entities before fields)
semantius call crud create_entity '{"data": {"table_name": "product_tags", ...}}'

# Both parent legs in ONE create_field call
semantius call crud create_field '{"data": [
  {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"},
  {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}
]}'
```

> **Do not set `label_column` on a junction.** `label_column` is optional — the live `create_entity` requires only `table_name`, `singular_label`, `module_id` — and a junction has no natural label field: the platform composes `_label` from the `parent` legs automatically. Setting `label_column` to `id` (or any auto-generated column — `label`, `created_at`, `updated_at`) makes `create_entity` fail with *column 'id' specified more than once*, because that column already exists. Omit `label_column` (as the example above does), and likewise omit `label_parent`.

> **Junctions aren't binary-only.** `entity_type = junction` combines **all** `parent` legs, so an N-ary link works the same way — e.g. `(user, role, tenant)`. But an N-ary link that carries its **own attributes or lifecycle** is an association class → classify it `operational_record` / `operational_workflow`, **not** `junction`.

### Cross-module references and presence-conditional `is_required`

Modules deploy standalone. The blueprint's `related_modules` frontmatter is an **advisory integration hint**, NOT a deployment prerequisite. The deployer never auto-pulls or auto-requires another module to install before this one. A blueprint that needs another module to function (its entities can't deploy without the other module's entities) is a defect to flag, not assemble around.

The mechanism for self-containment is `embedded_master`: a module declares an entity locally with `role = embedded_master` and `mastered_in = <canonical-owner-module>`. The entity exists in this module's catalog until the canonical owner installs; at that point Branch-B promotion (deployer Stage 4c-promote) moves the entity to the canonical owner with no data migration.

For cross-module FK edges, `is_required` is **presence-conditional**:

- A `required` edge becomes a mandatory FK at deploy time **only when the target entity is installed in the same deploy** (either already in the catalog or being created in this run).
- A `required` edge to a non-installed target emits **no FK column and no constraint** at deploy time (the deployer's Stage 4d skip).
- The edge NEVER forces the target entity (or its module) to install.

The blueprint's §5.3b `delete_mode` vocabulary encodes this: `none` (fully optional), `none (required-if-present)` (presence-conditional required), `⚠ audit: <reason>` (soft data-quality flag for required-composed-child-out-of-scope cases).

### Embedded-entity governance follows the entity, not the role

When a module embeds an entity (`role = embedded_master`) whose canonical owner module is absent at the deploy time, the module emits the entity's FULL derived governance under its own slug:

- Workflow gates (the `<verb>` codes that gate lifecycle transitions on the entity).
- Pattern-flag overrides (`view_all_<plural>` / `manage_all_<plural>` / `submit_<singular>`) and matching business rules.
- Boundary-crossing handoffs (events the embedded entity publishes to / reacts from modules the embedding unit doesn't "play").

Each emitted gate / override carries the `re-prefixed-from <canonical-module>.<verb>` reconciliation annotation so the deployer knows it's reconciliation-eligible.

When the canonical owner module later installs and Branch-B promotion moves the entity to its canonical home, the deployer's Stage 4n reconciles every re-prefixed code onto the canonical prefix: sibling permissions are minted under the canonical module, sibling `role_permissions` rows are created for every grant, and matching `permission_hierarchy` edges are re-emitted. **No deletes** — the no-auto-deletion symmetric rule applies to reconciliation too. The old non-canonical-prefixed permissions remain as quiet orphans.

This rule — **gates and overrides follow the ENTITY's current owning module, not the installing unit** — applies uniformly to every blueprint shape (`hiring-starter`, `ats-recruitment-pipeline` which is itself master-of-15-and-embedded-of-5, `real-estate-agent`, any future bundle) and to every install ordering. The deployer's behavior on every install is `module_kind`-agnostic; the `module_kind` frontmatter is an informational label, not a behavior switch.

---

## Safe Evolution Patterns

### ✅ Low-Risk (do freely)
- Add new fields
- Update descriptions, labels, UI hints (`width`, `field_order`, `icon_url`)
- Add `searchable: true` to fields
- Create new entities in new or existing modules
- Add new permissions/roles/assignments
- Add a new `input_type_rule` to a field (pure UI behavior, fails open) — see `jsonlogic.md`

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values`
- Adding `unique_value: true` to an existing field (fails if duplicates exist)
- Adding, modifying, or removing a `select_rule` on an entity (changes read visibility; rows may suddenly disappear or reappear for current users) — see `select-rule.md`
- Modifying or removing an existing `input_type_rule` (forms suddenly show, hide, or unlock a field mid-workflow) — see `jsonlogic.md`

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name`, breaks all references
- Deleting entities or fields, permanent data loss
- Removing permissions still in use by roles
- Changing primary key fields
- Always check dependencies before deletion

---

## Updating and Deleting Entities

```bash
# Update entity metadata (safe — low risk)
semantius call crud update_entity '{
  "table_name": "products",
  "data": {
    "description": "Updated description",
    "view_permission": "catalog:read"
  }
}'

# Update a field (only changed attributes needed)
semantius call crud update_field '{
  "id": "<field-id>",
  "data": {
    "title": "New Title",
    "searchable": true
  }
}'

# Delete field — requires explicit user confirmation first
semantius call crud delete_field '{"id": "<field-id>"}'

# Delete entity — check all dependencies first!
# 1. Check for fields referencing this entity
semantius call crud read_field '{"filters": "reference_table=eq.<table_name>"}'
# 2. Only proceed if no references found and user has confirmed
semantius call crud delete_entity '{"table_name": "<table_name>"}'
```

---

## Agent Workflow Tips

1. **Always read before writing**, Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`. For a bulk create, one `read_*` with an `in.(...)` filter covers all items.
2. **Resolve prerequisites in order**, Module → Permissions → all Entities → Fields. Never skip steps; every entity of the model exists before any field is created.
3. **Batch related writes**, Put all fields of one entity, both baseline permissions of one module, all entities of one model, or all `role_permission` rows of one role into a single `create_*` call with an array in `data`; use an id array for `update_*` / `delete_*` across several records. Fewer calls, one transaction. N single-record calls where one array call would do is a mistake.
4. **Be conversational**, Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
5. **Validate semantic correctness**, Does the model make sense for the user's domain?
6. **Ask for clarification when needed**, If a user says "add contacts", confirm what fields they need before creating anything.
7. **Warn before risky changes**, Alert the user to medium/high-risk changes and wait for confirmation before executing.
8. **Suggest next steps**, After creating an entity, suggest related entities, missing fields, or useful roles.
9. **Provide link to UI**, After creating or updating entities/fields, provide: `{ui_baseurl}/{module_slug}/{table_name}` (get `ui_baseurl` from `getCurrentUser` — never hardcode the org host; URL paths use the lowercase `module_slug`, never the display `module_name`). For a specific record, append the id: `{ui_baseurl}/{module_slug}/{table_name}/{id}`.

Use `wfts(simple)` on the `search_vector` column when the entity is searchable:

```bash
# Check if entity is searchable
semantius call crud read_entity '{"filters": "table_name=eq.contacts"}'
# Look for searchable: true in response

# Full-text search
semantius call crud postgrestRequest '{
  "method": "GET",
  "path": "/contacts?search_vector=wfts(simple).Monica"
}'
```

> Always use `wfts(simple)`, the `simple` text search configuration is language-agnostic and required for multilingual content. Never use bare `wfts` or `fts`. Only fall back to field-specific filters (`ilike`, `eq`) when the user specifies a particular column or when the table is not searchable.

---

## Runtime schema introspection (live FK / shape lookup)

`read_entity` and `read_field` are not just schema-setup tools. They are the live source of truth for the current shape of any entity, and they are cheap to call mid-flight from a business CRUD recipe. Two distinct use cases:

1. **Schema setup** (covered above). Before `create_entity` / `create_field`, check the entity or field doesn't already exist; before `delete_entity`, check what references it.

2. **Runtime drift recovery** (new context). A baked recipe in a domain skill (e.g. one generated by `semantius-skill-maker`) assumes a particular FK shape, junction uniqueness, or audit-log flag. The live schema can drift. When a recipe gets a `409 Conflict`, `422 Unprocessable Entity`, or any write failure it didn't predict, **query the live shape** before deciding how to recover:

```bash
# What FKs does entity <id> have right now?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>"}'

# What does this specific field reference today?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>&name=eq.<field_name>"}'

# Is this entity audit-logged today?
semantius call crud read_entity '{"filters": "id=eq.<entity_id>"}'
# Look for audit_log: true in response
```

> **Combine multiple filter conditions with `&`, never a comma.** `entity=eq.<id>&name=eq.<f>` ANDs two columns (PostgREST query-string syntax). A comma is only a value-list separator *inside* `in.(...)` / `or=(...)`; a top-level `col1=eq.a,col2=eq.b` does **not** mean AND — it silently matches nothing, which reads as "not found" and then triggers a duplicate create on the next write.

If the live shape contradicts the recipe's assumption, abort the recipe with a clear message naming the drift, do not silently "fix it up" with extra writes. Recommend the user regenerate the affected domain skill via `semantius-skill-maker`.

This separation matters because the two contexts have different defaults: schema-setup reads precede a *write to the model*; runtime introspection precedes a *recovery decision* about a stuck business write. Same tools, different guardrails.

---

## Tool Priority Rule

**Always use typed CRUD tools** (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations — including bulk ones: `create_*` takes an array in `data`, `update_*` / `delete_*` take an array in `id` (`table_name` for entities).

Only use `postgrestRequest` or `sqlToRest` for:
- Complex multi-filter or aggregation queries not expressible through typed tools
- A bulk mutation that must be selected by an arbitrary **filter** (not by a list of ids), e.g. `PATCH /fields?table_name=eq.products&format=eq.string`
- An update where each row needs **different** values in one request (typed `update_*` applies the same `data` to every id)
- Business-record rows in your own entity tables (Layer 2), where the array-body POST is the bulk form

---

## Entity Reference: All Managed Tables

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `entities` | Domain concept definition | Parent of fields; references module; uses permissions |
| `fields` | Entity attributes/columns | Belongs to entity; may reference other entities |
| `modules` | Domain grouping | Referenced by entities, roles, permissions |
| `permissions` | Atomic capabilities | Used by entities; granted to roles; can inherit |
| `permission_hierarchy` | Permission inheritance | Links including/included permissions (broader includes narrower) |
| `roles` | Permission bundles | Granted permissions; assigned to users |
| `role_permissions` | Role ↔ Permission M:N | Junction with audit fields |
| `users` | Actor identities | Assigned roles via `user_roles` |
| `user_roles` | User ↔ Role M:N | Junction with audit fields |
| `webhook_receivers` | Import/integration endpoints | Scoped to a target table |
| `webhook_receiver_logs` | Audit log of webhook calls | Belongs to a receiver |

---

## Troubleshooting

### "Permission denied" errors
```bash
# 1. Get current user and their effective permissions
semantius call crud getCurrentUser '{}'

# 2. Check entity's required permissions
semantius call crud read_entity '{"filters": "table_name=eq.<table>"}'

# 3. Trace: user → user_roles → role_permissions → permission_hierarchy
```

### Fields not displaying correctly
- Check `label_column` is set and matches a real field with `ctype='label'`
- Check `field_order` for display sequence
- Check `input_type` is appropriate
- Ensure `width: "default"` unless a specific override is needed
