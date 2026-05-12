---
name: use-semantius
description: >-
  Use this skill for anything involving the Semantius platform via the semantius CLI.
  Trigger when the user wants to: create, read, update, or delete entities,
  fields, modules, permissions, roles, users, or business records; build or query
  a semantic data model; set up RBAC; insert or import data into Semantius
  tables; or run analytical queries across Semantius data. Also trigger when
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
| `references/rbac.md` | Layer 1, permissions, roles, user assignments, hierarchy |
| `references/crud-tools.md` | Layer 1 typed tools + Layer 2 postgrestRequest/sqlToRest reference |
| `references/cube-queries.md` | Layer 3, CubeJS query DSL, date filtering, analysis modes |
| `references/cube-tools.md` | Layer 3, discover/validate/load/chart tool signatures |
| `references/webhook-import.md` | Bulk import of records into Layer 2 via signed webhook |

---

## Quick Decision Guide

**Managing schema, create/modify entities, fields, modules?**
→ Layer 1, read `references/data-modeling.md`, follow mandatory creation order

**Setting up permissions, roles, users?**
→ Layer 1, read `references/rbac.md`

**Inserting, reading, updating, or deleting records in a single table?**
→ Layer 2, use `postgrestRequest`, see `references/crud-tools.md`

**Querying across multiple tables, aggregating, trending over time, top-N, metrics?**
→ Layer 3, use `cube`, read `references/cube-queries.md` + `references/cube-tools.md`

**Writing shell scripts or chaining CLI commands?**
→ Read `references/cli-usage.md`

**Importing a CSV or Excel file?**
→ Read `references/webhook-import.md`

**A baked recipe (e.g. from a `semantius-skill-maker`-generated skill) hit an unexpected 409/422 and you suspect schema drift?**
→ Live introspect with `read_entity` / `read_field`, see `references/data-modeling.md` § "Runtime schema introspection (live FK / shape lookup)". Do not silently adapt the recipe; abort, surface the drift, recommend regenerating the domain skill.

---

## Environment Setup

**First, verify semantius is installed:**

```bash
semantius --version
```

If this command fails (command not found, exit code 127), STOP immediately. Do NOT attempt to run any semantius commands. Instead, tell the user:

> "semantius is not installed. Please install it first:
> - Linux/macOS: curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
> - Windows: Run PowerShell as admin and run: irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex"

Do not proceed with any other tasks until the CLI is installed and `semantius --version` returns successfully.

**Then verify environment variables:**

```bash
semantius info
```

If this fails with "Missing required environment variables" or similar error, list what's missing and STOP. Required variables:
- `SEMANTIUS_API_KEY`, your API key
- `SEMANTIUS_ORG`, your organization name

Do not proceed until both are set and `semantius info` returns successfully.

Once verified, set up credentials:

```bash
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name
```

Or place in a `.env` file next to the executable (Windows) or in the current directory (Linux/macOS).

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

Both `info <server> <tool>` and `info <server>/<tool>` work interchangeably.

---

## The Two Servers

### `crud`: Schema Management + Record Operations (Layers 1 & 2)

**Layer 1 typed tools** manage the semantic data model: `create_entity`, `create_field`, `create_module`, `create_permission`, `create_role`, etc. These operate on Semantius's own schema tables.

**Layer 2 `postgrestRequest`** operates on your actual business data. Any entity you define becomes a PostgreSQL table accessible via PostgREST:
```bash
# Read records from your 'products' entity
semantius call crud postgrestRequest '{"method":"GET","path":"/products?status=eq.active&order=name.asc"}'

# Insert a new order record
semantius call crud postgrestRequest '{"method":"POST","path":"/orders","body":{"customer_id":"123","total":99.99}}'

# Update matching records
semantius call crud postgrestRequest '{"method":"PATCH","path":"/products?category=eq.electronics","body":{"on_sale":true}}'
```

Full reference: `references/crud-tools.md`

### `cube`: CubeJS-Compatible Analytics (Layer 3)

The cube server implements a **CubeJS-compatible API**. If you know CubeJS, the query DSL is the same. Use it for anything requiring joins, aggregations, or metrics that PostgREST alone cannot express efficiently.

**Always call `discover` first**, it returns the schema, the complete query language reference, and the date filtering guide.

Full reference: `references/cube-queries.md`, `references/cube-tools.md`

---

## Golden Rules

1. **Read before writing**, Before any `create_*`, call `read_*` to check for duplicates. ALWAYS first.
   - Before `create_module` → run `read_module` first
   - Before `create_entity` → run `read_entity` first
   - Before `create_permission` → run `read_permission` first
   - Before `create_role` → run `read_role` first
   - If the read returns results, use those IDs instead of creating duplicates. Only create if it returns empty.
2. **Schema first**, Module → Permissions → Entity → Fields. Never skip steps.
3. **Never create auto-generated fields**, `id`, `label`, `created_at`, `updated_at`, and the `label_column` field are created automatically by `create_entity`.
4. **`reference_table` mandates relational format**, Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. No exceptions.
5. **Warn before risky changes**, Renaming `table_name`/`field_name`, deleting entities/fields requires explicit user confirmation.
6. **Link after schema changes**, Provide the UI link: `https://tests.semantius.app/{module_slug}/{table_name}` (URLs use the lowercase `module_slug`, not the display `module_name`).

## Response handling: exit code is not enough

The `crud` server returns a JSON array by default, even for queries
that match exactly one row. A `GET` that finds zero rows returns
exit **0** with body `[]`. That is success at the protocol layer
and "not found" at the domain layer. Treating exit code alone as
the success signal silently passes empty results downstream and
corrupts every dependent write.

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
succeeds silently. `--single` works on writes too (POST/PATCH that
must affect exactly one row), and is the cleanest way to assert
the change took effect. Always read back to verify when the
operation is supposed to change state.
