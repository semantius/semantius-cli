# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius, the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

---

## Mandatory Creation Order

**Always follow this sequence, never skip steps:**

```
Module → Permissions → Entity → Fields
```

1. **Resolve/create module**, `read_module`, then `create_module` if needed
2. **Resolve/create permissions**, `read_permission`, then `create_permission` if needed
3. **Create entity**, `create_entity` with `module_id`, `view_permission`, `edit_permission`
4. **Add fields**, `create_field` for each domain attribute (not the auto-generated ones)

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

**Create module + baseline permissions (always both):**
```bash
semantius call crud create_module '{"data": {"module_name": "CRM", "module_slug": "crm", "description": "Customer Relationship Management"}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>}}'
```

The `description` field is a compact tagline (≤40 chars) shown beside `module_name` in the selector chip, for acronyms, the plain English expansion (`CRM` → `Customer Relationship Management`); for non-acronyms a 2-4 word disambiguating phrase. Long-form prose belongs elsewhere, not on the module record.

Other optional fields on `modules`: `view_permission`, `logo_url`, `logo_color`, `home_page`, `settings`, `dashboard_config`, see the `crud-tools.md` reference for the full field list.

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
| `slug` | text NOT NULL UNIQUE | Stable snake_case handle (e.g. `crm_manager`); acts as a natural-key second primary key |
| `description` | multiline NOT NULL | What this role does |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. Set by whoever creates the role; default `user`. |
| `module_id` | reference → modules | Which module owns the role |

> **Origin semantics.** `system` rows are platform built-ins (DB-init seeded, never deleted). `model` rows are created by `semantic-model-deployer` on a domain module's scaffold. `model_master` rows are scaffold roles on a master module (see master-data promotion design). `user` rows are admin-created via the UI/API. **Slug rename is permitted for `model` / `model_master` / `user`; locked for `system`.**

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
| `entities` | `canonical_owner_module` | TEXT `''` | Owning-module slug for an `embedded_master` placeholder. Soft pointer, not an FK. |
| `entities` | `entity_type` | TEXT `'unclassified'`, CHECK ∈ 6 (`operational_workflow` / `operational_record` / `catalog` / `junction` / `computed` / `unclassified`) | Data-class axis; `write tier` derives FROM it. |
| `entities` | `pattern_flags` | JSONB `'{}'`, object | Sparse `{flag: true}` behavior flags (`personal_content` / `submit_lock` / `single_approver` confirmed). |
| `entities` | `catalog_entity_aliases` | JSONB `'[]'`, array | Append-only `{alias_code, source_domain, source_module, decided}` reuse/merge records. |
| `modules` | `catalog_module_code` | TEXT `''`, non-unique | Catalog blueprint the module came from; the domain axis discovery groups by. |
| `roles` | `catalog_role_code` | TEXT `''`, non-unique | Catalog persona the role was provisioned from. |

**Rules for every skill that writes the catalog:**

- **Never `create_field` these columns** — core provides them. Stamp **values only** (the deployer does this at provision time).
- **Never write `ctype`** — it is privilege-locked. There is nothing to set to mark a column "core"; that is core's job.
- The scalar codes (`catalog_entity_code` / `catalog_module_code`) are **write-once at create**; a later rename touches `table_name` / `module_slug` only. `catalog_entity_aliases` is **append-only** (never rewrite or drop prior elements).
- Test emptiness as `= ''` / `= '{}'::jsonb` / `= '[]'::jsonb` / `= 'unclassified'`, **never `IS NULL`**.

### Customizing the `label` field's title

The auto-created `label` field's `title` defaults to `singular_label`. If the record's identifying value is more specific than the entity name, follow up with `update_field` on the `label` field to set its `title`. Example: an entity `cars` where each record is identified by its license plate, keep `singular_label: "Car"` / `plural_label: "Cars"` (symmetric), then update the `label` field's title to `"License Plate"`. See "Updating and Deleting Entities" below for the `update_field` call shape. Do **not** smuggle the field-level title into `singular_label` (e.g. `"Car License Plate"`), that breaks plural/singular symmetry and propagates "Name"/"License Plate" into every UI surface that renders the entity name.

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries two optional JSON-array properties that let the platform derive values and enforce invariants on every write, without per-model service code:

| Property | Type | Default | Purpose |
|---|---|---|---|
| `computed_fields` | `array` | `[]` | Ordered list of fields whose values are derived from the same record via JsonLogic. |
| `validation_rules` | `array` | `[]` | Ordered list of record-level invariants that must hold for a write to succeed. |

Both are first-class entity properties: read with `read_entity`, set on `create_entity`, replaced on `update_entity`. The platform compiles them into `BEFORE INSERT / UPDATE` triggers; when both arrays are empty (or the entity is deleted) the trigger is dropped.

#### `computed_fields` element shape

```json
{
  "name":        "rice_score",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note"
}
```

- `name` (string, required) — must reference an existing scalar field on the same entity. The result is written into this field. May reference a JSONB sub-property via dotted notation (e.g. `"metadata.rice"`).
- `jsonlogic` (object, required) — evaluated against the merged record (caller payload + values written by earlier `computed_fields` entries).
- `description` (string, optional) — human note for future readers and agents.

#### `validation_rules` element shape

```json
{
  "code":        "release_only_when_committed",
  "message":     "A release can only be assigned once the feature is planned, in_progress, or shipped.",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note explaining why this rule exists"
}
```

- `code` (string, required) — snake_case, unique within the entity. Stable identifier for UI / i18n binding.
- `message` (string, required) — default English text returned to the caller on failure.
- `jsonlogic` (object, required) — must evaluate truthy for the record to be valid.
- `description` (string, optional) — human note explaining *why* this rule exists.

#### Evaluation semantics (per write)

1. **Compute pass.** Iterate `computed_fields` in array order. For each entry, evaluate `jsonlogic` against the merged record (caller payload + previously-computed values), then write the result into `name`. If the expression throws, the platform surfaces a structured error naming the offending entry's `name` plus the inner error. Caller-supplied values for a computed field are silently overwritten.
2. **Validate pass.** Iterate `validation_rules` in array order against the post-compute record. A rule passes when the result is truthy. The platform collects *all* failing rules (no short-circuit) and rejects the write with `{ "errors": [ { "code": "...", "message": "..." }, ... ] }`. If `jsonlogic` throws on a rule, the error names the rule's `code` plus the inner error.
3. **Atomicity.** Compute and validate run inside the same transaction as the write — either the record lands with all derivations applied and all rules passing, or nothing changes.

#### Reserved variables

JsonLogic expressions may read these injected variables via `{"var": "$name"}`:

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Server date at evaluation time. |
| `$now` | `date-time` | Server timestamp at evaluation time. |
| `$user_id` | `uuid` | Authenticated user performing the write (`null` for system writes). |
| `$old` | `object` or `null` | Previous row as JSON on UPDATE; `null` on INSERT. Use to express transition rules ("the workflow state cannot move from `released` back to `planned`") and "set-once" invariants ("`account_number` is immutable after first save"). |

`$old` is the only window into prior state; everything else outside the post-write record (cross-row lookups, aggregates, FK traversal) is out of scope and belongs in cube/views.

**Detecting INSERT vs UPDATE:** `$old` is `null` on INSERT, an object on UPDATE. A rule that should fire only on UPDATE wraps its body in `{"if": [{"!=": [{"var": "$old"}, null]}, <update-only-check>, true]}` so the INSERT path passes trivially. Conversely, transition rules that compare current vs prior values (e.g. `{"var": "release_status"}` against `{"var": "$old.release_status"}`) read `null` from `$old.<field>` on INSERT and naturally pass — no extra guard needed unless the INSERT path needs distinct handling.

**Example transition rule** (a release that's reached `released` cannot regress):

```json
{
  "code": "released_is_terminal",
  "message": "A release that has been released cannot move back to planned or in_progress.",
  "jsonlogic": {
    "or": [
      { "==": [{ "var": "$old" }, null] },
      { "!=": [{ "var": "$old.release_status" }, "released"] },
      { "==": [{ "var": "release_status" }, "released"] }
    ]
  }
}
```

The rule passes on INSERT (no prior row), passes when the prior status was anything but `released`, and on UPDATE from `released` only passes when the new status is still `released`.

#### Platform-extension operators

In addition to standard JsonLogic operators, the platform provides three extension operators usable in `computed_fields`, `validation_rules`, `select_rule`, and `input_type_rule`:

| Operator | Shape | Returns | Use in |
|---|---|---|---|
| `{"value_changed": "<field>"}` | unary, takes a field name string | boolean — `true` when the field's value differs from `$old.<field>` (always `true` on INSERT) | `validation_rules`, `computed_fields`. Scope a rule to the moment a specific column changes (e.g. an approval gate fires only on the transition into `approved`, not on every subsequent edit). |
| `{"require_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — returns `true` when the caller holds the permission, **throws** otherwise (surfacing the throw as a validation failure with the rule's `code` / `message`) | `validation_rules`. Use only inside `if` so the throw is conditional, not unconditional. Wrong shape for `select_rule` (a per-row throw during SELECT would be a disaster) — use `has_permission` there instead. |
| `{"has_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — `true` when the caller holds the permission, `false` otherwise (never throws) | `select_rule` (primary use — added specifically so `select_rule` can broaden visibility for elevated roles without throwing per row), `input_type_rule`, and `validation_rules` (when a non-throwing check is preferable, e.g. composing with `or` to allow the permission *or* an ownership match). |

**Choosing between `require_permission` and `has_permission` in `validation_rules`.** Both work on the write side. `require_permission` throws on miss, surfacing the rule's `message` to the caller — the right shape when the permission is a hard requirement and the failure message *is* the explanation ("Only an approver can move an offer to `approved`"). `has_permission` returns boolean — the right shape when the permission is one branch of a wider predicate ("the caller is the owner *or* holds the override permission"), because `or([owner_match, require_permission(...)])` would throw on every non-owner, defeating the disjunction; `or([owner_match, has_permission(...)])` correctly returns truthy whenever either branch matches.

**Example — conditional approval gate (uses `value_changed` + `require_permission`):**

```json
{
  "code": "approve_offer_requires_approver_permission",
  "message": "Only users with the offer-approver permission can mark an offer approved.",
  "jsonlogic": {
    "if": [
      { "and": [
        { "value_changed": "workflow_state" },
        { "==": [{ "var": "workflow_state" }, "approved"] }
      ]},
      { "require_permission": "ats:approve_offer" },
      true
    ]
  }
}
```

**Example — owner-or-elevated edit scope (uses `has_permission`):**

```json
{
  "code": "edit_restricted_to_author_or_manager",
  "message": "Only the note's original author or a user with the manage-all-notes permission can edit this note.",
  "jsonlogic": {
    "if": [
      { "==": [{ "var": "$old" }, null] },
      true,
      { "or": [
        { "==": [{ "var": "$old.author_user_id" }, { "var": "$user_id" }] },
        { "has_permission": "ats:manage_all_notes" }
      ]}
    ]
  }
}
```

INSERT passes trivially (no `$old`); UPDATE / DELETE passes when the caller is the original author or holds the override permission. Using `has_permission` here (not `require_permission`) is essential — the `or` needs a non-throwing branch so the owner-match path works for callers without the override.

#### String concatenation (`concat`)

`concat` joins any number of arguments into a single string, mimicking SQL `CONCAT` semantics. Available in `computed_fields`, `validation_rules`, `select_rule`, and `input_type_rule`.

**Shape:** `{"concat": [arg1, arg2, ...]}`

**Behavior:**

- Accepts any number of arguments of any JSON type.
- `null` / missing values → treated as the empty string (no error, no `"null"` literal).
- Strings → appended as-is (unquoted).
- Numbers, booleans, arrays, objects → converted via their JSON text representation (e.g. `42`, `true`, `[1,2]`, `{"k":"v"}`).
- Returns a JSON string.

**Examples:**

```json
{"concat": ["Hello ", {"var": "name"}, "!"]}
// data {"name": "World"} → "Hello World!"

{"concat": ["Order #", {"var": "id"}, " - ", {"var": "status"}]}
// data {"id": 42, "status": "shipped"} → "Order #42 - shipped"

{"concat": ["a", null, "b"]}
// → "ab"  (null becomes empty, not "null")
```

**Difference from `cat`.** `cat` is the standard JsonLogic string operator and also concatenates, but uses `jl_to_text` coercion (which returns `''` for null and the raw text for strings). `concat` is functionally similar for most inputs; the explicit distinction is the SQL-`CONCAT`-style framing and explicit handling of all JSON types via `::text` for non-strings. Reach for `concat` when the intent is "build a label or message" with mixed-type inputs and predictable null handling; `cat` remains fine for plain string-only joins.

#### Cross-entity lookups inside JsonLogic (`let`, `set_record`, `throw_error`)

`computed_fields` and `validation_rules` are no longer limited to the post-write record. The platform exposes three additional JsonLogic operators that bind values into the data context **before** the rest of the expression evaluates, opening the door to FK traversal, parent-state gates, inherited values, and merged labels that previously had to live in cube views or per-model service code.

| Operator | Shape | Effect |
|---|---|---|
| `let` | `{"let": ["<name>", <value-expression>, <body-expression>]}` | Evaluates `<value-expression>`, binds it under `<name>` for the duration of `<body-expression>`, returns the body's result. Nest `let` calls to bind several names. Useful for naming a sub-expression you reference more than once. |
| `set_record` | `{"set_record": ["<name>", "<entity_name>", <id-expression>, <body-expression>]}` | Resolves `<id-expression>` against the data context, calls `get_record_by_id(<entity_name>, <id>)`, binds the resulting row (JSONB object, or `null` when no row matches) under `<name>` for the duration of `<body-expression>`, returns the body's result. Inside the body, `{"var": "<name>.<column>"}` reads any column of the loaded row, exactly like `$old.<column>` for the post-write record. |
| `throw_error` | `{"throw_error": "<message>"}` | Raises a PostgreSQL exception with SQLSTATE `23514` and the supplied message. The platform surfaces the message back to the caller verbatim, bypassing the rule's static `message` field. Place inside an `if` so the throw is conditional. |

`let` and `set_record` are evaluated before the bulk argument-evaluation pass inside `evaluate_json_logic`, so the body sees an augmented data context. The bindings disappear when the body returns.

**Supporting Postgres function (advanced).** The operators are implemented on top of `get_record_by_id(entity_name TEXT, id TEXT) RETURNS JSONB`, which looks up the entity's `id_column` from the `entities` meta-table, queries the physical table, and returns the row as JSONB (or `NULL` when nothing matches). You normally never call it directly — `set_record` is the authoring surface — but the function is callable from SQL when a query or other trigger needs the same lookup.

**Where they run.** `let`, `set_record`, and `throw_error` are evaluated by the same JsonLogic engine that powers `computed_fields` and `validation_rules`, so they are usable wherever the engine runs:

- ✅ `computed_fields` — derive a value from a parent / referenced record.
- ✅ `validation_rules` — gate a write on the state of a parent or sibling record.
- ⚠️ `select_rule` — *technically* available, but `set_record` runs an extra `SELECT` per row of every read. Use only when the FK target is small and indexed AND the entity sees light read traffic. For tiered visibility, column-encoded broadening (a `visibility` enum) or `has_permission` is almost always the right shape. Default answer: do not use `set_record` in `select_rule`.
- ⚠️ `input_type_rule` — evaluated client-side at form render, so `set_record` cannot fetch a row. Don't use `set_record` here; `let` / `throw_error` are also pointless in a UI control. Stick to record-local variables.

**`throw_error` vs the rule's `message`.** A `validation_rules` entry that returns falsy is rejected with its `code` and `message` packaged into the standard error response. A `throw_error` raises a SQL exception immediately, so:

- The caller receives the `throw_error` argument verbatim as the error text (Postgres `23514` `check_violation`).
- The rule's static `message` is moot when the throw fires — the throw wins.
- Only one rule's throw surfaces (the platform's collect-all-failures pass stops at the first SQL exception). If you want every failing rule listed, prefer falsy-returns with rule-specific `message`s; reach for `throw_error` when one specific failure must surface a different, hand-tailored message than the rule's default (e.g. a multi-language string, a deep-link to the conflicting record, an actionable instruction).

**When to reach for these vs leave them off.** The three operators add real expressiveness, but every `set_record` costs one extra `SELECT` per evaluation. Treat them as the right tool for:

- **Parent-state gates** — refuse to modify an `order_line` when the parent `order.workflow_state = 'shipped'`. Without `set_record`, this rule had no way to read the parent's workflow_state; the gate had to live in application code.
- **Inherited values on a child** — compute `country` on `addresses` from the customer record; copy `currency` from the parent `order` onto every line; pull `discount_pct` from the customer's contract.
- **Merged labels** — derive a `label_column` value that combines fields from the current record AND a parent (`"Line 3 — INV-2025-0042"`, `"<order_number> / <line_no>"`).
- **Conditional cross-entity throw** — a parent record in a specific state should reject the child write with a domain-specific error: `{"throw_error": "Cannot modify a shipped order"}` rather than a generic `"validation failed"`.

They are **not** the right tool for cross-row aggregates ("≤ 5 high-priority features per release", "Σ child amounts ≤ parent total"); those still belong in cube views with downstream alerts, or in dedicated triggers if true synchronous enforcement matters. `set_record` reads one row by id; it does not aggregate, scan, or filter.

#### Canonical patterns

**Pattern 1 — Parent-state gate (the user's example, expanded).** Forbid mutating an `order_lines` row when the parent `orders` is already shipped:

```json
{
  "set_record": ["order", "orders", {"var": "order_id"}, {
    "if": [
      {"==": [{"var": "order.workflow_state"}, "shipped"]},
      {"throw_error": "Cannot modify a shipped order"},
      true
    ]
  }]
}
```

Read: *"bind the parent order under `order`; if the order's workflow_state is `shipped`, raise a domain-specific exception; otherwise the rule passes."*  Placed in `order_lines.validation_rules`; the gate fires on every INSERT, UPDATE, and DELETE on a child line.

**Pattern 2 — Cross-entity computed field (inherited value).** `order_lines.currency_code` mirrors the parent order's currency, so analytics and reports never have to join to find the line's currency:

```json
{
  "name": "currency_code",
  "description": "Mirrors the parent order's currency on every write.",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "var": "order.currency_code"
    }]
  }
}
```

Placed in `order_lines.computed_fields`. Even when the caller supplies `currency_code` directly, the platform silently overwrites it with the parent's value — that's the standard `computed_fields` contract.

**Pattern 3 — Merged label.** `order_lines.label_column = line_label`, computed from the parent order number and the line's own sequence number:

```json
{
  "name": "line_label",
  "description": "'<order_number> · line <line_no>'.",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "cat": [
        {"var": "order.order_number"},
        " · line ",
        {"var": "line_no"}
      ]
    }]
  }
}
```

Reads display as `"INV-2025-0042 · line 3"` everywhere a Semantius UI surface or saved query asks for the line's label, no extra join required.

**Pattern 4 — Use `let` to avoid recomputing a sub-expression.** When the same value appears more than once inside an expression, bind it under `let` so the engine evaluates it only once and the body is easier to read:

```json
{
  "let": ["margin",
    {"-": [{"var": "amount"}, {"var": "cost"}]},
    {"if": [
      {"<": [{"var": "margin"}, 0]},
      {"throw_error": "Margin would go negative — review pricing before saving."},
      {"var": "margin"}
    ]}
  ]
}
```

In `computed_fields`, this writes the margin into a derived field while throwing if the value would be negative. In `validation_rules`, drop the final `{"var": "margin"}` and return `true` from the success branch.

**Pattern 5 — Parent discount applied to a child line.** A child `order_lines.line_total` derives the line subtotal and applies the parent order's `discount_pct`:

```json
{
  "name": "line_total",
  "description": "(unit_price × qty) × (1 - parent_order.discount_pct / 100).",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "let": ["gross",
        {"*": [{"var": "unit_price"}, {"var": "quantity"}]},
        {"*": [
          {"var": "gross"},
          {"-": [1, {"/": [{"var": "order.discount_pct"}, 100]}]}
        ]}
      ]
    }]
  }
}
```

**Pattern 6 — Customer country pulled through two hops.** When the link is a chain (`address → customer.country_code`), nest `set_record` calls; the inner body has access to both bindings:

```json
{
  "name": "country_code",
  "description": "Country of the address's customer, snapshotted on the address row.",
  "jsonlogic": {
    "set_record": ["customer", "customers", {"var": "customer_id"}, {
      "set_record": ["country", "countries", {"var": "customer.country_id"}, {
        "var": "country.iso_code"
      }]
    }]
  }
}
```

#### Null-handling and error shape

`get_record_by_id` returns `NULL` when no row matches (the FK is null, or the id points at a deleted row). Inside `set_record`'s body:

- `{"var": "<name>"}` returns `null` (the row is null).
- `{"var": "<name>.<column>"}` returns `null` (you're reading a column off a null object).

That `null` flows through the expression's comparisons and arithmetic naturally — `{"==": [{"var": "order.workflow_state"}, "shipped"]}` is `false` when `order` is null, so the gate passes. If the rule's intent is "block writes whose FK is unresolved", guard explicitly:

```json
{
  "set_record": ["order", "orders", {"var": "order_id"}, {
    "if": [
      {"==": [{"var": "order"}, null]},
      {"throw_error": "Order not found — cannot write child line."},
      <rest-of-rule>
    ]
  }]
}
```

A `throw_error` raises a SQL exception, which the platform surfaces back as a check-violation (SQLSTATE `23514`). The error body the caller sees is the message string verbatim, so the message is the user-facing error text — keep it short, actionable, and in the same language conventions as the rule's `message` field.

#### Deploy-time guarantees

When `create_entity` / `update_entity` accepts these properties, the platform verifies:

- Both values are arrays (objects of any other shape are rejected).
- Every `computed_fields[].name` resolves to an existing field on the entity.
- Every `validation_rules[].code` is unique within the entity.
- Every `jsonlogic` expression parses; malformed expressions are rejected.

JsonLogic-level column references (`{"var": "<name>"}`) are NOT checked against the entity's field list at parse time when they live under a `set_record` / `let` binding — the binding name is known only at evaluation time. A typo in `{"var": "order.staus"}` (a missing `t`) returns `null` at runtime rather than failing the deploy. Test cross-entity rules end-to-end before relying on them; the platform catches grosser malformations (the operator name itself, the binding name shape) at parse time.

Errors at evaluation time point at the offending entry's index so authoring agents can correct in place.

#### Example: pass both on `create_entity`

```bash
semantius call crud create_entity '{
  "data": {
    "table_name": "features",
    "singular_label": "Feature",
    "plural_label": "Features",
    "label_column": "feature_title",
    "module_id": 12,
    "view_permission": "product_roadmap:read",
    "edit_permission": "product_roadmap:manage",
    "computed_fields": [
      {
        "name": "rice_score",
        "description": "(reach × impact × confidence) / effort, null when effort is missing or 0.",
        "jsonlogic": {
          "if": [
            { "and": [
              { "!=": [{ "var": "effort_score" }, null] },
              { ">":  [{ "var": "effort_score" }, 0] }
            ]},
            { "/": [
              { "*": [
                { "var": "reach_score" },
                { "var": "impact_score" },
                { "var": "confidence_score" }
              ]},
              { "var": "effort_score" }
            ]},
            null
          ]
        }
      }
    ],
    "validation_rules": [
      {
        "code": "release_only_when_committed",
        "message": "A release can only be assigned once the feature is planned, in_progress, or shipped.",
        "jsonlogic": {
          "or": [
            { "==": [{ "var": "release_id" }, null] },
            { "in": [
              { "var": "feature_status" },
              ["planned", "in_progress", "shipped"]
            ]}
          ]
        }
      }
    ]
  }
}'
```

Both arrays default to `[]` and may be omitted entirely. To remove a rule or recompute, send the full replacement array on `update_entity` — the platform replaces, not merges.

#### Out of scope

- Per-field computed expressions (kept entity-level for now).
- Cross-row aggregates (`Σ child.amount ≤ parent.total`, `≤ 5 high-priority features per release`). `set_record` reads a single row by id; it does not scan, aggregate, or filter. Use a cube view + downstream alert, or a dedicated trigger when synchronous enforcement is required.
- Per-locale `message`s (single string; i18n binds via `code`). `throw_error` lets the rule body emit one alternate message at runtime, but the static `message` is still single-string.
- Conditional rule activation (no `when: insert|update|both` yet).

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity carries a `select_rule` property: a single JsonLogic object that, when non-empty, drives a `FOR SELECT` row-level security policy on the underlying table. It is the read-side analog of `validation_rules` (which gates writes): instead of a per-row truthy check on write, it is a per-row truthy check on every read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `select_rule` | `object` (JsonLogic) | `{}` | Per-row predicate that must evaluate truthy for the row to be visible to the caller. Evaluated by the platform's RLS policy on every `SELECT`. |

**Storage and lifecycle.** JSONB object, NOT NULL, default `'{}'::jsonb`; the platform's `select_rule_is_object` constraint rejects anything that isn't a JSON object. When the rule is non-empty, the platform generates a `FOR SELECT` RLS policy function for the table; when the rule is reset to `{}` or the entity is deleted, the policy is dropped. The same `select_rule` predicate is **also** referenced in the `UPDATE` / `DELETE` `USING` clause (AND-ed with `edit_permission` — see *Relationship to `view_permission` / `edit_permission`* below), so it constrains which rows a caller may **modify** as well, not only which it may read. It is absent from `WITH CHECK`, which gates writes on `edit_permission` alone.

**Return contract.** The JsonLogic expression must return a **boolean**:

- `true` — the row is visible to the current caller.
- `false` — the row is filtered out of the result set (the caller can neither read nor see its existence via this entity's table; FK joins from other tables that surface the row will hit the same gate).

A non-boolean result is treated as falsy, so the row is hidden — that fails closed, which is the safer direction, but the rule is malformed and should be corrected.

**Reserved variables** (same vocabulary as `computed_fields` / `validation_rules`, available via `{"var": "$name"}`):

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Server date at evaluation time. |
| `$now` | `date-time` | Server timestamp at evaluation time. |
| `$user_id` | `uuid` | Authenticated user performing the read (`null` for system-initiated reads). |
| `$old` | `object` or `null` | Not meaningful on reads; present for vocabulary parity with validation_rules. Do not rely on it in `select_rule`. |

**Platform-extension operators usable in `select_rule`.** The `has_permission` operator (documented in the platform-extension operators section above) is the canonical way to broaden row visibility for elevated roles. It returns boolean (never throws), which is essential — a throwing operator like `require_permission` would fail per-row during a SELECT scan and is not the right shape for read context. `value_changed` and `$old` are also available syntactically but are not meaningful for read rules.

**Relationship to `view_permission` (reads) and `edit_permission` (writes) — reads REPLACE, writes AND (frozen design decision D8).** The two sides are deliberately asymmetric; do not generalize one onto the other.

- **Reads (`SELECT`) — REPLACE.** A non-empty `select_rule` **is the complete read predicate**; it *replaces* `view_permission` rather than being AND-ed with it. `view_permission` is only the **default rule applied when no `select_rule` is set**:

  ```
  can_read(row) = select_rule(row)                 when select_rule is non-empty
                = has_permission(view_permission)   when select_rule is empty (the default rule)
  ```

  Once a rule exists, `view_permission` is **never consulted** for reads: a caller who **lacks `view_permission` but matches the rule sees the row**, and a caller who **holds `view_permission` but fails the rule does not**. (Enforced by `build_select_rule_policy`: `USING (select_rule_<table>(row))` when a rule exists, falling back to `USING (has_permission(view_permission))` only when it doesn't; the DEFINER read helper `get_record_by_id` mirrors this with an explicit mutually-exclusive `IF/ELSE`.)

- **Writes (`UPDATE` / `DELETE`) — AND.** Genuinely layered: `USING (has_permission(edit_permission) AND select_rule(row))`, with `WITH CHECK (has_permission(edit_permission))`. Here `edit_permission` is a real coarse gate **and** the row must pass `select_rule`. `validation_rules` / `require_permission` add per-record gates on top via a separate trigger.

**Authoring consequence (the part that bites).** Because a read rule owns the *entire* read predicate, you cannot rely on `view_permission` to "still let people in." Encode **every** audience that should read the rows *inside* the rule:

- elevated / admin audiences → a `{"has_permission": "<slug>:view_all_<plural>"}` disjunct (not an external grant);
- "anyone holding baseline read" → a `{"has_permission": "<slug>:read"}` disjunct, when you want to preserve that behavior;
- a restrictive rule with no such disjunct **locks out admins and managers** — even holders of every permission — because they simply don't match and `view_permission` is no longer there to admit them.

**Performance note.** `select_rule` is evaluated on every read of every row of this entity. Keep the expression simple: direct column comparisons, `$user_id` matches, enum / boolean checks. Avoid deeply nested arithmetic. `set_record` *is* technically callable from `select_rule` (the JsonLogic engine is the same as `validation_rules`), but it runs an extra `SELECT` per row of every read and quickly dominates query cost; prefer column-encoded broadening (a `visibility` enum the row carries) or `has_permission` for tiered audiences. Reserve `set_record` for the rare case where the FK target is small, indexed, and read traffic on this entity is light.

**Example — owner-or-public visibility:**

```json
{
  "or": [
    { "==": [{ "var": "owner_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "visibility" }, "public" ] }
  ]
}
```

A caller sees a row when they own it OR when the row is marked public.

**Example — case-management shape (uniform per-row filter).** A ticket is visible to its submitter, its assignee, or every caller when it's unassigned:

```json
{
  "or": [
    { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, null] }
  ]
}
```

**Broadening visibility for elevated roles — `has_permission` is the canonical mechanism.** The previous version of this section claimed permission-based visibility could not be encoded inside `select_rule`; that was wrong. The platform exposes `{"has_permission": "<code>"}` (documented in the platform-extension operators section above) specifically so a per-row SELECT rule can check the caller's permissions and broaden the visible row set without throwing. The two patterns:

**Example — tiered audience (uniform per-row OR elevated-permission bypass):** A ticket is visible to its submitter, its assignee, unassigned tickets are visible to everyone, AND holders of `helpdesk:view_all_tickets` see every row regardless:

```json
{
  "or": [
    { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, null] },
    { "has_permission": "helpdesk:view_all_tickets" }
  ]
}
```

A regular caller sees only the rows the first three clauses cover; a `helpdesk:view_all_tickets` holder sees every row because the fourth clause shortcuts to truthy. This is the standard way to encode "regular sees own; manager sees all" — the rule body is the single source of truth.

**Example — visibility column with conditional elevation:**

```json
{
  "or": [
    { "==": [{ "var": "visibility" }, "public" ] },
    { "==": [{ "var": "author_user_id" }, { "var": "$user_id" }] },
    { "and": [
      { "==": [{ "var": "visibility" }, "team" ] },
      { "has_permission": "roadmap:view_team_notes" }
    ]},
    { "has_permission": "roadmap:view_all_notes" }
  ]
}
```

**Use `has_permission`, not `require_permission`, in `select_rule`.** Both are documented above. The throwing semantics of `require_permission` are wrong for SELECT: a throw per row of a scan would fail the whole query for any caller missing the permission, even when other clauses of the rule would have admitted some rows. `has_permission` returns boolean, which composes correctly with `or` to broaden visibility.

**Out-of-rule alternatives are still useful when in-rule encoding doesn't fit.** Some access patterns are easier or cleaner outside the rule body:

- Provide a separate cube view or entity surface for the broader audience, with its own `view_permission`, when the elevated read returns a different *shape* (aggregates, redacted columns) than the row-level read.
- Configure a Postgres role with the `BYPASSRLS` attribute (DBA-side, outside Semantius) when an operational role legitimately needs unconstrained read across many entities — adding `has_permission` clauses to every entity's `select_rule` is correct but tedious.
- Accept a uniform filter without elevation when nobody actually needs broader access; not every entity needs a tiered read.

The first instinct should still be: encode the broadening inside the rule with `has_permission`. The out-of-rule paths are for cases where in-rule encoding is awkward, not for cases where it is impossible — it isn't.

**Setting and removing.** Pass `select_rule` on `create_entity` to declare it at creation, or on `update_entity` to attach / replace / remove it later. Sending `{}` (or omitting the property on `create_entity`) leaves the rule disabled.

```bash
semantius call crud update_entity '{
  "table_name": "tickets",
  "data": {
    "select_rule": {
      "or": [
        { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
        { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
        { "==": [{ "var": "assignee_user_id" }, null] }
      ]
    }
  }
}'

# Remove the rule and drop the RLS policy function:
semantius call crud update_entity '{
  "table_name": "tickets",
  "data": { "select_rule": {} }
}'
```

**Risk.** Adding a `select_rule` to an entity that previously had none is **medium-risk**, and because reads use REPLACE semantics the change is sharper than it looks: before the rule, every `view_permission` holder saw every row; the instant the rule exists, `view_permission` is no longer consulted and **only** rule-matching rows are visible — so any caller the rule does not explicitly admit (including admins and managers holding every permission) is locked out unless the rule carries a `has_permission` disjunct for them. Always warn the user, enumerate the roles/users that must still see everything, confirm each is admitted by a clause of the rule, and confirm the rollout. Modifying or removing a `select_rule` is also medium-risk (visibility change can surprise downstream consumers, dashboards, integrations).

---

## Fields

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
| `disabled` | Greyed out, not editable, **never import into this** — this is the canonical mode for **computed fields** (platform owns the value, caller payloads are silently overwritten on every write) |
| `hidden` | Not shown in forms |

> ℹ️ The composed-label columns `_label` / `<fk>_label` are **always** platform-owned and read-only regardless of `input_type` — they are read-time projections, never authored fields, so this table does not apply to them. Never write or import into them.

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` property: a JsonLogic object that overrides the static `input_type` per-record at form-render time. It is the read-side analog of `computed_fields` for UI shape: instead of deriving a stored value on write, it derives the field's visible mode on read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `input_type_rule` | `object` (JsonLogic) | `{}` | Per-record predicate that returns the effective `input_type` for this field in the current record. Evaluated client-side at form render. |

**Storage.** JSONB object, NOT NULL, default `'{}'::jsonb`. The static `input_type` column is still the field's declared baseline; `input_type_rule` is the dynamic override applied to that baseline.

**Return contract.** The JsonLogic expression must return **one of the valid `input_type` enum values**: `"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`. The returned value replaces the static `input_type` for this field when the form renders this record.

**Fallback.** If the rule is empty (`{}`), if the expression throws, or if it returns a value that is not a valid `input_type`, the static `input_type` column is used. This is fail-open in the UI-mode sense: a malformed rule degrades to the declared baseline rather than locking or hiding the field unexpectedly.

**Where it runs.** Evaluated **client-side against the current form record** at render time. Server-side reads / writes still respect the field's actual nullability and validation rules — `input_type_rule` is purely a UI control. A field rendered `hidden` is still writable via API; a field rendered `readonly` is still mutable via API. Anything that must be enforced server-side belongs in `validation_rules`, not `input_type_rule`.

**Reserved variables** (where the client supplies them):

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Client date at evaluation time. |
| `$now` | `date-time` | Client timestamp at evaluation time. |
| `$user_id` | `uuid` | The user viewing the form. |

`$old` is not meaningful here (there's no prior-row context client-side); do not reference it in `input_type_rule`.

**Example — lock `approved_at` once the record is approved:**

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    "default"
  ]
}
```

When the current record's `workflow_state` is `approved`, the form renders `approved_at` as `readonly`; otherwise as the standard editable input.

**Example — show `approved_at` only when workflow_state crosses into approved.** The classic "housekeeping field appears at the right moment" pattern: `approved_at` starts hidden, surfaces as a required input once the user is moving the record into `approved`, and locks to readonly after the record is saved approved:

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    "hidden"
  ]
}
```

If you need a third state ("required while transitioning"), nest:

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    { "if": [
      { "==": [{ "var": "$old.workflow_state" }, "approved"] },
      "readonly",
      "hidden"
    ]}
  ]
}
```

Be aware that `$old` is not reliably available in the client-side render context per the contract above; if the form library does supply it, the pattern works, otherwise prefer a simpler two-state rule (`approved` → `readonly`, else `hidden`) and let `validation_rules` enforce "must be set on the approve transition" server-side.

**Setting and removing.** Pass `input_type_rule` on `create_field` or `update_field` under `data`. Sending `{}` removes the rule and the static `input_type` resumes.

```bash
semantius call crud update_field '{
  "id": "tickets.approved_at",
  "data": {
    "input_type_rule": {
      "if": [
        { "==": [{ "var": "workflow_state" }, "approved"] },
        "readonly",
        "default"
      ]
    }
  }
}'

# Remove and revert to the static input_type:
semantius call crud update_field '{
  "id": "tickets.approved_at",
  "data": { "input_type_rule": {} }
}'
```

**Risk.** Adding an `input_type_rule` is **low-risk** — it changes UI behavior only, no data effect, fails open. Modifying or removing one is **medium-risk** in the user-experience sense: forms suddenly show, hide, or unlock a field, which can surprise users mid-workflow. Coordinate the change with whoever owns the forms.

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
- **`is_nullable: false` only changes DB behavior for `reference`, `date`, `date-time`.** For other formats the column is NOT NULL with the auto-default regardless of `input_type`; declaring the field optional doesn't make it nullable.

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

```bash
# Searchable text field
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "description",
    "title": "Description",
    "format": "text",
    "width": "default",
    "input_type": "default",
    "field_order": 2,
    "searchable": true
  }
}'

# Numeric field
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "price",
    "title": "Price",
    "format": "number",
    "precision": 2,
    "width": "default",
    "input_type": "default",
    "field_order": 3
  }
}'

# Enum/dropdown — required, so include default_value to backfill existing rows
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "workflow_state",
    "title": "Workflow State",
    "format": "enum",
    "enum_values": ["draft", "active", "discontinued"],
    "default_value": "draft",
    "width": "default",
    "input_type": "required",
    "field_order": 4
  }
}'
```

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
| `default_value` | string | Override for the platform's auto-default. Only set when the auto-default is wrong for the domain. See `### default_value` below for the auto-default table per format. |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade` |
| `relationship_label` | string | Optional verb describing the relationship (e.g. `"employs"`, `"contains"`). Applies to `reference` and `parent` fields. Used as the edge label in ER diagrams and in navigation breadcrumbs. Always optional, omit when the direction is obvious from the field name. |
| `singular_label_parent` | string | Optional override for the parent entity's singular label, used by `parent` fields only. Useful when one entity has multiple `parent` fields pointing at the same table (e.g. `billing_address_id` vs `shipping_address_id`, both → `addresses`) and the default labels are ambiguous. |
| `plural_label_parent` | string | Optional override for the parent entity's plural label, used by `parent` fields only. Pair with `singular_label_parent`. |
| `cube_type` | string | OLAP cube participation: `disabled`, `auto` (default), `dimension`, `measure`. See `### cube_type Values` below. |
| `icon_url` | string | Optional icon URL for this field in the UI |

---

## Relationships

### Choosing the Right Format

The platform manages nullability internally based on format and delete-mode, do not pass an `is_nullable` flag. A `reference` with `clear` is optional (can be null); a `parent` with `cascade` is required.

**Read order:** the divergent-permission-scope rule (last two rows) **overrides** the "child is owned by parent" and "M:N junction FK" rows whenever the child's edit tier differs from the parent's. Always evaluate divergence first; fall through to the same-tier rows only when tiers match.

| Scenario | `format` | `reference_delete_mode` |
|----------|----------|------------------------|
| Optional link to independent entity | `reference` | `clear` |
| Required link to independent entity | `reference` | `restrict` |
| Child is owned by parent (**shared permission scope** — child tier == parent tier) | `parent` | `cascade` |
| M:N junction FK, **both parents share the junction's tier** (per-leg test, not table-wide) | `parent` | `cascade` |
| **Lifecycle-bound child with divergent permission scope** (analyst v1.13+) — overrides the two rows above | `reference` | `restrict` (default) or `clear` |
| Lifecycle-bound child with divergent permission scope, accepting silent cascade-delete (high-risk) — overrides the two rows above | `reference` | `cascade` |

**Divergent-permission-scope rule (analyst v1.13+).** `format: parent` semantically asserts that the child shares the parent's permission model. When a child has its own conditional permission gate (a `validation_rules` rule whose JsonLogic invokes `require_permission` against a workflow permission that the parent does not require, or a §3 `**Edit permission:**` annotation that differs from the parent's tier), `parent` is the wrong shape. Use `format: reference` instead. Pick the delete mode by lifecycle behavior: `restrict` when children must be explicitly cleaned up before the parent (recommended default for audit-logged decision evidence like scorecards or signed offers), `clear` when orphan-survival is acceptable (e.g. an authored note may survive its application being deleted), `cascade` only when the user explicitly accepts the silent cascade-delete trade-off (the shape says "permission scope is divergent" but the platform deletes anyway when the lifecycle owner goes).

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
# Create junction entity
semantius call crud create_entity '{"data": {"table_name": "product_tags", ...}}'

# FK to products
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'

# FK to tags
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'
```

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
- Add a new `input_type_rule` to a field (pure UI behavior, fails open)

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values`
- Adding `unique_value: true` to an existing field (fails if duplicates exist)
- Adding, modifying, or removing a `select_rule` on an entity (changes read visibility; rows may suddenly disappear or reappear for current users)
- Modifying or removing an existing `input_type_rule` (forms suddenly show, hide, or unlock a field mid-workflow)

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name`, breaks all references
- Deleting entities or fields, permanent data loss
- Removing permissions still in use by roles
- Changing primary key fields
- Always check dependencies before deletion

---

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

1. **Always read before writing**, Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`.
2. **Resolve prerequisites in order**, Module → Permissions → Entity → Fields. Never skip steps.
3. **Be conversational**, Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
4. **Validate semantic correctness**, Does the model make sense for the user's domain?
5. **Ask for clarification when needed**, If a user says "add contacts", confirm what fields they need before creating anything.
6. **Warn before risky changes**, Alert the user to medium/high-risk changes and wait for confirmation before executing.
7. **Suggest next steps**, After creating an entity, suggest related entities, missing fields, or useful roles.
8. **Provide link to UI**, After creating or updating entities/fields, provide: `{ui_baseurl}/{module_slug}/{table_name}` (get `ui_baseurl` from `getCurrentUser` — never hardcode the org host; URL paths use the lowercase `module_slug`, never the display `module_name`). For a specific record, append the id: `{ui_baseurl}/{module_slug}/{table_name}/{id}`.

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
semantius call crud read_field '{"filters": "entity=eq.<entity_id>,name=eq.<field_name>"}'

# Is this entity audit-logged today?
semantius call crud read_entity '{"filters": "id=eq.<entity_id>"}'
# Look for audit_log: true in response
```

If the live shape contradicts the recipe's assumption, abort the recipe with a clear message naming the drift, do not silently "fix it up" with extra writes. Recommend the user regenerate the affected domain skill via `semantius-skill-maker`.

This separation matters because the two contexts have different defaults: schema-setup reads precede a *write to the model*; runtime introspection precedes a *recovery decision* about a stuck business write. Same tools, different guardrails.

---

## Tool Priority Rule

**Always use typed CRUD tools** (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations.

Only use `postgrestRequest` or `sqlToRest` for:
- Complex multi-filter or aggregation queries not expressible through typed tools
- Bulk updates across many existing records

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
