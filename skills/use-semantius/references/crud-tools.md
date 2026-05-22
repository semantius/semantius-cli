# Semantius CRUD Tool Reference

The `crud` server covers two distinct purposes. Understanding which you need determines which tools to use:

## Layer 1: Schema Management Tools (typed tools)

The 48 typed tools (`create_entity`, `read_field`, `update_role`, etc.) manage Semantius's **semantic data model**, the schema definitions stored in Semantius's own system tables (`entities`, `fields`, `modules`, `permissions`, `roles`, `users`, `webhook_receivers`, etc.).

Use these when: defining new entities, adding fields, configuring RBAC, managing modules.

## Layer 2: Business Record Operations (postgrestRequest)

Every entity you define in Layer 1 becomes a real **PostgreSQL table** accessible via a PostgREST API. `postgrestRequest` gives you full SQL-style CRUD on those tables using HTTP + PostgREST filter syntax.

Use this when: inserting, reading, updating, or deleting actual business data records (e.g. your `/products`, `/orders`, `/contacts` tables).

```
Layer 1 typed tools  →  managing the schema itself
postgrestRequest     →  reading and writing business records in any table
sqlToRest            →  translating a SQL query into PostgREST path syntax
```

---

## Utility Tools

### `getCurrentUser`
Returns current user's profile, email, roles, effective permissions, accessible modules, and `api_baseurl`.
No parameters required, call with `'{}'`.

### `postgrestRequest`

Direct HTTP request against the PostgREST API. Works on **any table**, both Semantius system tables and your own entity tables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `method` | string | yes | HTTP method: `GET`, `POST`, `PATCH`, `DELETE` |
| `path` | string | yes | PostgREST path: `/table_name` optionally followed by `?filters&select&order&limit&offset` |
| `body` | any | no | Request body for POST/PATCH requests |

**Business data examples (your entity tables):**
```bash
# Read all active products
semantius call crud postgrestRequest '{"method":"GET","path":"/products?status=eq.active&order=name.asc"}'

# Read with column selection and pagination
semantius call crud postgrestRequest '{"method":"GET","path":"/orders?select=id,total,status&limit=20&offset=0"}'

# Insert a single record
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":{"first_name":"Alice","email":"alice@example.com","company_id":5}}'

# Bulk insert via array body — every row MUST have the same set of keys; see "Bulk insert: uniform keys required" below
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":[{"first_name":"Alice","email":"a@x.com","company_id":5},{"first_name":"Bob","email":"b@x.com","company_id":7}]}'

# Update matching records (bulk)
semantius call crud postgrestRequest '{"method":"PATCH","path":"/products?category=eq.electronics","body":{"on_sale":true}}'

# Delete a specific record
semantius call crud postgrestRequest '{"method":"DELETE","path":"/orders?id=eq.42"}'

# Full-text search on a searchable entity
# Always use wfts(simple) — the `simple` text search configuration is language-agnostic and required for multilingual content
semantius call crud postgrestRequest '{"method":"GET","path":"/contacts?search_vector=wfts(simple).Monica"}'

# Complex filter: multiple conditions + ordering + pagination
semantius call crud postgrestRequest '{"method":"GET","path":"/orders?status=eq.pending&total=gte.100&order=created_at.desc&limit=50"}'
```

**Schema management examples (Semantius system tables):**
```bash
# Read all entities in a module
semantius call crud postgrestRequest '{"method":"GET","path":"/entities?module_id=eq.3&order=table_name.asc"}'

# Bulk update field widths
semantius call crud postgrestRequest '{"method":"PATCH","path":"/fields?table_name=eq.products&format=eq.string","body":{"searchable":true}}'
```

#### Bulk insert: uniform keys required

When POSTing an **array body** to insert multiple rows, every object in the array must have the **same set of keys**. PostgREST rejects heterogeneous arrays with the misleading error:

```
PGRST102 Empty or invalid json
```

The JSON itself is valid — this is a column-discovery constraint on bulk inserts, not an encoding or transport problem. The wording sends people chasing red herrings (stdin buffering, command-line length, character escaping, auth rotation).

This only affects `POST` with an array body. Single-object inserts (`body: {...}`) and PATCH/DELETE are unaffected.

```bash
# WRONG — second row omits company_id, request is rejected with PGRST102
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":[{"first_name":"Alice","company_id":5},{"first_name":"Bob"}]}'

# RIGHT — every row carries the same keys; use null for "absent"
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":[{"first_name":"Alice","company_id":5},{"first_name":"Bob","company_id":null}]}'
```

When templating the request body from a shell pipeline, normalize to the union of keys before the call. A `jq` one-liner that pads every row of an array with `null` for any missing key:

```bash
echo "$rows" | jq '. as $rows | (map(keys) | add | unique) as $keys | $rows | map(. as $r | reduce $keys[] as $k ({}; .[$k] = ($r[$k] // null)))'
```

If you find yourself building the body in many short steps, chunk into separate single-shape POSTs instead — one CLI call per uniform batch is simpler and survives review.

### `sqlToRest`
Translates a SQL query into a PostgREST path. Useful when you think in SQL and need the equivalent PostgREST syntax.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | yes | SQL query to convert, e.g. `SELECT * FROM products WHERE status = 'active' ORDER BY name` |

```bash
semantius call crud sqlToRest '{"sql": "SELECT id, name, price FROM products WHERE category = '\''electronics'\'' ORDER BY price DESC LIMIT 10"}'
```

### `refresh_schema_cache` *(deno server only)*
Forces PostgREST to reload its schema cache after structural changes.
```bash
semantius call deno refresh_schema_cache '{}'
```
> Call this if PostgREST returns errors about unknown columns or tables after you've just added/modified fields.

---

## PostgREST Filter Operators

Used in the `path` query string for all `postgrestRequest` calls:

| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | Equals | `status=eq.active` |
| `neq` | Not equals | `status=neq.archived` |
| `gt` / `gte` | Greater than / >= | `total=gte.100` |
| `lt` / `lte` | Less than / <= | `id=lte.100` |
| `like` | Pattern (case-sensitive) | `name=like.Acme*` |
| `ilike` | Pattern (case-insensitive) | `name=ilike.*smith*` |
| `in` | In list | `id=in.(1,2,3)` |
| `is` | Null check | `deleted_at=is.null` |
| `wfts(simple)` | Full-text search (multilingual; always use `simple`) | `search_vector=wfts(simple).Monica` |

Combine with `&`: `status=eq.active&total=gte.100&order=created_at.desc`

**Select, order, pagination:**
```
?select=id,name,email          # specific columns
?order=created_at.desc         # sort descending
?order=name.asc,id.desc        # multi-column sort
?limit=20&offset=40            # page 3 of 20-per-page
```

---

## Common Read Parameters (all `read_*` typed tools)

The typed tools accept a structured object instead of raw path strings:

| Parameter | Type | Description |
|-----------|------|-------------|
| `filters` | string | PostgREST filter string, e.g. `"table_name=eq.products&format=eq.string"` |
| `select` | string | Columns to return, e.g. `"id,name,label"`. Default: `"*"` |
| `limit` | integer | Max records to return |
| `offset` | integer | Records to skip, formula: `(page - 1) * limit` |
| `order` | string | Sort, e.g. `"created_at.desc"` or `"name.asc,id.desc"` |

---

## Entity Tools

### `create_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Entity fields. See data-modeling.md for required fields and auto-generated fields. Includes the optional JSON arrays `computed_fields` and `validation_rules` (default `[]`); see "Computed fields and validation rules" in data-modeling.md. |

### `read_entity`
Accepts common read parameters (`filters`, `select`, `limit`, `offset`, `order`). Returns `computed_fields` and `validation_rules` as JSON arrays alongside the other entity properties.

### `update_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table_name` | string | yes | Identifier of the entity to update |
| `data` | object | yes | Fields to update (partial, omitted fields unchanged). `computed_fields` and `validation_rules` are **replaced wholesale** when present in `data`, not merged; send the full intended array. Sending an empty array removes the per-record trigger. |

### `delete_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table_name` | string | yes | ⚠️ Permanent. Check all field references first. |

---

## Field Tools

### `create_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Field definition. See data-modeling.md for formats and constraints. |

### `read_field`
Accepts common read parameters. Key filter: `"table_name=eq.<name>"` to get all fields for an entity.
Also use to find cross-references before deletion: `"reference_table=eq.<table_name>"`.

### `update_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Field ID |
| `data` | object | yes | Fields to update. ⚠️ `format` cannot be changed after creation. |

### `delete_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | ⚠️ Permanent data loss. Require user confirmation. |

---

## Module Tools

### `create_module`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires `module_name`. Optional: `module_slug`, `description`, `view_permission`, `logo_url`, `logo_color`, `home_page`, `settings`, `dashboard_config`. See field reference below. |

#### `modules` field reference

| Field | Type | Notes |
|-------|------|-------|
| `module_name` | string | **Unique display name shown in the UI module selector and on the landing page header** (e.g. `CRM`, `ITSM`, `CMDB`). Keep acronyms as acronyms, this is the human-facing name. Required. |
| `module_slug` | string | URL-safe slug, lowercase alphanumeric or underscore (regex `^([a-z0-9_]+)?$`). Used in URLs, permission prefixes, and as the foreign-key target when referenced from semantic-model files. Convention: matches the source model's `system_slug` (e.g. `crm`, `itsm`, `cmdb`). Optional but strongly recommended, without it the URL/permission scheme has no stable handle. |
| `description` | string | Compact tagline shown beside `module_name` in the selector dropdown and on the landing page (e.g. `Customer Relationship Management`, `IT Service Management`). For acronym `module_name`s use the plain English expansion; for non-acronyms use a 2-4 word disambiguating phrase. Aim for ≤40 characters. Optional. |
| `view_permission` | string | Permission name required to see the module in the selector (e.g. `crm:read`). Optional; when omitted the module is visible to anyone with at least one entity permission inside it. |
| `logo_url` | string | URL or `data:` URI for the module logo shown in the selector chip. Optional. |
| `logo_color` | string | Hex color for the logo background tile (e.g. `#4F46E5`). Optional. |
| `home_page` | string | Path the module's landing button routes to (e.g. `/crm/dashboard`). Optional. |
| `settings` | JSON | Module-specific configuration blob. Optional. |
| `dashboard_config` | JSON | Module landing-page dashboard layout. Optional. |

> ⚠️ **`alias` is removed.** Earlier versions of the schema carried an `alias` field; it is gone. Use `module_name` for the unique display name and `module_slug` for the URL/permission handle. Code or scripts that read or write `alias` will fail.

### `read_module`
Accepts common read parameters.

### `update_module`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Module ID |
| `data` | object | yes | Fields to update |

### `delete_module`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | ⚠️ Check all dependent entities first. |

---

## Permission Tools

### `create_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `permission_name` (format: `<module>:<action>`), `description`, `module_id` |

### `read_permission`
Accepts common read parameters. Key filter: `"permission_name=ilike.<module>:*"` to find a module's permissions.

### `update_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Permission ID |
| `data` | object | yes | Fields to update |

### `delete_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | ⚠️ Check roles using this permission first. |

---

## Permission Hierarchy Tools

### `create_permission_hierarchy`
Creates an inheritance link: a broader permission includes a narrower one. Reads as `including_permission_id` ── *includes* ──▶ `included_permission_id` (e.g. `crm:manage` includes `crm:read`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `including_permission_id` (broader), `included_permission_id` (narrower). `id` is auto-generated as `"<including_permission_id>.<included_permission_id>"`. |

### `read_permission_hierarchy`
Accepts common read parameters. Filter by `including_permission_id` or `included_permission_id`.

### `update_permission_hierarchy`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Hierarchy record ID (`"<including_permission_id>.<included_permission_id>"`) |
| `data` | object | yes | Fields to update (`including_permission_id`, `included_permission_id`). `origin` is immutable. |

### `delete_permission_hierarchy`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Hierarchy record ID (`"<including_permission_id>.<included_permission_id>"`) |

---

## Role Tools

### `create_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `name`, `label`, `module_id`. Optional: `description` |

### `read_role`
Accepts common read parameters.

### `update_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Role ID |
| `data` | object | yes | Fields to update |

### `delete_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | ⚠️ Check user_role assignments first. |

---

## Role Permission Tools

### `create_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `role_id`, `permission_id` |

### `read_role_permission`
Accepts common read parameters. Key filters: `"role_id=eq.<id>"` or `"permission_id=eq.<id>"`.

### `update_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Role permission record ID |
| `data` | object | yes | Fields to update |

### `delete_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Role permission record ID |

---

## User Tools

### `create_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | User fields (email, name, etc.) |

### `read_user`
Accepts common read parameters. Key filter: `"email=eq.user@example.com"`.

### `update_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | User ID |
| `data` | object | yes | Fields to update |

### `delete_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | ⚠️ Permanent. Consider soft-delete instead. |

---

## User Role Tools

### `create_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `user_id`, `role_id` |

### `read_user_role`
Accepts common read parameters. Filter by `user_id` or `role_id`.

### `update_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | User role record ID |
| `data` | object | yes | Fields to update |

### `delete_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | User role record ID |

---

## Webhook Receiver Tools

### `create_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Requires: `label`, `table_name`, `auth_type` (`"hmac"`), `secret` (random alphanumeric string) |

### `read_webhook_receiver`
Accepts common read parameters. Key filter: `"label=eq.Agent Import&table_name=eq.<table>"`.

### `update_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Receiver ID |
| `data` | object | yes | Fields to update |

### `delete_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Receiver ID |

---

## Webhook Receiver Log Tools

### `create_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | yes | Log entry fields |

### `read_webhook_receiver_log`
Accepts common read parameters. Key filter: `"receiver_id=eq.<id>"`. Use `"order": "created_at.desc"` to see recent calls.

### `update_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Log record ID |
| `data` | object | yes | Fields to update |

### `delete_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Log record ID |
