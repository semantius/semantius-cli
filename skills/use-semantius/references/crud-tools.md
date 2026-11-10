# Semantius CRUD Tool Reference

The `crud` server covers two distinct purposes. Understanding which you need determines which tools to use:

## Layer 1: Schema Management Tools (typed tools)

The typed tools (`create_entity`, `read_field`, `update_role`, etc.) manage Semantius's **semantic data model**, the schema definitions stored in Semantius's own system tables (`entities`, `fields`, `modules`, `permissions`, `roles`, `users`, `webhook_receivers`, etc.). Every `create_*` accepts `data` as one object **or a non-empty array of objects**, and every `update_*` / `delete_*` accepts its key (`id`, or `table_name` for entities) as one value **or an array** — see "Bulk operations" below.

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

## Quick reference

Read this before the first call. This file and the other references give the signatures of the documented tools, so run `semantius tools crud <tool>` only for a tool they do not cover, or for one property with the `jq` filter in `cli-usage.md`. `semantius tools crud` lists every tool with its parameters for about 1.8k tokens.

### Required fields when creating (`data`)

A new module, with its permissions and roles, is created by `references/module-rbac-setup.ts` ("Order for a new module" below), not by these tools.

| Tool | Required | Also pass |
|------|----------|-----------|
| `create_module` | `module_name` | `module_slug` |
| `create_permission` | `permission_name`, `module_id` | `description` |
| `create_role` | `role_name` | `slug`, `module_id` |
| `create_entity` | `table_name`, `module_id` | `singular_label` (pass it), `entity_type`, `view_permission`, `edit_permission` |
| `create_field` | `table_name`, `field_name`, `title` | `format`; `reference_table` for a `reference` / `parent` field; `rollup` for an aggregate over a child entity |
| `create_permission_hierarchy` | `including_permission_name`, `included_permission_name` | |
| `create_role_permission` | `role_id`, `permission_name` | |
| `create_user` | `external_id` for a human user (an agent gets one) | `email` (optional) |
| `create_user_role` | `user_id`, `role_id` | |
| `create_webhook_receiver` | `label` | `table_name`, `auth_type` `hmac`, `secret` |
| `create_webhook_receiver_log` | `webhook_receiver_id` | |

### Keys for `update_*` and `delete_*` (one value or a non-empty array)

| Tool family | Parameter | Type | Format |
|-------------|-----------|------|--------|
| entity | `table_name` | string | the table name |
| field | `id` | string | `<table_name>.<field_name>` |
| module, role, user, webhook_receiver, webhook_receiver_log | `id` | integer | read it with `read_*`; a role or user id never comes from a create response |
| permission | `permission_name` | string | the permission name |
| permission_hierarchy | `id` | string | `<including>.<included>` |
| role_permission | `id` | string | `<role_id>.<permission_name>` |
| user_role | `id` | string | `<user_id>.<role_id>` |

### Order for a new module

The order is "Mandatory Creation Order" in `data-modeling.md`; follow it as written. It starts with `bun "<skill-folder>/references/module-rbac-setup.ts" --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name>`, never `create_module`. For a request to build a whole module, read `build-module.md` first: it sets the scope around that order.

### Naming rules

| What | Rule |
|------|------|
| `module_slug` | `^[a-z0-9][a-z0-9_-]*$`; hyphens allowed |
| `permission_name` | `<module_slug>:<action>` by convention; the platform accepts one or more segments `[a-z0-9][a-z0-9_-]*` joined by `:` (so `admin` is valid); no spaces, commas or dots |
| role `slug` | `^[a-z0-9_]+$`; underscores only, so turn the hyphens of a module slug into `_` |
| `field_name` | `^[a-z_][a-z0-9_]*$`; a leading `_` is reserved for generated columns such as `_label` and refused (`90224`) |

### Error to action

| Error | Meaning | Do |
|-------|---------|----|
| `23503` | A foreign key target does not exist | Create it first: base before based entity, permission or role before module wiring |
| `90212` | A field's `reference_table` names no entity | Create the referenced entity first |
| `90260` | Delete refused: a field of another entity references it | `read_field` with `reference_table=eq.<table>`, then delete or repoint those fields |
| `90266` | Delete refused: a rollup uses it | Remove or change the rollup field first |
| `90247` | An `is_a` / `has_a` entity or a base still has records | Delete its records first |
| `90248` | Entities are based on it | `read_entity` with `id_refentity=eq.<table>`, delete those first |
| `90243` | A field name repeats the base's | Create only the entity's own fields |
| `90241`, `90233` | `id_refentity` or `id_type` changed on update (an unchanged value is accepted) | Omit them on update |
| `42703` | The column does not exist | Check the name with `read_field`; a webhook log filters on `webhook_receiver_id` |
| `PGRST102` | A bulk array whose rows have different keys | Give every row the same keys |
| `42P10` | Upsert on an `is_a` / `has_a` entity | Insert, then PATCH |

### Wrong and right

```bash
# WRONG: one call per field
semantius call crud create_field '{"data": {"table_name": "orders", "field_name": "total", "title": "Total", "format": "number"}}'
semantius call crud create_field '{"data": {"table_name": "orders", "field_name": "note", "title": "Note", "format": "text"}}'
# RIGHT: one call, an array
semantius call crud create_field '{"data": [{"table_name": "orders", "field_name": "total", "title": "Total", "format": "number"}, {"table_name": "orders", "field_name": "note", "title": "Note", "format": "text"}]}'

# WRONG: delete a module's entities one by one, then the module
# RIGHT: back it up, then one delete_module (it cascades to entities, fields and records)
semantius call crud delete_module '{"id": 12}'

# WRONG: a scalar format with a reference_table
{"field_name": "customer_id", "format": "text", "reference_table": "customers"}
# RIGHT: format reference (or parent)
{"field_name": "customer_id", "format": "reference", "reference_table": "customers"}
```

---

## Utility Tools

### `getCurrentUser`
Returns the current user's profile, email, roles, effective permissions, and accessible modules. No parameters required, call with `'{}'`. The three base values below are added only when the call succeeds, and `api_baseurl` and `ui_baseurl` can be `null` when the host or the org cannot be determined.

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
| `method` | string | yes | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | string | yes | PostgREST path: `/table_name` optionally followed by `?filters&select&order&limit&offset` |
| `body` | object \| object[] | no | Request body for POST/PUT/PATCH requests. One object, or an **array of objects for a bulk insert** — under raw PostgREST rules: every item must carry the same keys, unless the path adds `?columns=col1,col2` (then keys omitted from an item become **NULL**, not the column default; this tool has no `prefer` input, so `missing=default` is unavailable). For bulk writes to the catalog tables use the typed `create_*` / `update_*` / `delete_*` tools, which handle mixed keys for you. |
| `accept` | string | no | Accept header forwarded to PostgREST (`application/vnd.pgrst.object+json` for exactly one row, `text/csv`). `text/csv` works only with `semantius call --stream`; a plain call fails with a JSON parse error. Never combine the object+json Accept with an array `body`. |

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

**Records of an `is_a` / `has_a` entity** are read and written at the entity's own path, which carries the whole record (the base's fields and its own). A read of the base also lists its subtypes' records. Enum fields hold the value, never the label. Never upsert these entities: `on_conflict`, `resolution=merge-duplicates` and `PUT` fail with `42P10`, so insert, then `PATCH`. See `data-modeling.md` → "Enum values and labels" and `entity-families.md` → "Writing".

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

It only translates: it returns `{method, path}` and runs nothing. Pass the result to `postgrestRequest` to execute it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | yes | SQL query to convert, e.g. `SELECT * FROM products WHERE status = 'active' ORDER BY name` |

```bash
semantius call crud sqlToRest '{"sql": "SELECT id, name, price FROM products WHERE category = '\''electronics'\'' ORDER BY price DESC LIMIT 10"}'
```

### `refresh_schema_cache`
Forces PostgREST to reload its schema cache. Takes no parameters.
```bash
semantius call crud refresh_schema_cache '{}'
```
> The cache refreshes automatically after structural changes, so do **not** call this routinely after every `create_entity` / `create_field`. Reach for it only when the cache is visibly stale — a just-created entity or field is missing from `postgrestRequest` responses, or PostgREST reports an unknown table/column that you know exists.

### `sendEmail`

Sends a transactional email via the Semantius email service. Provide `text`, `html`, or both. Returns the provider `messageId` on success.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string \| string[] | yes | Recipient address, or array of addresses |
| `subject` | string | yes | Subject line (non-empty) |
| `text` | string | no\* | Plain-text body |
| `html` | string | no\* | HTML body |
| `from` | string | no | Sender address. Defaults to the authenticated user's email. |
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

### Account and API key tools

- `generate_api_key`: `p_user_id` is required. `0` means the caller. Another user's id needs admin. It returns `{api_key, key_id}`; the plaintext key is shown once.
- `list_api_keys`: the keys of the caller (or, as admin, of `p_user_id`), without secrets.
- `delete_api_key`: revokes a key by its public `p_key_id`. It cannot be undone.
- `get_cli_config`: returns CLI setup text and **creates a new API key on every call**, so it is not read-only.
- `get_cli_token`: exchanges the `x-api-key` header for a short-lived JWT; it fails without that header.

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
| `accept` | string | Accept header forwarded to PostgREST, e.g. `application/vnd.pgrst.object+json` for exactly one row |

---

## Bulk operations (all typed `create_*` / `update_*` / `delete_*` tools)

**Rule: if more than one record of the same kind is pending, send them in ONE call. Never loop single-record calls.** One array call is one HTTP request and one database transaction; N single calls are N round trips with partial-failure risk and no atomicity.

- **`create_*`**: `data` is either one object or a **non-empty array of objects**. **Items do not need the same keys** — the server sends the union of keys (`?columns=`) with `Prefer: return=representation,missing=default`, so a key omitted from one item takes the column default (an explicit `null` still inserts NULL). All rows are inserted in one request and one transaction (all-or-nothing). Example: `create_field` with `data: [ {…description}, {…cost} ]`.
- **`update_*`**: `id` is either one value or a **non-empty array of ids** (for `update_entity` the key is `table_name`, for `update_permission` it is `permission_name`); sent as `id=in.(...)`. The **same** `data` is applied to every listed record. For per-record values, call once per record (or use a filter-based `postgrestRequest` PATCH).
- **`delete_*`**: `id` (or `table_name` for entities, `permission_name` for permissions) is either one value or a **non-empty array**; all listed records are deleted in one request.
- **Key types** follow the table: string keys for `field` (`"<table>.<field>"`), `permission_hierarchy` (`"<including>.<included>"`), `role_permission` (`"<role_id>.<permission_name>"`), `user_role` (`"<user_id>.<role_id>"`), entity `table_name`, and permission `permission_name`; integer ids for `module`, `role`, `user`, `webhook_receiver`, `webhook_receiver_log`.
- **Responses** are always an array of the created / updated / deleted records. Never combine an array input with `accept: application/vnd.pgrst.object+json` or the CLI's `--single` (the CLI rejects that before sending: exit 1, `SINGLE_ARRAY_INPUT`).
- **Duplicate checks still apply**: before a bulk `create_*`, run **one** `read_*` with an `in.(...)` filter covering all items (e.g. `"filters": "field_name=in.(description,cost)&table_name=eq.services"`) — never a `--single` read per item (an `in.()` matching several rows exits 2 with `--single`).
- **Failure is all-or-nothing**: a rejected bulk call landed nothing. Quote the platform error (it names the offending row / constraint), fix, re-issue the one call. Do not fall back to a loop of single calls to "find the bad row".
- Keep batches reasonable (roughly up to 100 rows or ids per call); split larger sets into a few calls.
- **Order across kinds still matters**: create every entity of a model (one `create_entity` call) before any of their fields (one `create_field` call for every entity's fields, rollups last in the array), so each field's `reference_table` already exists. With `is_a` / `has_a` entities, one `create_entity` call per level instead, bases first (`entity-families.md`).
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

---

## Composed labels: `_label` and `<fk>_label` (read-only, select by name)

Every entity exposes a read-only **`_label`** — its composed, human-readable label, folded from its parent chain (the identity spine's `_label` ⧺ ` › ` ⧺ the local label). Every `reference`/`parent` FK named `X` exposes a read-only companion **`X_label`** = the referenced row's composed `_label` (e.g. `customer_id` → `customer_id_label`).

- **Select them explicitly by name** — `select=id,_label,customer_id_label`. They are not authored fields (absent from the `fields` catalog; `read_field` never returns them) and are **not** included in `select=*`.
- **Names are deterministic, so no discovery call is needed:** `_label` on the entity, and `<fk>_label` on each `reference`/`parent` FK (the FK field name + `_label`). (`get_schema` is a verbose database function, `POST /rpc/get_schema` with `p_table_name`, not a skill tool — don't use it to find these; a token-optimized tool is planned.)
- **Read-only.** Never `create_field`, write, or import into `_label` / `<fk>_label`; the platform owns them and computes them at read time.

**Displaying a parent's label — prefer `select=X_label` over embedding.** To show a parent's name beside a child row, select the FK companion (`select=id,interview_id_label`) rather than PostgREST resource embedding (`select=id,interviews(label)`). The companion returns the parent's *composed* `_label`, respects the caller's row-level read permissions, and avoids the join.

---

---

## Tool parameters

For the parameters of a tool the references do not cover, run `semantius tools crud <tool>`. It prints the description and the JSON input schema of that one tool.
