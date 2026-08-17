---
name: use-semantius
description: >-
  Use this skill for anything involving the Semantius platform via the semantius CLI. us1-9d4f2a7b   Trigger when the user wants to: create, read, update, or delete entities,
  fields, modules, permissions, roles, users, or business records; build or query
  a semantic data model; set up RBAC; insert or import data into Semantius
  tables; run analytical queries across Semantius data; get a web UI link
  (deep link) to a record, list, or module; or send transactional emails via
  the Semantius email service (`crud sendEmail`). Also trigger when
  writing shell scripts or Bun scripts that chain semantius commands.
---

# use-semantius Skill


**Semantius** is a low-code platform that lets you define a semantic data model, entities, fields, relationships, and access rules, and instantly get a fully managed PostgreSQL database with a REST API, auto-generated UI, and an analytics layer behind it. You define *what* your data looks like (Layer 1), and Semantius handles storage, querying (Layer 2), and cross-table analytics (Layer 3).

`semantius` is the official CLI that gives shell and agent access to two servers: `crud` (schema management + record operations) and `cube` (CubeJS-compatible analytics).

---

## Architecture: Three Distinct Layers

Understanding which layer you're working with determines which tools to use:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Semantic Data Model                               │
│  Defines entities, fields, modules, relationships, RBAC     │
│  Tables: entities, fields, modules, permissions, roles...   │
│  Tools: create_entity, create_field, create_permission...   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Business Data (PostgreSQL via PostgREST)          │
│  Actual records in your entity tables: /products, /orders   │
│  Tools: postgrestRequest (GET/POST/PATCH/DELETE)            │
│         sqlToRest for SQL→PostgREST conversion              │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Analytics (CubeJS-compatible API)                 │
│  Multi-table queries, aggregations, metrics, time-series    │
│  Tools: cube discover → validate → load / chart             │
└─────────────────────────────────────────────────────────────┘
```

**Rule of thumb:**
- Defining *what exists* (schema, permissions, roles) → **Layer 1 typed tools**
- Working with *actual records* in a single table → **Layer 2 postgrestRequest**
- Querying *across tables* or needing *aggregations/metrics* → **Layer 3 cube**

---

## Reference Files

| File | When to read |
|------|-------------|
| `references/cli-usage.md` | CLI commands, shell patterns, chaining, installation |
| `references/data-modeling.md` | Layer 1, entities, fields, modules, relationships, safe evolution |
| `references/jsonlogic.md` | Layer 1, JsonLogic rules: `computed_fields`, `validation_rules`, extension operators, cross-entity lookups, dynamic `input_type_rule` (conditional readonly/hidden/required) |
| `references/select-rule.md` | Layer 1, row-level security: `select_rule`, who sees which rows, REPLACE-vs-AND semantics, admin-lockout risk |
| `references/rbac.md` | Layer 1, permissions, roles, user assignments, hierarchy |
| `references/crud-tools.md` | Layer 1 typed tools + Layer 2 postgrestRequest/sqlToRest reference; § "Bulk operations" (array `data` / `id`, one call per set of records) |
| `references/cube-queries.md` | Layer 3, CubeJS query DSL, date filtering, analysis modes |
| `references/cube-tools.md` | Layer 3, discover/validate/load/chart tool signatures |
| `references/webhook-import.md` | Bulk import of records into Layer 2 via signed webhook |

---

## Quick Decision Guide

**Managing schema, create/modify entities, fields, modules?**
→ Layer 1, read `references/data-modeling.md`, follow mandatory creation order

**Computed fields, validation rules, or conditional field behavior (readonly/hidden/required depending on the record)?**
→ Layer 1, read `references/jsonlogic.md`, entity-level and field-level JsonLogic, operators, cross-entity lookups

**Setting up permissions, roles, users?**
→ Layer 1, read `references/rbac.md`

**Restricting which rows a user can see (row-level security via `select_rule`)?**
→ Layer 1, read `references/select-rule.md`. Caution: a non-empty rule REPLACES `view_permission` for reads — a rule without a `has_permission` disjunct locks out admins

**Inserting, reading, updating, or deleting records in a single table?**
→ Layer 2, use `postgrestRequest`, see `references/crud-tools.md`

**Creating, updating, or deleting several records of the same kind (many fields, many permissions, many rows)?**
→ One call, never a loop: an array in `data` for `create_*`, an array in `id` / `table_name` for `update_*` / `delete_*`, an array `body` (uniform keys) for `postgrestRequest` POST. Golden Rule 7 and `references/crud-tools.md` § "Bulk operations"

**Querying across multiple tables, aggregating, trending over time, top-N, metrics?**
→ Layer 3, use `cube`, read `references/cube-queries.md` + `references/cube-tools.md`

**Writing shell scripts or chaining CLI commands?**
→ Read `references/cli-usage.md`

**Importing a CSV file?**
→ The `semantius-importer` skill is the front door: it introspects the file (`utils/get_csvschema`), creates or reuses the entity, and bulk-loads in batches. `references/webhook-import.md` covers the signed-webhook path (external systems pushing rows).

**Sending a transactional email?**
→ Layer 2 utility, use `crud sendEmail`, see `references/crud-tools.md` § "sendEmail"

**A baked recipe (e.g. from a `semantius-skill-maker`-generated skill) hit an unexpected 409/422 and you suspect schema drift?**
→ Live introspect with `read_entity` / `read_field`, see `references/data-modeling.md` § "Runtime schema introspection (live FK / shape lookup)". Do not silently adapt the recipe; abort, surface the drift, recommend regenerating the domain skill.

---

## Environment Setup

**First, verify semantius is installed.** `semantius --version` works on every platform; check that it is on PATH with the form for your shell:

- **Linux / macOS (bash/zsh):** `command -v semantius` — or just `semantius --version`
- **Windows (PowerShell):** `Get-Command semantius -ErrorAction SilentlyContinue` — or just `semantius --version`

If it is not found (POSIX `command not found` / exit code 127, or PowerShell `CommandNotFoundException` / non-zero exit), STOP immediately. Do NOT attempt to run any semantius commands. Instead, tell the user:

> "semantius is not installed. See **https://www.semantius.com/docs/cli/use-semantius/** for what it is and how to install it. Quick install:
> - Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash`
> - Windows (PowerShell): `irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex`"

Do not proceed with any other tasks until the CLI is installed and `semantius --version` returns successfully. After a Windows install, the user may need to open a new terminal so the updated PATH is picked up.

**Then verify environment variables:**

```bash
semantius info
```

If this fails with "Missing required environment variables" or similar error, list what's missing and STOP. Required variables:
- `SEMANTIUS_API_KEY`, your API key
- `SEMANTIUS_ORG`, your organization name

Do not proceed until both are set and `semantius info` returns successfully.

Once verified, set up credentials. Set them for your shell, or (preferred) put them in a `.env` file.

**Linux / macOS (bash/zsh):**
```bash
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name
```

**Windows (PowerShell):**
```powershell
$env:SEMANTIUS_API_KEY = "your-api-key"
$env:SEMANTIUS_ORG = "your-org-name"
```

Or place them in a `.env` file — next to the executable on Windows, or in the current working directory on Linux/macOS:
```
SEMANTIUS_API_KEY=your-api-key
SEMANTIUS_ORG=your-org-name
```

---

## Core CLI Commands

```bash
semantius                              # List all servers and tools
semantius -d                           # List with descriptions
semantius info <server>               # Show tools for a server
semantius info <server> <tool>        # Get tool JSON schema
semantius grep "<pattern>"            # Search tools by glob
semantius call <server> <tool> '{}'   # Call tool with inline JSON
semantius call <server> <tool>        # Call tool — reads JSON from stdin
```

**Windows (PowerShell): always pass inline JSON, or pipe empty input if the tool takes no arguments.** Omitting the JSON argument makes the CLI block reading stdin until EOF. In a persistent PowerShell session (state kept alive across calls, as an agent harness typically does) that stdin pipe is never closed, so the call hangs forever with no error and no timeout — it is not a network or auth issue, and retrying will not help. Always supply the JSON explicitly, even if empty:

```powershell
semantius call crud getCurrentUser '{}'     # inline JSON, never blocks
"" | semantius call crud getCurrentUser     # or explicitly pipe stdin closed
```

Never invoke a no-argument `semantius call ...` bare on Windows/PowerShell without one of the two forms above.

Both `info <server> <tool>` and `info <server>/<tool>` work interchangeably.

---

## The Two Servers

### `crud`: Schema Management + Record Operations (Layers 1 & 2)

**Layer 1 typed tools** manage the semantic data model: `create_entity`, `create_field`, `create_module`, `create_permission`, `create_role`, etc. These operate on Semantius's own schema tables. Every `create_*` takes `data` as one object **or an array of objects** (several fields, permissions, roles in one call), and every `update_*` / `delete_*` takes `id` (or `table_name` for entities) as one value **or an array**.

**Layer 2 `postgrestRequest`** operates on your actual business data. Any entity you define becomes a PostgreSQL table accessible via PostgREST:
```bash
# Read records from your 'products' entity
semantius call crud postgrestRequest '{"method":"GET","path":"/products?status=eq.active&order=name.asc"}'

# Insert a new order record
semantius call crud postgrestRequest '{"method":"POST","path":"/orders","body":{"customer_id":"123","total":99.99}}'

# Insert several records in ONE call — array body; every row carries the same keys (raw PostgREST rule)
semantius call crud postgrestRequest '{"method":"POST","path":"/orders","body":[{"customer_id":"123","total":99.99},{"customer_id":"124","total":15.00}]}'

# Update matching records
semantius call crud postgrestRequest '{"method":"PATCH","path":"/products?category=eq.electronics","body":{"on_sale":true}}'
```

Full reference: `references/crud-tools.md`

### `cube`: CubeJS-Compatible Analytics (Layer 3)

The cube server implements a **CubeJS-compatible API**. If you know CubeJS, the query DSL is the same. Use it for anything requiring joins, aggregations, or metrics that PostgREST alone cannot express efficiently.

**Always call `discover` first**, it returns the schema, the complete query language reference, and the date filtering guide.

Full reference: `references/cube-queries.md`, `references/cube-tools.md`

---

## Linking to the web UI

Any time you want to point the user at a record or list in the Semantius web app — after a create, after a lookup, when reporting query results, whenever a clickable link beats raw JSON — build it from `getCurrentUser`'s `ui_baseurl`. This is **independent of schema work**: it applies to Layer 2 record operations just as much as to Layer 1 schema changes.

- List of records for an entity: `{ui_baseurl}/{module_slug}/{table_name}`
- A specific record: `{ui_baseurl}/{module_slug}/{table_name}/{id}`

Example: `https://mytest.semantius.app/it-ops-starter/service_requests/5`

- **Derive `ui_baseurl` from `getCurrentUser`** (`semantius call crud getCurrentUser '{}'`) — never hardcode the org host.
- **Use the lowercase `module_slug`** in the path, never the display `module_name`.

Full detail: `references/crud-tools.md` § `getCurrentUser`.

---

## Golden Rules

1. **Read before writing**, Before any `create_*`, call `read_*` to check for duplicates. ALWAYS first.
   - Before `create_module` → run `read_module` first
   - Before `create_entity` → run `read_entity` first
   - Before `create_permission` → run `read_permission` first
   - Before `create_role` → run `read_role` first
   - If the read returns results, use those IDs instead of creating duplicates. Only create if it returns empty.
   - For a bulk create, **one** `read_*` with an `in.(...)` filter covers every item (`"filters": "field_name=in.(description,cost)&table_name=eq.services"`); never one `--single` read per record.
2. **Schema first**, Module → Permissions → **all** Entities → Fields. Never skip steps, and create every entity of a model before any of its fields, so each field's `reference_table` (self-references included) already exists.
3. **Never create auto-generated fields**, `id`, `label`, `created_at`, `updated_at`, and the `label_column` field are created automatically by `create_entity`.
4. **`reference_table` mandates relational format**, Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. No exceptions.
5. **Warn before risky changes**, Renaming `table_name`/`field_name`, deleting entities/fields requires explicit user confirmation.
6. **Surface a UI link whenever it helps the user**, after schema changes *and* after record operations (create / find / update). Pattern: `{ui_baseurl}/{module_slug}/{table_name}`, append `/{id}` for one record. See "Linking to the web UI" above for the rules (derive `ui_baseurl` from `getCurrentUser`; use the lowercase `module_slug`).
7. **Always batch: one call per set of records, never a loop of single calls.** Whenever more than one record of the same kind is pending (several fields for an entity, several permissions for a module, several `role_permission` rows, several ids to update or delete, several rows for a table), send them **in one call**: pass an array in `data` to `create_*` (`'{"data": [{...}, {...}]}'`), or an array in `id` (`table_name` for entities) to `update_*` / `delete_*` (`'{"id": [4, 5, 6]}'`, the same `data` applied to every id). Array items do **not** need the same keys (a key omitted from one item takes the column default). One call is one request and one transaction (all-or-nothing); the response is always an array of the affected records. Keep a call to roughly 100 rows / ids. Issuing N single-record calls where one array call would do is a mistake. `postgrestRequest` also takes an array `body`, but under raw PostgREST rules (identical keys per item, or `?columns=` on the path with omitted keys becoming NULL). See `references/crud-tools.md` § "Bulk operations".

## Response handling: exit code is not enough

The `crud` server returns a JSON array by default, even for queries
that match exactly one row. A `GET` that finds zero rows returns
exit **0** with body `[]`. That is success at the protocol layer
and "not found" at the domain layer. Treating exit code alone as
the success signal silently passes empty results downstream and
corrupts every dependent write.

**This applies to every `crud` tool, not just `postgrestRequest`.**
The typed Layer-1 tools return arrays too: `read_entity`,
`read_module`, and the **`create_*` / `update_*` / `delete_*`** tools all
emit `[{...}]`, not a bare object — and a bulk call (array `data`, array
`id`) emits every affected record in that array. So `jq -r '.id'` on a
`create_role` response fails with `Cannot index array with string` —
index the array: `jq -r '.[0].id'`, or pass `--single` to get a bare
object (single-record calls only; `--single` is rejected when `data` /
`body` / `id` / `table_name` is an array). Better still, do **not** read
a new row's `id` off its own create response at all: the echoed
representation is not a dependable carrier of the id/natural key.
Re-read by natural key after the create (the modeler's `ensure` /
`ensureMany` helpers do exactly this — one `in.(...)` read for a whole
batch), so the array-vs-object shape never reaches your `jq`.

There are **two ways** to read against `crud`. Pick the one that
matches the intent of the call:

### Pattern A: `--single`, when you expect exactly one row

Pass `--single` to `postgrestRequest` for any read that **must**
resolve to exactly one row (lookup by `id`, by a unique column, or
by a composite key the recipe has already proven unique). The CLI
sets PostgREST's `Accept: application/vnd.pgrst.object+json` header
under the hood and translates the response to the agent's shell
contract:

| Outcome | Exit | stdout |
|---|---|---|
| Exactly one row | 0 | `{"id":"...", ...}` (bare object, **not** an array) |
| Zero rows | 1 | error on stderr |
| Two or more rows | 2 | error on stderr |
| Bad args / config / JSON | 1 | error message on stderr |
| Network / transport (transient, retryable) | 3 | error message on stderr |
| Tool execution failed (RLS, dup key, schema) | 4 | error message on stderr |
| Auth failure (missing/invalid API key, 401, 403) | 5 | error message on stderr |

Note that exit `1` covers two distinct cases — "zero rows" and "bad
args". For a well-formed script in steady-state, only the zero-rows
meaning fires at runtime, so the canonical guard ("not found or
ambiguous") is unambiguous; a bad-args 1 indicates a recipe bug and
should never reach end users.

Exit `3` and `5` are split deliberately: `3` is transient (retry
once or twice), `5` is permanent (surface to the user immediately so
they can fix credentials). A recipe that branches on these can do
`case $? in 3) retry ;; 5) abort ;; esac` without parsing stderr.

The exit code now carries the not-found case directly. The
canonical script pattern collapses to one guard:

```bash
row=$(semantius call crud postgrestRequest --single "{\"method\":\"GET\",\"path\":\"/<table>?<unique-filter>\"}") \
  || { echo "step N: <entity> '<value>' not found or ambiguous" >&2; exit 1; }
# $row is the bare object: {"id":"...", ...}
# Parse with jq '.id' or grep -oE '"id":"[^"]+"' (no head -n1, no [0] index).
```

`--single` is the right pattern for the vast majority of reads in a
domain skill: every "look up by `id`", every `eq.<unique-column>`
resolution, every parent-row read in a junction recipe. Use it
whenever a zero-row or many-row result would be a domain error, not
a normal branch.

### Pattern B: array (default), when zero or many rows is expected

Drop `--single` for reads where the count itself is the answer:
dedupe checks ("does this junction row already exist?"), list
queries, batch reads. In that case the response is an array and
the agent has to inspect the body to know what came back.

| Outcome | Exit | stdout | What to do |
|---|---|---|---|
| Row(s) found | 0 | `[{...}, ...]` | Use the row(s) |
| No rows found | 0 | `[]` | The dedupe/list answer is "none"; act accordingly |
| Bad args / config / JSON | 1 | error message on stderr | Fix args; do not retry |
| Network / transport (transient) | 3 | error message on stderr | Retry once or twice, then surface |
| Tool execution failed (RLS, dup key, schema) | 4 | error message on stderr | Surface to user; usually a real bug or a write conflict |
| Auth failure (missing/invalid API key, 401, 403) | 5 | error message on stderr | Abort and surface to user; do not retry |

The canonical pattern for an array read whose business
interpretation depends on emptiness:

```bash
rows=$(semantius call crud postgrestRequest "{\"method\":\"GET\",\"path\":\"/<table>?<filter>&select=id\"}") \
  || { echo "step N (<what>) failed" >&2; exit 2; }
if ! printf '%s' "$rows" | grep -q '"id"'; then
  # zero rows, the recipe's "go ahead and create / no duplicate" branch
  ...
else
  # one or more rows, the recipe's "already exists / use existing" branch
  ...
fi
```

### Choosing between them

| Read intent | Pattern |
|---|---|
| Resolve `<title>` to a feature row | `--single` (the title must exist or the recipe cannot proceed) |
| Read a parent row by `id` | `--single` |
| Check whether a `(feature_id, user_id)` junction row exists | array (zero rows is the normal "create" branch) |
| List all features in a status | array |
| Verify a write took effect | `--single` (the row must exist; we just wrote it) |
| Check that a sweep is complete (zero residual rows) | array (you're counting rows, not asserting one) |

### Writes (POST / PATCH / DELETE)

A `POST` or `PATCH` that succeeds returns the inserted/updated rows
(or `[]` if `Prefer: return=minimal` was set, but the platform does
not set that by default). A `DELETE` returns the deleted rows. So
the same "exit 0 + `[]` means did-nothing" rule applies to writes
that match zero rows: a PATCH with a filter that hits no rows
succeeds silently. `--single` works on single-record writes too
(POST/PATCH that must affect exactly one row), and is the cleanest
way to assert the change took effect. Always read back to verify
when the operation is supposed to change state.

**Bulk writes answer with an array, never with `--single`.** A
`create_*` with an array `data`, an `update_*` / `delete_*` with an
array `id` (or `table_name`), or a `postgrestRequest` with an array
`body` always returns the array of affected records — one element
per row that landed. The CLI **rejects `--single` on such a call
before sending it** (exit `1`, `SINGLE_ARRAY_INPUT`); on older CLIs
the server refuses the `application/vnd.pgrst.object+json` Accept
header for a multi-row result. Never pass an explicit
`"accept": "application/vnd.pgrst.object+json"` with an array
either. Assert a bulk write by its count (`jq 'length'` equals the
number of rows sent) or by a follow-up `read_*` with an `in.(...)`
filter. A bulk call is one transaction: if it fails, nothing from it
landed — fix the cause and re-issue the one call; do not fall back
to a loop of single-record calls.
