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

**Semantius** is a low-code platform that lets you define a semantic data model — entities, fields, relationships, and access rules — and instantly get a fully managed PostgreSQL database with a REST API, auto-generated UI, and an analytics layer behind it. You define *what* your data looks like (Layer 1), and Semantius handles storage, querying (Layer 2), and cross-table analytics (Layer 3).

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
| `references/data-modeling.md` | Layer 1 — entities, fields, modules, relationships, safe evolution |
| `references/rbac.md` | Layer 1 — permissions, roles, user assignments, hierarchy |
| `references/crud-tools.md` | Layer 1 typed tools + Layer 2 postgrestRequest/sqlToRest reference |
| `references/cube-queries.md` | Layer 3 — CubeJS query DSL, date filtering, analysis modes |
| `references/cube-tools.md` | Layer 3 — discover/validate/load/chart tool signatures |
| `references/webhook-import.md` | Bulk import of records into Layer 2 via signed webhook |

---

## Quick Decision Guide

**Managing schema — create/modify entities, fields, modules?**
→ Layer 1 — read `references/data-modeling.md`, follow mandatory creation order

**Setting up permissions, roles, users?**
→ Layer 1 — read `references/rbac.md`

**Inserting, reading, updating, or deleting records in a single table?**
→ Layer 2 — use `postgrestRequest` — see `references/crud-tools.md`

**Querying across multiple tables, aggregating, trending over time, top-N, metrics?**
→ Layer 3 — use `cube` — read `references/cube-queries.md` + `references/cube-tools.md`

**Writing shell scripts or chaining CLI commands?**
→ Read `references/cli-usage.md`

**Importing a CSV or Excel file?**
→ Read `references/webhook-import.md`

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
- `SEMANTIUS_API_KEY` — your API key
- `SEMANTIUS_ORG` — your organization name

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

### `crud` — Schema Management + Record Operations (Layers 1 & 2)

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

### `cube` — CubeJS-Compatible Analytics (Layer 3)

The cube server implements a **CubeJS-compatible API**. If you know CubeJS, the query DSL is the same. Use it for anything requiring joins, aggregations, or metrics that PostgREST alone cannot express efficiently.

**Always call `discover` first** — it returns the schema, the complete query language reference, and the date filtering guide.

Full reference: `references/cube-queries.md`, `references/cube-tools.md`

---

## Golden Rules

1. **Read before writing** — Before any `create_*`, call `read_*` to check for duplicates. ALWAYS first.
   - Before `create_module` → run `read_module` first
   - Before `create_entity` → run `read_entity` first
   - Before `create_permission` → run `read_permission` first
   - Before `create_role` → run `read_role` first
   - If the read returns results, use those IDs instead of creating duplicates. Only create if it returns empty.
2. **Schema first** — Module → Permissions → Entity → Fields. Never skip steps.
3. **Never create auto-generated fields** — `id`, `label`, `created_at`, `updated_at`, and the `label_column` field are created automatically by `create_entity`.
4. **`reference_table` mandates relational format** — Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. No exceptions.
5. **Warn before risky changes** — Renaming `table_name`/`field_name`, deleting entities/fields requires explicit user confirmation.
6. **Link after schema changes** — Provide the UI link: `https://tests.semantius.app/{module_name}/{table_name}`
