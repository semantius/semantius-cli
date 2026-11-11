---
name: use-semantius
description: >-
  Use this skill for anything involving the Semantius platform via the semantius CLI. us1-9d4f2a7b   Trigger when the user wants to: create, read, update, or delete entities,
  fields, modules, permissions, roles, users, or business records; build or set up
  something new that needs its own records, however it is phrased (a module, app,
  platform, system, tracker, tool, or "a way to see and manage X", e.g. "build my
  SaaS management platform"; adding a field, entity or permission to an existing
  module is not a build); review or audit an existing module, or ask what it is
  missing or how to improve it; build or query
  a semantic data model, including subtypes and extensions of an entity (emails
  and calls as kinds of activities, customers and suppliers as business
  partners) and enum values with labels; set up RBAC; insert or import data into Semantius
  tables; run analytical queries across Semantius data; get a web UI link
  (deep link) to a record, list, or module; or send transactional emails via
  the Semantius email service (`crud sendEmail`). Also trigger when
  writing shell scripts or Bun scripts that chain semantius commands, and on
  any request containing `[blank]` (a sample prompt the user has not filled in,
  e.g. "which fields are in [blank]").
---

# use-semantius Skill


**Semantius** is a low-code platform that lets you define a semantic data model, entities, fields, relationships, and access rules, and instantly get a fully managed PostgreSQL database with a REST API, auto-generated UI, and an analytics layer behind it. You define *what* your data looks like (Layer 1), and Semantius handles storage, querying (Layer 2), and cross-table analytics (Layer 3).

`semantius` is the official CLI that gives shell and agent access to servers. `crud` (schema management + record operations) and the built-in `utils` (CSV introspection, moving entities and modules between hosts) are always available; the plan can add more, such as `cube` (CubeJS-compatible analytics). `semantius` lists the servers the instance has.

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

`<skill-folder>` in a command in this skill is the directory this `SKILL.md` was read from, as an absolute path.

| File | When to read |
|------|-------------|
| `references/cli-usage.md` | CLI commands and their tiers, credentials and hosts, options, shell patterns, chaining, installation; § "Moving Entities and Modules Between Hosts" |
| `references/data-modeling.md` | Layer 1, entities, fields, modules, relationships, safe evolution; § "Enum values and labels" |
| `references/build-module.md` | A request to build or set up something new that needs its own records: the default deliverable, the sample-data question and size, what not to produce unasked, verification, the final response |
| `references/review-module.md` | A request to review, audit or check an existing module, or to say what it is missing: what to read, what to verify, the optional additions, the report, applying what the user picks |
| `references/seed-data.md` | Writing generated rows (the sample data of a build, or any request for made-up records): the seed script, mapping children to parents by label, the checks, values and rows that read as records, clearing what was seeded |
| `references/seed-lib.ts` | Copy it next to the seed script and import it; don't retype it and don't read it, `seed-data.md` lists its functions and shows how: bulk insert, parent lookup by label, relationship read-back, count, distinctness, scale, state-agreement and computed-column guards, a refusal of a key the platform computes, clearing a seed, seeded random generator |
| `references/entity-families.md` | Layer 1, subtypes and extensions (`id_type: is_a` / `has_a`, `id_refentity`): when to use them, create order, reads and writes across levels, limits, deletes, error codes. Read before the first `create_entity` of such an entity |
| `references/jsonlogic.md` | Layer 1, JsonLogic rules: `computed_fields`, `validation_rules`, extension operators, cross-entity lookups, dynamic `input_type_rule` (conditional readonly/hidden/required) |
| `references/rollup-fields.md` | Layer 1, rollup fields: a `sum`, `count`, `min`, `max` or `avg` over child records that the database keeps current; definition keys, filter subset, format fit, hidden child rows, change and removal |
| `references/select-rule.md` | Layer 1, row-level security: `select_rule`, who sees which rows, REPLACE-vs-AND semantics, admin-lockout risk |
| `references/rbac.md` | Layer 1, permissions, roles, user assignments, hierarchy |
| `references/crud-tools.md` | Quick reference for the Layer 1 typed tools (required fields, keys, order, errors), Layer 2 postgrestRequest/sqlToRest reference; § "Bulk operations" (array `data` / `id`, one call per set of records) |
| `references/cube-queries.md` | Layer 3, CubeJS query DSL, date filtering, analysis modes |
| `references/cube-tools.md` | Layer 3, discover/validate/load/chart tool signatures |
| `references/webhooks.md` | Receiving records from external systems through signed webhook receivers: setup, signing, logs |
| `references/call-file.ts` | Run it (`bun`), don't read it: `<tool> <file.json>` sends a JSON file to a `crud` tool with no shell in between, so quotes and non-ASCII text stay intact in every shell; every `create_entity` and `create_field` goes through it; exit codes are the CLI's |
| `references/module-rbac-setup.ts` | Run it (`bun`), don't read it: creates a module with its icon, color, permissions, hierarchy, roles, grants and default roles, never `create_*` calls for those; `--slug <slug>` alone fills what an existing module is missing; see `data-modeling.md` → "Mandatory Creation Order" |
| `references/lucide-icon-finder.ts` | Run it (`bun`), don't read it: `--batch -` takes a JSON object on stdin mapping each label to an array of its queries and answers every label in one call; plain `<query…>` arguments are alternatives for one meaning; see `data-modeling.md` → "Icons are Lucide icons" |
| `references/lucide-icon-checker.ts` | Run it (`bun`), don't read it: `<name…>` confirms Lucide icon names before an icon is written, exit 1 names the unknown ones; see `data-modeling.md` → "Icons are Lucide icons" |
| `references/entity-match-checker.ts` | Run it (`bun`), don't read it: `--batch -` takes a JSON object on stdin mapping each new entity's `table_name` to other words for it, and compares them with the instance's entities and, of the platform's own, `users`; exit 1 names the matches to settle; see "Before any new entity: compare it with the instance" |
| `references/vendor-names.ts` | Run it (`bun`), don't read it: `entity:<Name>…` and `field:<Name>…` convert a product's record and field names (singular, spelled the product's way) into `table_name` and labels, or `field_name` and label, only when the user asks to follow that product's names; never convert them by hand |
| `references/preflight.md` | The environment checks a skill runs before doing work: stay in the repo root, Bun and jq, CLI install and sign-in, and when to read the two question-format files below |
| `references/muse-questions.md`, `references/dot-questions.md` | How to ask questions where `AskUserQuestion` is not available; never read them when it is. `preflight.md` says when to read them |

---

## Quick Decision Guide

**The request contains `[blank]`?**
→ Ask before anything else, see "Unfilled `[blank]` placeholders" below. Run nothing until every blank is filled

**The request lacks a value it needs ("add a field": to which kind of record)?**
→ Ask for it, see "Asking the user to pick a value" below

**About to create a new entity, on any path?**
→ Compare it with every entity on the instance first, see "Before any new entity: compare it with the instance" below. Nothing is created until each match is settled

**Asked to build or set up something new that needs its own records, however it is phrased (a module, app, platform, system, tracker, tool, "a way to see and manage X"; adding a field, entity or permission to an existing module is not a build)?**
→ Read `references/build-module.md`. Follow the leading products when the domain is well known, in the order of a build. Default: module, entities, fields, relationships, permissions, roles and the UI links. Compare the outline with the instance, confirm the entity list, then ask about sample data (5 to 10 rows per parent entity, never seeded without a yes; seeded as `references/seed-data.md` says). No spec, diagram, report, export or analytics unless asked

**Asked to review, audit or check an existing module, or what it is missing or how to improve it?**
→ Read `references/review-module.md`. Read the whole live module, verify it against this skill's rules, suggest optional entities and other additions from the leading products, and report. Nothing is written until the user picks what to apply

**Managing schema, create/modify entities, fields, modules?**
→ Layer 1, read `references/data-modeling.md`, follow mandatory creation order. Every entity you create carries its class (`entity_type`) and the permissions its write tier gives (`references/data-modeling.md` → "Classifying an entity", `references/rbac.md` → "Choosing an entity's permissions")

**Several kinds of one thing ("emails and calls are both activities"), or something a record can also be ("a business partner can also be a customer")?**
→ Layer 1, read `references/entity-families.md` before creating anything: it decides between `is_a`, `has_a`, an enum field and separate entities, and changes the creation order (one `create_entity` call per level, bases first). The choice is locked at creation, so confirm with the user

**Computed fields, validation rules, or conditional field behavior (readonly/hidden/required depending on the record)?**
→ Layer 1, read `references/jsonlogic.md`, entity-level and field-level JsonLogic, operators, cross-entity lookups

**A total, count, minimum, maximum or average over child records (an order's total from its lines, open tickets per customer)?**
→ Layer 1, read `references/rollup-fields.md`. A value aggregated from other records is a rollup field, never a `computed_fields` rule

**Only some users may do one thing to a record (delete it, close it, approve it, change one field)?**
→ Layer 1, read `references/jsonlogic.md` § *Detecting the operation*. An entity's `edit_permission` covers insert, update and delete together, so a gate on one operation or transition is a validation rule that tests `$mode` (or the changed field) and then checks who the caller is: an owner match such as `$old.owner_user_id == $user_id` needs no permission, while `has_permission` needs one, created with `references/rbac.md`

**Setting up permissions, roles, users?**
→ Layer 1, read `references/rbac.md`

**Restricting which rows a user can see (row-level security via `select_rule`)?**
→ Layer 1, read `references/select-rule.md`. Caution: a non-empty rule REPLACES `view_permission` for reads — a rule without a `has_permission` disjunct locks out admins

**Inserting, reading, updating, or deleting records in a single table?**
→ Layer 2, use `postgrestRequest`, see `references/crud-tools.md`

**Creating, updating, or deleting several records of the same kind (many fields, many permissions, many rows)?**
→ One call, never a loop: an array in `data` for `create_*`, an array in `id` / `table_name` for `update_*` / `delete_*`, an array `body` (uniform keys) for `postgrestRequest` POST. Golden Rule 7 and `references/crud-tools.md` § "Bulk operations"

**Adding made-up sample or demo records to tables?**
→ Read `references/seed-data.md`: one seed script on `references/seed-lib.ts`, children mapped to parents by label, never by id or position. Only after an explicit yes to the sample-data question (`references/build-module.md`)

**Querying across multiple tables, aggregating, trending over time, top-N, metrics?**
→ Layer 3, use `cube`, read `references/cube-queries.md` + `references/cube-tools.md`. Answer only the question asked, briefly; an analytics request never changes the schema or creates a module. When nothing matches, say there is no data for it and stop, without offering to build a module

**About to build a script, diagram, document, report or export from the model?**
→ Only when the user asked for that artifact; a build request alone is not one. "Show me the data model", an ERD or a schema picture asks for the diagram. Then find the built-in tool first, see "Find the built-in tool before building" under Core CLI Commands

**Writing shell scripts or chaining CLI commands?**
→ Read `references/cli-usage.md`

**Importing a CSV file?**
→ The `semantius-importer` skill is the front door: it introspects the file (`utils/get_csvschema`), creates or reuses the entity, and bulk-loads in batches.

**Moving entities or a module to another host, backing one up, restoring an export?**
→ The `semantius-transfer` skill runs the workflow; `references/cli-usage.md` § "Moving Entities and Modules Between Hosts" has the mechanics.

**Sending a transactional email?**
→ Layer 2 utility, use `crud sendEmail`, see `references/crud-tools.md` § "sendEmail"

**A baked recipe (e.g. from a `semantius-skill-maker`-generated skill) hit an unexpected 409/422 and you suspect schema drift?**
→ Live introspect with `read_entity` / `read_field`, see `references/data-modeling.md` § "Runtime schema introspection (live FK / shape lookup)". Do not silently adapt the recipe; abort, surface the drift, recommend regenerating the domain skill.

---

## Before any new entity: compare it with the instance

One real-world thing is one entity. A second entity for something the instance already holds splits its records across two tables and is costly to undo, so this section outranks every limit on questions and every no-answer default, on every path that creates an entity. `table_name` identifies an entity across the whole instance, so two modules cannot each have their own `vendors`.

1. **List other words for each new entity**, the words people use for the same thing (vendors: suppliers, providers, merchants). At least one each.
2. **Run the check** before the first `create_entity`. It reads the entities on the instance and compares names, labels and your words. Of the platform's own entities it compares only `users`; the others are never reused:

   ```bash
   echo '{"vendors":["suppliers","providers"],"contracts":["agreements"]}' | bun "<skill-folder>/references/entity-match-checker.ts" --batch -
   ```

   Exit `0` means nothing to settle, exit `1` lists each match, exit `2` is a bad call or an unreadable instance. It can only match the words it was given, so also read the `Existing entities:` line it prints: an entity that means the same thing is a similar name even when the script did not list it.
3. **Settle each match before anything is written**, one question at a time, in the question format the preflight sets:

   | Found | Ask | When the user declines | With no answer |
   |---|---|---|---|
   | Same name | "\<Plural Label\> already exists in \<Module Name\>. Use the existing one?": use it (recommended), or keep a separate one under a different name | The new entity takes a name that states its concept in full | Use the existing one |
   | Reserved name | Nothing: the name is a platform table, and the new entity takes a name that states its concept in full | | |
   | Similar name | "\<Existing Plural Label\> in \<Module Name\> looks like the \<New Plural Label\> you need. Are they the same thing?": yes, use the existing one, or no, they are different | On "different", create the new entity and pass `--separate <table_name>` on the next run | Do not create it; name it as a next step |

   A new entity named `users` is the built-in: it is always reused, with no question. A similar name is asked like any other: `employees` or `contractors` may be the platform's users, or may be separate.
4. **Run the check again** after the answers, with reused and left-out entities removed, and whenever the list changes. No `create_entity` until it exits `0`.
5. **Reusing an entity** means a relationship to it and no new entity. The module's users can view it and cannot edit it (`references/rbac.md` → "Viewing an entity of another module"). When the module needs a field the entity lacks, ask before adding it: one question per entity, naming each field and saying it also appears in the other module. An approved field is added as optional, and a field not approved is named as a next step. No sample rows go into a reused entity.

Never create a renamed or prefixed copy to get past a name clash. A separate entity for the same thing exists only when the user chose it, after hearing that its records will stay apart from the existing ones, and before anything is built. A duplicate-key error on `create_entity` is a match like any other: stop and settle it.

---

## Asking the user to pick a value

Use this for every `[blank]` (next section) and whenever a request lacks a value it needs to run: "add a field" needs the kind of record, "who is the contact for a customer" needs the customer. A value the user gave, now or earlier in the conversation, is not lacking.

1. **Know what you ask for.** The platform's own concepts are built-in tables:

   | The user says | Table |
   |---|---|
   | solution | `modules` |
   | kind of record, record type, table | `entities` |
   | field | `fields` |
   | permission | `permissions` |
   | role | `roles` |
   | user, person | `users` |
   | webhook | `webhook_receivers` |
   | dashboard | `dashboards` |
   | process | `processes` |
   | queue | `queues` |
   | audit log | `audit_record_logs` |

   A word naming one of the instance's own kinds of record ("task", "project", "customer") asks for one record of that kind; match the word by meaning against the entities' labels.
2. **Read 21, show 20.** Read the candidates with a limit of 21, sorted alphabetically by display label: a module's `module_name`, an entity's `plural_label`, a field's `title`, a permission's or role's `description`, a user's `display_name`, a record's `label`. Never show a `table_name`, slug, `module:action` name or id. Start the question by naming what it asks for, then give the names on one line, separated by commas, never as a bulleted list: "Which project? Apollo, Bluebird, Cascade, Delta Rollout."
   - **20 or fewer came back:** the list is complete. Show them all.
   - **21 came back:** there are more. Show the first 20, end the line with "and more", then ask for words to search the rest, with examples that fit what is asked: for a record, part of its name or another detail of it ("Not in the list? Tell me part of the name, a city or a country."); for a kind of record, what it is about ("Not in the list? Tell me what it's about, for example orders or staff.").
3. **Search by meaning.** Turn the user's words into search words: the words themselves, their synonyms and related terms ("staff" → staff, employee, personnel, user). Run a full-text search for each on the whole table (`search_vector=wfts(simple).<word>`, `references/crud-tools.md`); on a table without searchable fields, use `ilike` on the display label instead. Show the matches the same way, on one line, and give a name that repeats its record type in brackets ("Status (Orders)"). Nothing found: say so and ask for other words.
4. **Never pick for the user.** Never ask "do you mean X?" about a candidate you picked yourself, and never hint which one fits. A value the request creates (the name of a new field or permission) is free text: ask for it once its container is known.
5. **Ask in plain words, in the chat.** "Which solution?", "Which kind of record?", "What should the new field be called?" Never use internal terms such as entity, table or module. One question per value; wait for the reply.

---

## Unfilled `[blank]` placeholders

The plugin's sample prompts use `[blank]` where the user puts a name from the live instance ("which fields are in [blank]", "add permission [blank] to solution [blank]"). The token `[blank]`, in any case, is a blank the user did not fill.

1. **Never fill it yourself.** Do not guess it from context, even when only one candidate fits. Do not put it in a `semantius` command. Run nothing until every blank is filled. The only calls allowed before then are the reads and searches that find the candidates.
2. **Work out each blank's kind from the word next to it**, with the table in "Asking the user to pick a value" ("solution [blank]", "field [blank]", "customer [blank]"). Any other blank ("fields in [blank]", "how many [blank]", "states of [blank]") is a kind of record (`entities`).
3. **Ask in the order of the request.** When the request has a solution blank and another blank in it ("add permission [blank] to solution [blank]"), ask about the solution first; the answer filters the next list. Never add a question the request does not contain.
4. **Ask for each blank** as "Asking the user to pick a value" describes. A blank the request creates ("add permission [blank]") is a new name.
5. **Then run it.** Once every blank is filled, restate the full request in one line ("Adding the permission Close tickets to the Service Desk solution.") and run it under the Golden Rules below.

---

## Environment Setup

**0. Not the Semantius agent?** Before anything else, read `references/preflight.md` and run it. It also sets the question format for every question this skill asks.

**1. Is semantius installed?** Run `semantius --version`. If the shell cannot find it (POSIX `command not found` / exit code 127, PowerShell `CommandNotFoundException`), it may be installed but not yet on this session's PATH. Look in `%LOCALAPPDATA%\Programs\Semantius\semantius.exe` (Windows) or `/usr/local/bin/semantius` and `~/.local/bin/semantius` (Linux / macOS). If it is there, call it by that full path wherever these skills write `semantius` (`references/cli-usage.md` § "Installing from an agent"). If it is in none of those places, STOP: run no semantius command, and tell the user it is not installed, with the install command for their shell from `references/cli-usage.md` § "Installation" and the guide at **https://www.semantius.com/docs/cli/use-semantius/**.

**2. Is it connected?** Follow `references/cli-usage.md` § "Checking the connection". In short:

- **Probe** (`semantius whoami`, or the `getCurrentUser` call you need anyway). Exit `0`: connected. When it matters which credential is in use, name the host, its `host_source` and the `auth_method`; a zero exit can still hide one of the two traps in § "Credential, first match wins".
- **Exit `3`:** retry once, then show the error and stop.
- **`MISSING_ENV_VAR` or exit `5`:** sign the user in with `semantius use <host>`, asking for the host unless `whoami` shows it as `current`. A user with no instance yet signs up at **https://app.semantius.com**, which gives them their host (`<org>.semantius.app`) and the steps to connect. Exception: an error naming `SEMANTIUS_API_KEY` or `SEMANTIUS_JWT` in a deliberate key or token setup; show it and stop.
- **Anything else:** show the error and stop.

**Signing the user in** (§ "Signing the user in"): `semantius use <host>` switches the host for every later command in every directory, so run it only for the host the user named to work against; `semantius login --host <host>` signs in without switching. Never run `logout`. Run the sign-in in the background and relay its URL to the user, and add `--login-flow device` whenever the user is not at this machine's screen.

`whoami`, `ping` and `hosts` are safe read-only diagnostics. Commands, tiers, host and credential precedence: `references/cli-usage.md`.

---

## Core CLI Commands

```bash
semantius                              # List all servers and tools
semantius -d                           # List with descriptions
semantius tools <server>              # Show tools and parameters for a server
semantius tools <server> <tool>       # Get tool description and JSON schema, for a tool the references do not cover
semantius search_tools "<words>"      # Find tools by name or description
semantius call <server> <tool> '{}'   # Call tool with inline JSON
semantius call <server> <tool>        # Call tool — reads JSON from stdin
```

**Windows (PowerShell): always give the CLI its JSON, inline or piped, or pipe empty input if the tool takes no arguments.** Omitting the JSON argument makes the CLI block reading stdin until EOF. In a persistent PowerShell session (state kept alive across calls, as some agent harnesses do) that stdin pipe is never closed, so the call hangs forever with no error and no timeout — it is not a network or auth issue, and retrying will not help. Always supply the JSON explicitly, even if empty:

```powershell
semantius call crud getCurrentUser '{}'     # inline JSON, never blocks
"" | semantius call crud getCurrentUser     # or explicitly pipe stdin closed
```

Windows PowerShell 5.1 strips the quotes from inline JSON (`INVALID_JSON_ARGUMENTS`), so pipe it there: `'{"limit": 1}' | semantius call crud read_role`. `$PSVersionTable.PSVersion` shows the version.

Never invoke a no-argument `semantius call ...` bare on Windows/PowerShell without one of the two forms above.

Both `tools <server> <tool>` and `tools <server>/<tool>` work interchangeably.

### Find the built-in tool before building

The CLI's tool list is the inventory of what the platform can do, and it grows. This skill names only some of it. Before you write a script, diagram, document, report or export that reads the model, check whether a tool already produces it. A built-in tool knows the module's relationships, entity types, external references and rules; rebuilding the result from `read_entity` / `read_field` duplicates that and gets details wrong.

```bash
semantius search_tools "<words>"      # tools whose name or description contains any word, best match first
semantius tools <server> <tool>       # the signature of a candidate
```

Search with the artifact the user named and its synonyms (diagram, erd, spec, document, export, report), not with a tool name you already know. Add `--all` to include the remote servers. Use the tool's output as the deliverable; build by hand only when no tool fits.

A generator returns its artifact as text (for example a markdown document or a Mermaid code block), not JSON: it arrives on stdout as-is, so do not pipe it through `jq`. To keep it, redirect stdout to a file. Render it to an image only when the user asks for one.

---

## The Servers

Only `crud` and `utils` are always there. Run `semantius` to see which others the instance has, and use only the ones listed.

### `crud`: Schema Management + Record Operations (Layers 1 & 2)

**Layer 1 typed tools** manage the semantic data model: `create_entity`, `create_field`, `create_module`, `create_permission`, `create_role`, etc. These operate on Semantius's own schema tables. Every `create_*` takes `data` as one object **or an array of objects** (several fields, permissions, roles in one call), and every `update_*` / `delete_*` takes `id` (or `table_name` for entities, `permission_name` for permissions) as one value **or an array**.

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

1. **Never model one real-world thing twice, and read before writing.** A new entity is compared with the whole instance first, see "Before any new entity: compare it with the instance". Before any `create_*`, call `read_*` to check for duplicates. ALWAYS first.
   - A new module → `references/module-rbac-setup.ts`, which reads first; never `create_module`
   - Before `create_entity` → run `read_entity` first
   - Before `create_permission` → run `read_permission` first
   - Before `create_role` → run `read_role` first
   - If the read returns results, use those IDs instead of creating duplicates (an entity is settled as that section says). Only create if it returns empty.
   - For a bulk create, **one** `read_*` with an `in.(...)` filter covers every item (`"filters": "field_name=in.(description,cost)&table_name=eq.services"`); never one `--single` read per record.
2. **Schema first**, follow "Mandatory Creation Order" in `references/data-modeling.md`, the single source for the order, the `is_a` / `has_a` exception, and how every entity is classified and read back.
3. **Never create auto-generated fields**, `id`, `created_at`, `updated_at` and the `label_column` field are created automatically by `create_entity`. On an `is_a` / `has_a` entity also never create a field of its base: create only the entity's own fields. Leave `field_order` out of `create_field` too: the platform appends new fields in array order, while a hand-picked value can silently tie with an auto-created field (the label field sits at 20). Set it only when the user wants a specific position, after reading the entity's live `field_order` values.
4. **`reference_table` mandates relational format**, Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. No exceptions.
5. **Warn before risky changes**, Renaming `table_name`/`field_name`, deleting entities/fields requires explicit user confirmation.
6. **Surface a UI link whenever it helps the user**, after schema changes *and* after record operations (create / find / update). Pattern: `{ui_baseurl}/{module_slug}/{table_name}`, append `/{id}` for one record. See "Linking to the web UI" above for the rules (derive `ui_baseurl` from `getCurrentUser`; use the lowercase `module_slug`).
7. **Always batch: one call per set of records, never a loop of single calls.** Whenever more than one record of the same kind is pending (several fields for an entity, several permissions for a module, several `role_permission` rows, several ids to update or delete, several rows for a table), send them **in one call**: pass an array in `data` to `create_*` (`'{"data": [{...}, {...}]}'`), or an array in `id` (`table_name` for entities, `permission_name` for permissions) to `update_*` / `delete_*` (`'{"id": [4, 5, 6]}'`, the same `data` applied to every id). Array items do **not** need the same keys (a key omitted from one item takes the column default). One call is one request and one transaction (all-or-nothing); the response is always an array of the affected records. Keep a call to roughly 100 rows / ids. Issuing N single-record calls where one array call would do is a mistake. The one ordering exception is entities of a family: one `create_entity` call per level, bases first. `postgrestRequest` also takes an array `body`, but under raw PostgREST rules (identical keys per item, or `?columns=` on the path with omitted keys becoming NULL). See `references/crud-tools.md` § "Bulk operations".
8. **Aggregates over child records are rollups**, A value summed, counted or otherwise aggregated from child records is a field with a `rollup` definition, never a `computed_fields` rule or a value the client maintains. See `references/rollup-fields.md`.
9. **Deliver the smallest result that satisfies the request.** A build request is schema, permissions, roles and UI links, not a spec, report or analytics run. Sample data is offered, capped and seeded only after an explicit yes; specs, diagrams, exports and analytics are produced only when asked. Verification is one `module-rbac-setup.ts --slug` run, one read of the new entities (class, permissions, rules and read rules), one read each of the module's hierarchy, roles and grants and, when seeded, the real seed run's output (every table at its count, each child relationship read back, each computed and rollup column checked) and a rollup value if the module has rollups, not an analysis. An analytics request answers only the question asked and writes nothing to the schema. Smallest means narrowest scope, never a compressed rendering of a result: when the answer is an artifact, deliver the whole artifact (Golden Rule 10). See `references/build-module.md`.
10. **Generated artifacts are used exactly as the tool returned them.** What a tool returns (a diagram, spec, document, report, export or CSV schema) is the artifact; the bytes are not raw material to summarize. A diagram is pasted into the reply verbatim: the status line, every `classDef` and `class` line and the node order, because the styling states which entities were selected and which are only referenced. A document is saved by redirecting stdout to a file and handed over as that file. The tool's output already carries its own ```` ```mermaid ```` fence; do not add a second one. Length is no reason to shorten it; if the output was truncated, redirect stdout to a file, read the file in parts and paste it in full. Never retype, condense, re-style, re-order or tidy it, and never put a hand-made version beside it. Quoting part of an artifact counts as retyping: to answer a question about it, use prose, or paste the whole artifact. A subset or a view across several modules is not a reason to edit the diagram: call the tool with `module_slugs` and/or `table_names`. Every time an artifact is sent, including a repeat later in the session, it is pasted from a tool result in that same turn: run the generator again for a different selection, read the saved file for the same one. Never reproduce it from an earlier message. A table or prose that adds information (fields from `read_field`, an explanation) may sit outside the artifact; a second diagram, or a table that only restates the diagram's nodes and arrows, may not. If the tool fails, report the failure; do not draw a substitute by hand.
11. **`AskUserQuestion` is the only tool call of its response**, because a tool call beside it cancels the pause and the run continues before the user has answered. Finish every read and write first.

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
`read_role` response fails with `Cannot index array with string` —
index the array: `jq -r '.[0].id'`, or pass `--single` to get a bare
object (single-record calls only; `--single` is rejected when `data` /
`body` / `id` / `table_name` is an array).

**Never read a new row's `id` off its own create response.** The echoed
representation is not a dependable carrier of the id/natural key, and a
position in a bulk response is not a mapping back to your input. Re-read
by natural key after the create (one `in.(...)` read for a whole batch)
and take the id from that read.

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
before sending it** (exit `1`, `SINGLE_ARRAY_INPUT`). Never pass an explicit
`"accept": "application/vnd.pgrst.object+json"` with an array
either. Assert a bulk write by its count (`jq 'length'` equals the
number of rows sent) or by a follow-up `read_*` with an `in.(...)`
filter. A bulk call is one transaction: if it fails, nothing from it
landed — fix the cause and re-issue the one call; do not fall back
to a loop of single-record calls.
