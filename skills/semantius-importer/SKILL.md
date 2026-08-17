---
name: semantius-importer
description: >-
  Imports a CSV into Semantius: introspects CSV schema with the CLI's
  `get_csvschema` util, maps columns to Semantius field formats, detects
  whether a matching entity exists (field-by-field diff), optionally creates
  the entity (and its module first), then generates and runs a Bun script that
  bulk-loads rows in batches. Also supports schema-only runs (create the
  entity, no rows) and compare-only runs (diff report, zero writes). Trigger
  on "import this CSV", "load this file into semantius", "create an entity
  from this file / spreadsheet export", "introspect this CSV", "bulk load
  these rows", "does this CSV match our table?", or asking what entity shape a
  CSV implies. Do NOT trigger for deploying blueprints or specs
  (semantius-admin / semantius-modeler), designing a multi-entity system
  (semantius-architect), CSV work with no Semantius target, or
  webhook-receiver ingestion (an external system pushes rows; see
  use-semantius references/webhook-import.md). For xlsx, ask for a CSV export
  first; CSV-only.
---

# semantius-importer Skill

The front door for getting a **file** into Semantius. One CSV in, one entity out (created or reused), rows loaded in batches. The pipeline skills (architect → analyst → modeler) design and deploy whole systems from specs; this skill deliberately does lightweight, single-entity creation driven by what a file actually contains — no blueprint, no catalog reconciliation machinery.

Division of responsibility:

- **This skill** owns the workflow: introspect → map → detect → decide → import → verify, and the decision points along the way.
- **use-semantius** owns every low-level operation (CLI syntax, payload shapes, response contracts, Golden Rules). Loaded at Step 0; it wins on any conflict.
- **webhook-import.md** (in use-semantius) remains the reference for signed-webhook ingestion — external systems pushing rows one at a time. Not this skill's path.

## Operating modes

Pick from the user's phrasing; ask once when ambiguous.

| Mode | Runs | Writes |
|---|---|---|
| **Full import** (default) | Stages 1–6 | catalog (as decided) + data |
| **Schema-only** — "just create the entity from this file" | Stages 1–4, stops after catalog writes | catalog only |
| **Compare-only** — "does this file match our entity?" | Stages 1–3, renders the classified diff report | **zero writes** |

In every mode, each decision branch that would modify an existing entity carries an explicit **"report only, do not update"** option. Comparing never forces updating.

## Writing conventions (apply to every user-facing output)

Self-contained — no other skill file needs to be read for these. They govern chat output, `AskUserQuestion` text, plans, and reports; they never apply to data payloads bound for Semantius.

1. **US English spellings, always**: optimize, behavior, customize, organization, analyze — never the British forms.
2. **No em-dashes (`—`) in chat output.** Use a comma, parentheses, a semicolon, or two sentences instead. (Skill and reference files may use them; the ban is on what the user reads in chat.)
3. **Plain language.** Say "table", "field", "row", "the file" — never internal jargon (csvschema verdict, disposition, mapping artifact) without a plain-English gloss.
4. **Narration restraint.** Never announce what you are about to do ("Let me read...", "Now let me check..."). Do the work; render only the decision points and the final report. Play-by-play between tool calls is noise.
5. **Data is sacred.** CSV values travel into Semantius byte-for-byte except for the coercions the mapping explicitly declares; house style (spelling, dash policy) is never applied to payloads, titles, or enum values derived from the file.

---

## Preflight (before Step 0, every invocation)

The shared environment checks live in **[`../semantius-admin/references/preflight.md`](../semantius-admin/references/preflight.md)**; do not duplicate them. Standalone summary: install the toolchain if missing, probe `getCurrentUser` to confirm the CLI is authenticated, halt if the org guard trips. This skill runs from wherever the user's CSV work happens; it needs no repository and makes no assumptions about one. This skill critically needs **Bun** (the import script runs with `bun run`); `jq` is convenient but optional; `yq` and the customizations file are not used.

Also confirm the CLI ships the introspection util: `semantius info utils` must list `get_csvschema`. An older CLI without it needs the installer re-run first.

## Step 0 (hard gate): load the essentials

**Blocking prerequisite, not a suggestion.** Do not issue a single `create_*` / `update_*` and do not start the import until you have read:

```
Read: references/importer-essentials.md
```

That file is the distilled subset of `use-semantius` this workflow needs: CLI forms, exit codes, response shapes, the three catalog writes, `postgrestRequest`, deep links. It is a distillation, not the authority — **use-semantius wins on any conflict** — and the full references are consulted **on demand**, not up front: `../use-semantius/references/data-modeling.md` for FK modeling depth, RBAC beyond the module's two standard permissions, or schema-evolution risk; `../use-semantius/references/crud-tools.md` for PostgREST syntax beyond the essentials; `../use-semantius/references/cli-usage.md` for exotic CLI forms and chaining.

### Safety-net cheat table (a backstop, never a substitute; use-semantius wins)

| Trap | Right behavior | Authoritative source |
|---|---|---|
| Read response shape | `crud` reads return a JSON **array**; exit `0` + `[]` means "found nothing". Pass `--single` on unique-key reads: bare object, exit `1` = none, `2` = ambiguous | use-semantius SKILL.md → Response handling |
| Mandatory fields | There is **no `required` column**: mandatory = `input_type: "required"`, unique = `unique_value: true`. Never send `is_nullable` | data-modeling.md → All Field Properties |
| Nullability | Computed from `format`: only `reference`, `date`, `date-time` accept NULL; everything else is NOT NULL with an auto-default. Drives the empty-cell policy | data-modeling.md |
| `postgrestRequest` payload | The record field is **`body`**, not `data`. Bulk insert = array body where **every object has the same keys** (else `PGRST102`; raw PostgREST, no `missing=default`). The typed `create_*` tools have no such constraint | crud-tools.md → Bulk insert / Bulk operations |
| Several records of one kind | **One call, never a loop**: every typed `create_*` takes `data` as an array (items may differ in keys; one transaction, all-or-nothing; the response is always an array), `update_*` / `delete_*` take an `id` array. Both baseline permissions in one `create_permission`, every new field in one `create_field` (the copied runner does this). `--single` is rejected with an array | use-semantius SKILL.md → Golden Rules (batching); crud-tools.md → Bulk operations |
| Create response ids | Never read the new row's id off the create response; re-read by natural key | use-semantius SKILL.md |
| `update_field` identifier | Composite id string: `{"id": "<table>.<field>", "data": {...}}`; payload carries only the changing keys | data-modeling.md → Updating and Deleting |
| `update_entity` identifier | Keyed by `table_name` at top level, not numeric id | data-modeling.md |
| Big payloads | Pipe JSON via stdin (`... | semantius call crud postgrestRequest`); the CLI reads stdin when no JSON argument is given. The "always pass inline JSON" warning is about interactive shells with an empty stdin, not scripts that pipe | cli-usage.md → Passing Arguments |
| Format vocabulary | `enum` (with `enum_values`), never `select`; monetary values are `number` + `precision` | data-modeling.md |

---

## Workflow

```
1. Introspect → 2. Map & review → 3. Detect & diff → 4. Decide & create → 5. Run import → 6. Verify & report
```

Read **[`references/schema-mapping.md`](references/schema-mapping.md)** and **[`references/import-script-template.md`](references/import-script-template.md)** (workspace and helper mechanics) before Stage 2.

**Per-stage command checklist.** The prose below governs the details; this table is the completeness gate. A stage counts as run only when its listed commands actually ran — substituting a variant call (e.g. a bare `read_entity '{}'` in place of Stage 3's `--single` read plus the overlap sweep) is skipping the stage, not running it.

| Stage | Mandatory commands |
|---|---|
| 1 Introspect | `semantius call utils/get_csvschema '{"path": "<csv>"}'` |
| 2 Map & review | the canonical setup block (import-script-template.md → Workspace layout): mkdir + all four copies under **final names** (`import.template.ts` → `import.ts`) + `bun add csv-parse`; then `bun run render-plan.ts` after every mapping edit |
| 3 Detect & diff | `read_entity --single '{"filters":"table_name=eq.<table>"}'` + `read_field '{"filters":"table_name=eq.<table>"}'`; on absent entity additionally `read_entity '{}'` (name sweep) **and** `read_field '{"filters":"field_name=in.(<mapped field names>)"}'` (overlap sweep), then the create-vs-reuse question |
| 4 Decide & create | catalog writes per decision; `bun run create-fields.ts --dry-run` (pre-write gate), then `bun run create-fields.ts` (one bulk `create_field` call) |
| 5 Run import | `bun run import.ts <absolute-csv-path>` (`import.ts` exists since the Stage 2 setup block) |
| 6 Verify & report | spot-read `postgrestRequest` GET with `select=<id_column>,<label_column>,<sample fields>` — never `select=label`; every probe result, including errors, goes into the report |

### Stage 1 — Introspect

```bash
semantius call utils/get_csvschema '{"path": "<csv-path>"}'
```

Default `maxRecords: -1` scans the whole file (streaming; large files are fine). **Do not cap the scan** unless the user insists: a capped scan degrades format verdicts (low-cardinality columns collapse to `enum`) *and* silently suppresses id detection. The result returns the schema inline and writes `<file>.csvschema.json` next to the CSV — keep it, the import workspace copies it. On an error envelope (`FILE_NOT_FOUND`, `EMPTY_FILE`, `NO_HEADER_ROW`, `PARSE_ERROR`, ...), surface the message and stop.

The schema is a wrapper: `{id_mode, id_move_column?, record_count, fields}`. Record three things: `record_count` (the import's expected parsed-row count on a full scan), `id_mode` (drives the id decision in Stage 2), and each column's verdict from `fields`. The full output contract and its detection quirks are in schema-mapping.md section 1.

### Stage 2 — Map and review

First create the run workspace with the **canonical setup block** (import-script-template.md → Workspace layout): `<cwd>/.tmp_import/run-<timestamp>/` (a scratch folder under the current working directory — never `$TMPDIR` / `/tmp/` / `$env:TEMP`, which a sandbox restart can wipe mid-run; add `.tmp_import/` to `.gitignore` once), then all four copies under their **final names** — the `.csvschema.json`, `render-plan.ts`, `create-fields.ts`, and `references/import.template.ts` copied **as `import.ts`** (the rename happens here at setup, never in Stage 5) — and `bun add csv-parse`. If a previous run folder for the same table exists, offer to reuse and reconfigure it instead. The mapping lives in that folder as `mapping.json` from the first proposal on.

Apply schema-mapping.md sections 2–7 to produce the proposed mapping:

- format passthrough (the CLI vocabulary is aligned; unlisted formats flow through verbatim per the fallback rule) plus the `multiline` naming heuristic;
- **enum review** for every `enum` verdict (low-cardinality columns masquerade as enums);
- **the id line** (schema-mapping.md section 4): `id_mode` applies to the **new-entity path only** — report the detection ("this file carries a usable primary key" / "the first column is an id candidate"), then apply the **classic policy**: id-named column renamed to `external_id` (offered as the unique natural key), an `id_move_column` kept as its own integer field. Importing source ids into a newly created entity's primary key is **deferred** until the `fix_id_sequence` RPC exists (design and roadmap in the README). For an **existing target entity**, `id_mode` is ignored; the live `id_column` drives the collision policy and the payload guard;
- **the write mode** (`on_exists`), asked explicitly when a natural key is in play: `insert` (existing keys skipped) or `update` (existing records synchronized; requires the key to be unique). Recorded in `mapping.json`;
- field-name verification, digit-leading renames, and **reserved-column resolutions** (`created_at`, `updated_at`, `label`);
- **FK candidates** (only with a live target and user confirmation);
- **label column** proposal (new entities);
- empty-cell policy per column; the util's `input_type` proposals (downgradeable).

Write the proposal as `mapping.json` (schema-mapping.md section 8) and render it with the helper: `bun run render-plan.ts` prints the mapping table (raw header → field → format → extras → empty-cell rule → disposition → notes) and a facts block with every count. **Paste the helper's output; never restate a number in prose that the helper did not print** — the artifact is the single source of truth for the table, the plan, and what executes, so counts can never drift between what was said and what was done. Add the id-handling line beside it. Then run the **review loop**: the user can rename any field, change a format, drop a column, change the id decision, or pick a different label column; apply each change to `mapping.json`, re-render with the helper, repeat until approved. Bundle the open per-column questions (ambiguous enums, zero-for-empty, reserved collisions) into as few `AskUserQuestion` calls as possible — one question per topic, all collisions listed together, never one widget per column. Format is **not** free to change silently: every deviation from the introspected csvschema verdict (schema-mapping.md section 2) must be surfaced as a user question with the introspected format as the default, and never folded into the mapping on the skill's own judgment — the rendered mapping carries one pending question per proposed format deviation, and there should be none unless the user asked. If the approved mapping ends up differing from the csvschema verdict on any `format`, that decision must trace to an explicit user answer, not skill inference.

The approved `mapping.json` is final: every later stage (pre-write plan, field creation, import) executes exactly what it says, nothing more.

### Stage 3 — Detect and diff

Derive the candidate `table_name` (plural snake_case) from the user's phrasing or the file name; confirm when ambiguous. Then:

```bash
semantius call crud read_entity --single '{"filters": "table_name=eq.<table>"}'
semantius call crud read_field '{"filters": "table_name=eq.<table>"}'
```

- **Entity absent** (exit 1): do **not** silently take the create path. Sweep for plausible existing targets two ways: name similarity from `read_entity '{}'` (table names containing the derived name or its singular/plural variants, similar labels), and **field overlap** in one query — `read_field '{"filters":"field_name=in.(<mapped field names>)"}'` grouped by `table_name` and ranked by overlap count. Then `AskUserQuestion`: **create new `<derived table>`** / **use existing entity** (top 2–3 candidates listed with module, plural label, and overlap) / the user names another table. Choosing an existing entity continues below as "entity exists"; choosing create marks the Stage 4 create path.
- **Entity exists** (or an existing target was chosen): capture the entity's **`id_column`** from the `read_entity` result (default `id`, but customizable — it drives the reserved-name rules and the script's payload guard; never assume the literal `id`), then diff the approved mapping against the live fields into the four buckets of schema-mapping.md section 9 (matched / missing live / mismatched / extra live), classify every needed change as **possible** or **impossible**, and render the classified change report. Never target the `id_column` field, live fields with `input_type` `readonly` / `disabled`, nor `_label` / `<fk>_label`.

**Compare-only mode ends here**: the classified report is the deliverable, zero writes.

### Stage 4 — Decide and create

| Live state | Default plan | Decision |
|---|---|---|
| Entity exists, everything matched | reuse as-is, import only | confirmation gate only |
| Entity exists, missing fields | add them via `create_field` | ask: add fields / drop those columns / report only / abort |
| Entity exists, mismatched fields | per the possible-vs-impossible classification | ask per report: `update_field` (possible) / coerce-in-script into the live format / drop / report only / abort |
| Entity exists, extra live **required** fields not in the CSV | blocker | ask: constant value for all rows / make the field optional / abort |
| Entity absent, target module known | create the entity there | confirmation gate only |
| Entity absent, no module | create the module first | ask: pick an existing module (`read_module '{}'` list) or create a new one |

Creation order (mechanics in data-modeling.md, `read_*` before every `create_*` so a re-run never double-creates):

1. Module (when needed): `create_module`, then `<slug>:read` + `<slug>:manage` permissions in **one** `create_permission` call (`data` is an array of the two rows), then `update_module` to wire `view_permission` / `manage_permission_id`.
2. Entity: `create_entity` with `table_name`, symmetric `singular_label` / `plural_label`, description, **`label_column`** (the platform auto-creates that field and the computed `label` field), `module_id`, `view_permission`, `edit_permission`.
3. Fields: run `bun run create-fields.ts` in the run workspace — it creates every `disposition: "create"` column from `mapping.json` in **one bulk `create_field` call** (`data` is an array of all the field objects; up to 100 per call, so a wide file is at most a few calls; items may differ in keys — `enum_values` here, `precision` there — the typed tool handles that) with the mapping's explicit `field_order` (increments of 10 starting at 30 — 10 and 20 belong to the auto-created fields; the platform preserves explicit order, so the position in the array carries no meaning), skips field names that already exist live (read-before-create, so a re-run never double-creates), **retries transient failures** (exit 3: up to 3 retries per call with 1s/3s/9s backoff, re-reading the live fields before each retry so rows that landed are never resent), and **fails fast and loud on real errors** (exit 4 validation / exit 5 auth, never retried): a bulk call is one transaction, so a failed call landed nothing — every field of it is reported `failed` with the platform's first stderr line, later calls are `not-run`, non-zero exit; on success it re-reads the live fields and asserts every requested name is present. Never hand-roll a shell loop for field creation — ad-hoc loops swallow errors, and one call per field is against the platform's batching rule anyway. The label column (`disposition: "label"`) and skipped columns are never created. When the label field deserves a more specific title than `singular_label`, follow up with `update_field` on that field's `title` (importer-essentials.md).

**Write mode (`on_exists`).** With a natural key set, the import behaves per the prompted decision: `insert` skips existing keys; `update` synchronizes them — unchanged rows are not written, changed rows are updated, new rows inserted. Update mode requires the key field to be unique (`unique_value: true`); on a non-unique key, say so plainly and offer making it unique via the possible-change classification (which fails loudly when live duplicates exist) or fall back to insert mode.

**One pre-write confirmation gate** (`AskUserQuestion`, never a typed y/n): render the complete numbered plan — module ops, entity, each field, planned alterations, then the import (rows and batches) — and get one approval before the first write. Every number and field line in the plan comes from the helpers, not from prose arithmetic: `bun run render-plan.ts` for the mapping table and counts, `bun run create-fields.ts --dry-run` for the exact `create_field` payloads. The per-topic decisions above happen during analysis; the gate is a single yes.

**Schema-only mode ends here** after the catalog writes, reporting what was created plus the deep link.

Payload hygiene: any payload carrying free text from the CSV or the user (descriptions, titles, enum values) goes through a Bun script or stdin pipe, never inline shell-quoted JSON (see the modeler's data-fidelity rules; same reasoning).

### Stage 5 — Run the import

The workspace, mapping, and dependencies already exist from Stage 2. Per **[`references/import-script-template.md`](references/import-script-template.md)**:

1. `import.ts` already sits in the run folder — the Stage 2 setup block copied `references/import.template.ts` to that final name, **byte-for-byte, never retyped or edited per run** (no placeholders; it reads all run configuration from `./mapping.json` at startup). If it is missing, re-run that one copy line; never re-author the file.
2. `bun run import.ts <absolute-csv-path>` (streaming parse, coercion per mapping, uniform-key batches via stdin-piped `postgrestRequest`, exit-code-aware retries, `failed-batches.json` capture, natural-key dedupe and write modes, built-in count verify).

### Stage 6 — Verify and report

The script already count-verifies and emits `import-summary.json`. The skill then:

1. Checks `parsed` against the introspection's `record_count` (full-scan runs): a mismatch is a parsing defect to surface (delimiter trouble, embedded newlines), not noise.
2. Spot-reads 2–3 imported rows (`postgrestRequest` GET with `select=<id_column>,<label_column>,<a few mapped fields>`) and eyeballs the coercions: booleans are `true`/`false`, dates are dates, enums carry expected values, the **label column field** carries the expected values. **Never `select=label`**: the computed `label` field is a read-time projection, not a PostgREST column — that probe fails with `42703` (verified live). In update mode, one spot-read targets an updated row to confirm the new values landed.
3. Renders the final report: parsed / inserted / updated / unchanged / skipped / failed, the count-verify verdict, the path to `failed-batches.json` when failures exist (with the first error quoted verbatim), and what was created in the catalog.
4. Closes with a clickable deep link to the entity list: `[Open <Plural Label> in Semantius →](<ui_baseurl>/<module_slug>)` — read `ui_baseurl` as a discrete field from `getCurrentUser`, never derive it from `api_baseurl`.

**Probe errors are findings.** A verification probe that returns an error — any non-zero exit or error body — goes into the final report verbatim, with that check marked **failed** or **not verified**. It is never reasoned away, and no prose may claim a check passed whose probe errored: a check either ran and passed, or its error is quoted. ("The probe failed but it's probably fine" is exactly the failure this rule exists to prevent.)

A failed batch is loud: the run is reported as incomplete with the re-run instruction (fix the cause, re-run with the natural key set so completed rows skip). Never render a success-shaped summary over a partial import.

---

## Exporting back out

Small enough to not need its own skill: PostgREST serves CSV directly. `postgrestRequest` has no header override, so for a CSV download use the raw endpoint with the CLI's token, or simply deliver JSON-to-CSV via a few lines of Bun:

```bash
semantius call crud postgrestRequest '{"method":"GET","path":"/products?select=product_code,list_price&order=product_code"}' \
  | bun -e 'const r=await new Response(Bun.stdin.stream()).json();const k=Object.keys(r[0]??{});console.log([k.join(","),...r.map(o=>k.map(c=>JSON.stringify(o[c]??"")).join(","))].join("\n"))' > products.csv
```

Filters, column selection, and pagination follow the normal PostgREST syntax from crud-tools.md.

## This skill never

- deletes anything in the catalog (`delete_entity`, `delete_field`, `delete_module`, ...) — cleanup of test or mistaken imports is the user's explicit call;
- models multi-entity systems, junction tables, or RBAC beyond the module's two standard permissions — route to `semantius-architect`;
- creates webhook receivers — that is webhook-import.md's path;
- writes sample or probe records outside the import itself;
- edits files it did not create this run (the CSV stays untouched);
- imports into `users` or other platform built-ins.
