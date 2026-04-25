# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius — the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

---

## Mandatory Creation Order

**Always follow this sequence — never skip steps:**

```
Module → Permissions → Entity → Fields
```

1. **Resolve/create module** — `read_module`, then `create_module` if needed
2. **Resolve/create permissions** — `read_permission`, then `create_permission` if needed
3. **Create entity** — `create_entity` with `module_id`, `view_permission`, `edit_permission`
4. **Add fields** — `create_field` for each domain attribute (not the auto-generated ones)

---

## Modules

Every entity **must** belong to a module.

**Check before creating:**
```bash
semantius call crud read_module '{"filters": "module_name=eq.crm"}'
```

**Create module + baseline permissions (always both):**
```bash
semantius call crud create_module '{"data": {"module_name": "crm", "label": "CRM", "description": "Customer relationship management"}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>}}'
```

Permission naming convention: **always `<module>:<action>`** (e.g., `crm:read`, `crm:manage`, `leads:write`).

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

- **`table_name` is always plural snake_case** — `products`, `orders`, `order_lines`, not `product`, `order`, `orderLine`
- **Never create a `users` entity** — Semantius has a built-in `users` table. Any module that needs to reference users must use `reference_table: "users"` pointing at the existing table. Creating a competing `users` or `user` entity will conflict with the built-in table and break authentication.

### Key Entity Fields

| Field | Notes |
|-------|-------|
| `table_name` | **Plural** snake_case, stable — **never change after creation** |
| `singular_label` | Human-readable name for **one record** (e.g. `Product`). Must be grammatically symmetric with `plural_label` — if `plural_label` is "Products", this must be "Product", never "Product Name". Field-level titles like "Product Name" belong on the auto-created `label` field, not here (see Customizing the `label` field's title below). |
| `plural_label` | e.g. "Products" |
| `label_column` | Snake_case **field name** that identifies a record (e.g. `product_name`). NOT a human-readable title |
| `module_id` | Required — find with `read_module` |
| `view_permission` | Required — name string (e.g. `"catalog:read"`) |
| `edit_permission` | Required — name string (e.g. `"catalog:manage"`) |
| `icon_url` | Optional — URL to an icon representing this entity in the UI |
| `audit_log` | Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value. |

### Auto-Generated Fields — NEVER Create These Manually

When `create_entity` is called, the system automatically creates:

| Field | `ctype` | Notes |
|-------|---------|-------|
| `id` | `id` | Primary key (`is_pk: true`) |
| `label` | `label` | Display field reading computed value from `label_column` |
| `<label_column>` | `label` | The actual named field (e.g. `product_name`) with title from `singular_label` |
| `created_at` | — | Timestamp, auto-maintained |
| `updated_at` | — | Timestamp, auto-maintained |

> ⚠️ Calling `create_field` for any of these will fail or create duplicates.

> ℹ️ `searchable` on the entity is **read-only** — computed automatically when any field has `searchable: true`. Do not try to set it directly on the entity.

### Customizing the `label` field's title

The auto-created `label` field's `title` defaults to `singular_label`. If the record's identifying value is more specific than the entity name, follow up with `update_field` on the `label` field to set its `title`. Example: an entity `cars` where each record is identified by its license plate — keep `singular_label: "Car"` / `plural_label: "Cars"` (symmetric), then update the `label` field's title to `"License Plate"`. See "Updating and Deleting Entities" below for the `update_field` call shape. Do **not** smuggle the field-level title into `singular_label` (e.g. `"Car License Plate"`) — that breaks plural/singular symmetry and propagates "Name"/"License Plate" into every UI surface that renders the entity name.

---

## Fields

### Field Format Quick Reference

Choose `format` carefully — **it is immutable after creation**.

| Category | `format` values |
|----------|----------------|
| Text | `string`, `text`, `html`, `code` |
| Numbers | `integer`, `int32`, `int64`, `float`, `double` |
| Dates/Time | `date`, `time`, `date-time`, `duration` |
| Boolean | `boolean` |
| Choice | `enum` (also set `enum_values: ["a","b","c"]`) |
| Structured | `json`, `object`, `array` |
| Identifiers | `uuid`, `email`, `uri`, `url` |
| Cross-entity link (independent) | `reference` + `reference_table` |
| Ownership/composition | `parent` + `reference_table` |

> 🛑 **Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. Never combine `reference_table` with scalar formats (`integer`, `uuid`, `string`, etc.). This will always fail.**

### `width` Values

| Value | Use |
|-------|-----|
| `default` | **Default — always use this** unless a specific layout requirement exists |
| `s` | Small (short text, booleans, status badges) |
| `m` | Medium |
| `w` | Wide (long text, descriptions) |

### `input_type` Values

| Value | Meaning |
|-------|---------|
| `default` | Standard editable input — use for most fields |
| `required` | Editable but marked mandatory in UI |
| `readonly` | Displayed but not editable — **never import into this** |
| `disabled` | Greyed out, not editable |
| `hidden` | Not shown in forms |

### `unique_value`

Set `unique_value: true` only when duplicates would cause data integrity issues (e.g., `email` on contacts, external system keys).

> ⚠️ Adding `unique_value: true` to an **existing** field is medium-risk — will fail if duplicates exist. Warn the user and suggest deduplication first.

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
    "format": "float",
    "width": "default",
    "input_type": "default",
    "field_order": 3
  }
}'

# Enum/dropdown
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "status",
    "title": "Status",
    "format": "enum",
    "enum_values": ["draft", "active", "discontinued"],
    "width": "default",
    "input_type": "default",
    "field_order": 4
  }
}'
```

### All Field Properties

| Property | Type | Notes |
|----------|------|-------|
| `table_name` | string | Target entity — required |
| `field_name` | string | Snake_case identifier — stable, **never change after creation** |
| `title` | string | Human-readable label shown in UI |
| `description` | string | Explains what the field represents |
| `format` | string | **Immutable after creation** — see format table above |
| `width` | string | `default` (default), `s`, `m`, `w` |
| `input_type` | string | `default`, `required`, `readonly`, `disabled`, `hidden` |
| `field_order` | integer | Controls display order in the UI |
| `searchable` | boolean | Adds this field to the entity's full-text search index |
| `unique_value` | boolean | Enforces uniqueness at database level |
| `enum_values` | array | Required when `format: "enum"` — list of allowed values |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade` |
| `icon_url` | string | Optional icon URL for this field in the UI |

---

## Relationships

### Choosing the Right Format

The platform manages nullability internally based on format and delete-mode — do not pass an `is_nullable` flag. A `reference` with `clear` is optional (can be null); a `parent` with `cascade` is required.

| Scenario | `format` | `reference_delete_mode` |
|----------|----------|------------------------|
| Optional link to independent entity | `reference` | `clear` |
| Required link to independent entity | `reference` | `restrict` |
| Child is owned by parent | `parent` | `cascade` |
| M:N junction FK (both sides) | `parent` | `cascade` |

### `reference` — Cross-Entity Link (Independent Lifecycle)

Use when the child record is **created independently** and then associated with the parent — it exists and makes sense on its own. Example: a Task is created on its own and linked to a Lead; a Product exists independently of any category. The child can outlive or be reassigned away from the parent.

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
    "width": "default",
    "input_type": "default"
  }
}'
```

### `parent` — Ownership/Composition (Bound Lifecycle)

Use when the child record is **always created in the context of the parent** and has no meaning outside it — master-detail. Example: an Order Line is created within an Order; a Meeting Attendee is created within a Meeting. You would never create the child record first and link it later.

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
    "width": "default",
    "input_type": "default"
  }
}'
```

### M:N Junction Tables

Create a junction entity and add two `parent` fields:

```bash
# Create junction entity
semantius call crud create_entity '{"data": {"table_name": "product_tags", ...}}'

# FK to products
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'

# FK to tags
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'
```

---

## Safe Evolution Patterns

### ✅ Low-Risk (do freely)
- Add new fields
- Update descriptions, labels, UI hints (`width`, `field_order`, `icon_url`)
- Add `searchable: true` to fields
- Create new entities in new or existing modules
- Add new permissions/roles/assignments

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values`
- Adding `unique_value: true` to an existing field (fails if duplicates exist)

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name` — breaks all references
- Deleting entities or fields — permanent data loss
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

1. **Always read before writing** — Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`.
2. **Resolve prerequisites in order** — Module → Permissions → Entity → Fields. Never skip steps.
3. **Be conversational** — Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
4. **Validate semantic correctness** — Does the model make sense for the user's domain?
5. **Ask for clarification when needed** — If a user says "add contacts", confirm what fields they need before creating anything.
6. **Warn before risky changes** — Alert the user to medium/high-risk changes and wait for confirmation before executing.
7. **Suggest next steps** — After creating an entity, suggest related entities, missing fields, or useful roles.
8. **Provide link to UI** — After creating or updating entities/fields, provide: `https://tests.semantius.app/{module_name}/{table_name}`

Use `wfts` (web full-text search) on the `search_vector` column when the entity is searchable:

```bash
# Check if entity is searchable
semantius call crud read_entity '{"filters": "table_name=eq.contacts"}'
# Look for searchable: true in response

# Full-text search
semantius call crud postgrestRequest '{
  "method": "GET",
  "path": "/contacts?search_vector=wfts.Monica"
}'
```

> Use `wfts`, never `fts`. Only use field-specific filters (`ilike`, `eq`) when the user specifies a particular column or when the table is not searchable.

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
| `permission_hierarchy` | Permission inheritance | Links parent/child permissions |
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
