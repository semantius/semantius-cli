# Semantius CRUD Tool Reference

The `crud` server covers two distinct purposes. Understanding which you need determines which tools to use:

## Layer 1: Schema Management Tools (typed tools)

The 48 typed tools (`create_entity`, `read_field`, `update_role`, etc.) manage Semantius's **semantic data model**, the schema definitions stored in Semantius's own system tables (`entities`, `fields`, `modules`, `permissions`, `roles`, `users`, `webhook_receivers`, etc.). Every `create_*` accepts `data` as one object **or a non-empty array of objects**, and every `update_*` / `delete_*` accepts its key (`id`, or `table_name` for entities) as one value **or an array** — see "Bulk operations" below.

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
Returns the current user's profile, email, roles, effective permissions, and accessible modules. No parameters required, call with `'{}'`.

It also returns three base values for building endpoints and links — always derive these from `getCurrentUser`, never hardcode the org host:
- **`api_baseurl`** — base for webhook/hook endpoints (e.g. `{api_baseurl}/hook/{webhook_receiver_id}`).
- **`semantius_org`** — the org slug (e.g. `mytest`).
- **`ui_baseurl`** — the web UI base, `https://<org>.semantius.app`. Build links to the web user interface from it:
  - List of records for an entity: `{ui_baseurl}/{module_slug}/{table_name}` (e.g. `https://mytest.semantius.app/hiring-starter/job_applications`)
  - A specific record: `{ui_baseurl}/{module_slug}/{table_name}/{id}` (e.g. `https://mytest.semantius.app/hiring-starter/job_applications/719`)

  URL paths use the lowercase `module_slug`, never the display `module_name`.

### `postgrestRequest`

Direct HTTP request against the PostgREST API. Works on **any table**, both Semantius system tables and your own entity tables.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `method` | string | yes | HTTP method: `GET`, `POST`, `PATCH`, `DELETE` |
| `path` | string | yes | PostgREST path: `/table_name` optionally followed by `?filters&select&order&limit&offset` |
| `body` | object \| object[] | no | Request body for POST/PATCH requests. One object, or an **array of objects for a bulk insert** — under raw PostgREST rules: every item must carry the same keys, unless the path adds `?columns=col1,col2` (then keys omitted from an item become **NULL**, not the column default; this tool has no `prefer` input, so `missing=default` is unavailable). For bulk writes to the catalog tables use the typed `create_*` / `update_*` / `delete_*` tools, which handle mixed keys for you. |
| `accept` | string | no | Accept header forwarded to PostgREST (`application/vnd.pgrst.object+json` for exactly one row, `text/csv`). Never combine the object+json Accept with an array `body`. |

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

# Delete several records by id in ONE call
semantius call crud postgrestRequest '{"method":"DELETE","path":"/orders?id=in.(42,43,44)"}'

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

#### Bulk insert via `postgrestRequest`: uniform keys required (raw PostgREST rules)

Inserting many rows into a business table is **one** `POST` with an **array body**, never one call per row (Golden Rule 7). `postgrestRequest` is the raw PostgREST path, so two raw rules apply that the typed `create_*` tools handle for you:

1. Every object in the array must have the **same set of keys**. PostgREST rejects heterogeneous arrays with the misleading error:

   ```
   PGRST102 Empty or invalid json
   ```

   The JSON itself is valid — this is a column-discovery constraint on bulk inserts, not an encoding or transport problem. The wording sends people chasing red herrings (stdin buffering, command-line length, character escaping, auth rotation).

2. The alternative, `?columns=col1,col2,…` on the path, lifts the same-keys rule but makes a key omitted from an item **NULL** (not the column default): `postgrestRequest` exposes no `prefer` input, so PostgREST's `Prefer: missing=default` cannot be sent. Use `?columns=` only when NULL is acceptable for every omitted key (nullable `reference` / `date` / `date-time` columns); a NOT NULL text or number column needs an explicit `""` / `0` on every row.

This only affects `POST` with an array body. Single-object inserts (`body: {...}`) and PATCH/DELETE are unaffected. Keep a batch to roughly 100–250 rows; the response is the array of inserted rows (never combine an array body with `accept: application/vnd.pgrst.object+json` or the CLI's `--single`).

```bash
# WRONG — second row omits company_id, request is rejected with PGRST102
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":[{"first_name":"Alice","company_id":5},{"first_name":"Bob"}]}'

# RIGHT — every row carries the same keys; use null for "absent"
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts","body":[{"first_name":"Alice","company_id":5},{"first_name":"Bob","company_id":null}]}'

# ALSO RIGHT when NULL is acceptable for the omitted keys — ?columns= names the union of keys
semantius call crud postgrestRequest '{"method":"POST","path":"/contacts?columns=first_name,company_id","body":[{"first_name":"Alice","company_id":5},{"first_name":"Bob"}]}'
```

When templating the request body from a shell pipeline, normalize to the union of keys before the call. A `jq` one-liner that pads every row of an array with `null` for any missing key:

```bash
echo "$rows" | jq '. as $rows | (map(keys) | add | unique) as $keys | $rows | map(. as $r | reduce $keys[] as $k ({}; .[$k] = ($r[$k] // null)))'
```

If you find yourself building the body in many short steps, chunk into separate single-shape POSTs instead — one CLI call per uniform batch is simpler and survives review. **Catalog rows are different:** the typed `create_field` / `create_permission` / … tools take a ragged array (the server sends `?columns=<union>` with `missing=default`), so never route those through `postgrestRequest` just to batch them.

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

### `sendEmail`

Sends a transactional email via the Semantius email service. Provide `text`, `html`, or both. Returns the provider `messageId` on success.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string \| string[] | yes | Recipient address, or array of addresses |
| `subject` | string | yes | Subject line (non-empty) |
| `text` | string | no\* | Plain-text body |
| `html` | string | no\* | HTML body |
| `from` | string | no | Sender address. Defaults to the authenticated user's email. Must be on a verified Semantius sending domain when overridden. |
| `replyTo` | string | no | Reply-To address. Defaults to `from`. |
| `cc` | string \| string[] | no | CC recipient(s) |
| `bcc` | string \| string[] | no | BCC recipient(s) |

\* At least one of `text` or `html` must be provided.

```bash
# Minimal — defaults from to the authenticated user
semantius call crud sendEmail '{"to":"alice@example.com","subject":"Hello","text":"hi there"}'

# Both text and html (improves deliverability)
semantius call crud sendEmail '{"to":"alice@example.com","subject":"Hello","text":"hi","html":"<p>hi</p>"}'

# Multiple recipients + cc
semantius call crud sendEmail '{"to":["a@x.com","b@x.com"],"cc":"manager@x.com","subject":"FYI","text":"see attached report"}'
```

> **Quoting note:** subjects or bodies containing `!` will trigger bash history expansion in interactive shells. Use single-quoted JSON (as above) or `set +H` to disable.

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

## Bulk operations (all typed `create_*` / `update_*` / `delete_*` tools)

**Rule: if more than one record of the same kind is pending, send them in ONE call. Never loop single-record calls.** One array call is one HTTP request and one database transaction; N single calls are N round trips with partial-failure risk and no atomicity.

- **`create_*`**: `data` is either one object or a **non-empty array of objects**. **Items do not need the same keys** — the server sends the union of keys (`?columns=`) with `Prefer: return=representation,missing=default`, so a key omitted from one item takes the column default (an explicit `null` still inserts NULL). All rows are inserted in one request and one transaction (all-or-nothing). Example: `create_field` with `data: [ {…description}, {…cost} ]`.
- **`update_*`**: `id` is either one value or a **non-empty array of ids** (for `update_entity` the key is `table_name`); sent as `id=in.(...)`. The **same** `data` is applied to every listed record. For per-record values, call once per record (or use a filter-based `postgrestRequest` PATCH).
- **`delete_*`**: `id` (or `table_name` for entities) is either one value or a **non-empty array**; all listed records are deleted in one request.
- **Key types** follow the table: string ids for `field` (`"<table>.<field>"`), `permission_hierarchy`, `role_permission`, `user_role`, and entity `table_name`; integer ids for `module`, `permission`, `role`, `user`, `webhook_receiver`, `webhook_receiver_log`.
- **Responses** are always an array of the created / updated / deleted records. Never combine an array input with `accept: application/vnd.pgrst.object+json` or the CLI's `--single` (the CLI rejects that before sending: exit 1, `SINGLE_ARRAY_INPUT`).
- **Duplicate checks still apply**: before a bulk `create_*`, run **one** `read_*` with an `in.(...)` filter covering all items (e.g. `"filters": "field_name=in.(description,cost)&table_name=eq.services"`) — never a `--single` read per item (an `in.()` matching several rows exits 2 with `--single`).
- **Failure is all-or-nothing**: a rejected bulk call landed nothing. Quote the platform error (it names the offending row / constraint), fix, re-issue the one call. Do not fall back to a loop of single calls to "find the bad row".
- Keep batches reasonable (roughly up to 100 rows or ids per call); split larger sets into a few calls.
- **Order across kinds still matters**: create every entity of a model (one `create_entity` call) before any of their fields (one `create_field` call per entity), so each field's `reference_table` already exists.
- Typical batches: all fields of a new entity, the `<module>:read` + `<module>:manage` permissions of a new module, all `role_permission` rows of a role, all `permission_hierarchy` rows of a module, all `user_role` rows of a role, several ids to delete.
- `postgrestRequest` also accepts an array `body`, but with raw PostgREST rules (identical keys per item unless `?columns=` is added, and omitted keys become NULL — no `missing=default`). Prefer the typed tools for bulk writes to the catalog tables; use the array-body POST for business rows (see "Bulk insert via `postgrestRequest`" above).

```bash
# Two fields in one create_field call — items may carry different keys
semantius call crud create_field '{"data": [
  {"table_name": "services", "field_name": "description", "title": "Description", "format": "text", "searchable": true, "width": "default", "input_type": "default"},
  {"table_name": "services", "field_name": "cost", "title": "Cost", "format": "number", "precision": 2, "width": "default", "input_type": "default"}
]}'

# Same patch on several fields in one update_field call (string composite ids)
semantius call crud update_field '{"id": ["services.cost", "services.description"], "data": {"width": "m"}}'

# Several roles deleted in one delete_role call (integer ids)
semantius call crud delete_role '{"id": [4, 5, 6]}'

# Duplicate check for a bulk create: ONE read over every item
semantius call crud read_field '{"filters": "table_name=eq.services&field_name=in.(description,cost)", "select": "field_name"}'
```

---

## Entity Tools

### `create_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | Entity fields — one object, or a **non-empty array** to create several entities in one request (all entities of a model go in one call, before any of their fields; items may have different keys). See data-modeling.md for required fields and auto-generated fields. `module_id` is **required** and must be a valid integer module id (`null` is rejected — it is no longer nullable). `singular` is now **optional**. Includes the optional JSON arrays `computed_fields` and `validation_rules` (default `[]`); see "Computed fields and validation rules" in jsonlogic.md. Also accepts the optional `label_parent` (the FK field name that is this entity's identity spine; must name a `reference`/`parent` FK, must not be set on a junction or target one). |

### `read_entity`
Accepts common read parameters (`filters`, `select`, `limit`, `offset`, `order`). Returns `computed_fields` and `validation_rules` as JSON arrays alongside the other entity properties, plus `label_parent` (the identity-spine FK field name, or null).

### `update_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table_name` | string \| string[] | yes | Identifier of the entity to update, or an array of `table_name`s to apply the same `data` to several entities in one request (`table_name=in.(...)`) |
| `data` | object | yes | Fields to update (partial, omitted fields unchanged). `module_id` stays optional, but **when provided** must be a non-null integer (`null` is now rejected). `singular` is optional (unchanged). `computed_fields` and `validation_rules` are **replaced wholesale** when present in `data`, not merged; send the full intended array. Sending an empty array removes the per-record trigger. `label_parent` may be set or cleared here (re-points the identity spine; no data migration — `_label` is derived at read time). |

### `delete_entity`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table_name` | string \| string[] | yes | ⚠️ Permanent. Check all field references first. An array deletes several entities in one request. |

---

## Field Tools

### `create_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | Field definition — one object, or a **non-empty array** to create several fields in one request (all new fields of an entity go in one call; items may have different keys, e.g. `enum_values` on one and `precision` on another). See data-modeling.md for formats and constraints. |

### `read_field`
Accepts common read parameters. Key filter: `"table_name=eq.<name>"` to get all fields for an entity.
Also use to find cross-references before deletion: `"reference_table=eq.<table_name>"`.

### `update_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | Field ID (`"<table_name>.<field_name>"`), or an array of ids to apply the same `data` to several fields in one request |
| `data` | object | yes | Fields to update. ⚠️ `format` cannot be changed after creation. |

### `delete_field`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | ⚠️ Permanent data loss. Require user confirmation. An array deletes several fields in one request. |

---

## Composed labels: `_label` and `<fk>_label` (read-only, select by name)

Every entity exposes a read-only **`_label`** — its composed, human-readable label, folded from its parent chain (the identity spine's `_label` ⧺ ` › ` ⧺ the local label). Every `reference`/`parent` FK named `X` exposes a read-only companion **`X_label`** = the referenced row's composed `_label` (e.g. `customer_id` → `customer_id_label`).

- **Select them explicitly by name** — `select=id,_label,customer_id_label`. They are not authored fields (absent from the `fields` catalog; `read_field` never returns them) and are **not** included in `select=*`.
- **Names are deterministic, so no discovery call is needed:** `_label` on the entity, and `<fk>_label` on each `reference`/`parent` FK (the FK field name + `_label`). (`get_schema` is a UI aggregation endpoint, not a skill tool — don't use it to find these.)
- **Read-only.** Never `create_field`, write, or import into `_label` / `<fk>_label`; the platform owns them and computes them at read time.

**Displaying a parent's label — prefer `select=X_label` over embedding.** To show a parent's name beside a child row, select the FK companion (`select=id,interview_id_label`) rather than PostgREST resource embedding (`select=id,interviews(label)`). The companion returns the parent's *composed* `_label`, respects the caller's row-level read permissions, and avoids the join.

---

## Module Tools

### `create_module`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a non-empty array to create several modules in one request. Requires `module_name` and `module_slug`. Optional: `description`, `icon_name`, `domain_code`, `access_scope`, `view_permission`, `logo_url`, `logo_color`, `home_page`, `settings`, `dashboard_config`. See field reference below. |

#### `modules` field reference

| Field | Type | Notes |
|-------|------|-------|
| `module_name` | string | **Unique display name shown in the UI module selector and on the landing page header** (e.g. `CRM`, `ITSM`, `CMDB`). Keep acronyms as acronyms, this is the human-facing name. Required. |
| `module_slug` | string | URL-safe slug, **required and non-empty**. Lowercase letters, digits, `_`, and `-` only (regex `^[a-z0-9_-]+$`; hyphen is now allowed). Used in URLs, permission prefixes, and as the foreign-key target when referenced from semantic-model files. Convention: matches the source model's `system_slug` (e.g. `crm`, `itsm`, `ben-admin`). Accepted: `ben-admin`, `ben_admin`, `bm1`. Rejected: `""`, `Ben-Admin`, `ben admin`. Violations error with `module_slug must be lowercase alphanumeric, underscore, or hyphen`. |
| `description` | string | Compact tagline shown beside `module_name` in the selector dropdown and on the landing page (e.g. `Customer Relationship Management`, `IT Service Management`). For acronym `module_name`s use the plain English expansion; for non-acronyms use a 2-4 word disambiguating phrase. Aim for ≤40 characters. Optional. |
| `icon_name` | string | Name of the icon shown for the module in the UI (an icon-set handle, **not** a URL — distinct from the entity-level `icon_url` and from the module `logo_url`). Optional. |
| `domain_code` | string | Short uppercase business-domain code the module belongs to (e.g. `ATS`, `HCM`, `ITSM`, `CRM`). Groups related modules; many modules — and many `catalog_module_code`s — can share one `domain_code`. Optional. |
| `access_scope` | enum | Access-control scope: `basic` (default) for simple read/edit, or `full` for role tiers, approvals, and lifecycle gating. `enum_values: ["basic", "full"]`, default `basic`. Optional. |
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
| `id` | integer \| integer[] | yes | Module ID, or an array of ids to apply the same `data` to several modules |
| `data` | object | yes | Fields to update (partial — omit a field to leave it unchanged). `module_slug` stays optional here, but **when provided** it must be non-empty and match `^[a-z0-9_-]+$` (hyphen now allowed); same error as `create_module` on violation. |

### `delete_module`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | ⚠️ Check all dependent entities first. An array deletes several modules in one request. |

---

## Permission Tools

### `create_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a **non-empty array** to create several permissions in one request (a new module's `<slug>:read` + `<slug>:manage` go in one call). Each requires: `permission_name` (format: `<module>:<action>`), `description`, `module_id` |

### `read_permission`
Accepts common read parameters. Key filter: `"permission_name=ilike.<module>:*"` to find a module's permissions.

### `update_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Permission ID, or an array of ids to apply the same `data` to several permissions (e.g. converge `module_id` on every drifted row in one call) |
| `data` | object | yes | Fields to update |

### `delete_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | ⚠️ Check roles using this permission first. An array deletes several permissions in one request. |

---

## Permission Hierarchy Tools

### `create_permission_hierarchy`
Creates an inheritance link: a broader permission includes a narrower one. Reads as `including_permission_id` ── *includes* ──▶ `included_permission_id` (e.g. `crm:manage` includes `crm:read`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a **non-empty array** to create every edge of a module's chain in one request. Each requires: `including_permission_id` (broader), `included_permission_id` (narrower). `id` is auto-generated as `"<including_permission_id>.<included_permission_id>"`. |

### `read_permission_hierarchy`
Accepts common read parameters. Filter by `including_permission_id` or `included_permission_id`.

### `update_permission_hierarchy`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | Hierarchy record ID (`"<including_permission_id>.<included_permission_id>"`), or an array of ids (same `data` for all) |
| `data` | object | yes | Fields to update (`including_permission_id`, `included_permission_id`). `origin` is immutable. |

### `delete_permission_hierarchy`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | Hierarchy record ID (`"<including_permission_id>.<included_permission_id>"`), or an array of ids to delete several edges in one request |

---

## Role Tools

### `create_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a **non-empty array** to create several roles in one request (a module's viewer + manager [+ admin] go in one call). Each requires: `role_name`. Strongly recommended for a scaffold role: `slug` (snake_case `^[a-z0-9_]+$`; auto-derived from `role_name` when omitted — pass it explicitly to control the handle), `module_id` (owning module; omit and the role is an orphan), `origin` (`"model"` for a domain-module scaffold role, `"model_master"` for a master; omit and it defaults to `"user"`). Optional: `description`. **There is no `name` or `label` field** — use `role_name` / `slug`. |

### `read_role`
Accepts common read parameters.

### `update_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Role ID, or an array of ids to apply the same `data` to several roles |
| `data` | object | yes | Fields to update |

### `delete_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | ⚠️ Check user_role assignments first. An array deletes several roles in one request (`{"id": [4, 5, 6]}`). |

---

## Role Permission Tools

### `create_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a **non-empty array** to grant several permissions (or several roles) in one request — all `role_permission` rows of a role go in one call. Each requires: `role_id`, `permission_id` |

### `read_role_permission`
Accepts common read parameters. Key filters: `"role_id=eq.<id>"` or `"permission_id=eq.<id>"`.

### `update_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | Role permission record ID, or an array of ids (same `data` for all) |
| `data` | object | yes | Fields to update |

### `delete_role_permission`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | Role permission record ID, or an array of ids to revoke several grants in one request |

---

## User Tools

### `create_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | User fields (email, name, etc.) — one object, or a non-empty array to create several users in one request |

### `read_user`
Accepts common read parameters. Key filter: `"email=eq.user@example.com"`.

### `update_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | User ID, or an array of ids to apply the same `data` to several users (e.g. `is_disabled: true`) |
| `data` | object | yes | Fields to update |

### `delete_user`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | ⚠️ Permanent. Consider soft-delete instead. An array deletes several users in one request. |

---

## User Role Tools

### `create_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a **non-empty array** to assign several users (or several roles) in one request. Each requires: `user_id`, `role_id` |

### `read_user_role`
Accepts common read parameters. Filter by `user_id` or `role_id`.

### `update_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | User role record ID, or an array of ids (same `data` for all) |
| `data` | object | yes | Fields to update |

### `delete_user_role`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string \| string[] | yes | User role record ID, or an array of ids to remove several assignments in one request |

---

## Webhook Receiver Tools

### `create_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | One object, or a non-empty array to create several receivers in one request. Each requires: `label`, `table_name`, `auth_type` (`"hmac"`), `secret` (random alphanumeric string) |

### `read_webhook_receiver`
Accepts common read parameters. Key filter: `"label=eq.Agent Import&table_name=eq.<table>"`.

### `update_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Receiver ID, or an array of ids (same `data` for all) |
| `data` | object | yes | Fields to update |

### `delete_webhook_receiver`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Receiver ID, or an array of ids |

---

## Webhook Receiver Log Tools

### `create_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object \| object[] | yes | Log entry fields — one object, or a non-empty array |

### `read_webhook_receiver_log`
Accepts common read parameters. Key filter: `"receiver_id=eq.<id>"`. Use `"order": "created_at.desc"` to see recent calls.

### `update_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Log record ID, or an array of ids (same `data` for all) |
| `data` | object | yes | Fields to update |

### `delete_webhook_receiver_log`
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer \| integer[] | yes | Log record ID, or an array of ids to delete several log rows in one request |
