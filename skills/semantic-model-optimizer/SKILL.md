---
name: semantic-model-optimizer
description: >-
  Reverse-engineers a `*-semantic-model.md` file from a live Semantius module —
  reads the module's entities, fields, and enum values via `semantius`,
  pulls in any related tables referenced from other modules or Semantius
  built-ins (e.g. `users`, `departments`) so the output is self-contained, and
  writes a file byte-compatible with the template used by the
  `semantic-model-analyst` skill. After saving, optionally runs an audit pass
  and suggests optimizations to the `.md` file. Trigger when the user wants to
  extract / export / snapshot / document / reverse-engineer / pull / refresh /
  regenerate a semantic model from a live Semantius instance, optimize an
  existing module, or bring a customized live module back in sync with its
  markdown spec. Example phrases: "generate a model from the `<slug>` module",
  "extract the `<slug>` semantic model", "snapshot the live module", "pull
  `<slug>` down to a markdown spec", "optimize the `<slug>` module", "the live
  model has drifted — regenerate the spec".
---

# semantic-model-optimizer Skill

Closes the loop in the semantic-model lifecycle:

```
semantic-model-analyst  →  semantic-model-deployer  →  (users customize in Semantius)  →  semantic-model-optimizer  →  …
```

The `.md` file this skill produces is **interchangeable with one produced by the analyst**: same front-matter keys, same §1–§7 structure, same Mermaid diagram conventions. The deployer can re-deploy it; the analyst can audit or extend it. That compatibility is the main reason this skill exists — without it, live customizations in Semantius drift silently away from the `.md` and no other skill in the cycle can catch up.

## Division of responsibility

- **This skill** owns the workflow: picking the module, reading its state, discovering related tables in other modules, transforming live state into the markdown template, and (opt-in) suggesting optimizations.
- **The `use-semantius` skill** owns the execution: every read is a `semantius` call.
- **This skill is read-only against Semantius.** It never writes to the platform. Any fixes suggested in Stage 5 are applied to the `.md` file only — a re-deploy via the `semantic-model-deployer` skill is how changes make it back to Semantius.

---

## Step 0: Load required skills

Read these first:

- `<skills-root>/use-semantius/SKILL.md`
- `<skills-root>/use-semantius/references/data-modeling.md` — authoritative list of Semantius built-ins and platform constraints
- `<skills-root>/semantic-model-analyst/references/semantic-model-template.md` — the output template; the `.md` must match it exactly
- `<skills-root>/semantic-model-analyst/SKILL.md` Mode B audit checklist — reused in Stage 5

---

## High-level workflow

```
1. Pick module  →  2. Read module state  →  3. Discover related tables  →  4. Write the .md  →  5. (opt-in) Suggest optimizations
```

Narrate what you're doing at each step.

---

## Stage 1: Pick the module

If the user named a module, resolve it directly with `read_module`. Otherwise list all modules:

```bash
semantius call crud read_module '{"order": "module_name.asc"}'
```

Present the list as a compact table (`module_name`, `label`, short description). Ask the user which module to extract. Do not guess when multiple candidates match — ask.

Capture `module_id`, `module_name`, `label`, and `description` for the rest of the pipeline. Never create a module here; this skill is read-only.

---

## Stage 2: Read the module state

Pull the full schema:

```bash
# Module already resolved above; re-read only if you need the exact row
semantius call crud read_module '{"filters": "module_name=eq.<slug>"}'

# Entities belonging to this module, in creation order
semantius call crud read_entity '{"filters": "module_id=eq.<id>", "order": "created_at.asc"}'

# Fields — read the whole catalog once and filter client-side; cheaper than N reads
semantius call crud read_field '{}'
```

Build in memory:

- **module** — `module_name`, `label`, `description`
- **entities[]** — each with `table_name`, `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `module_id`
- **fields_by_table** — map keyed by `table_name`, per field: `field_name`, `format`, `title`, `description`, `unique_value`, `reference_table`, `reference_delete_mode`, `enum_values`, `ctype`, `field_order`, `searchable`

**Strip auto-generated fields** before rendering. Do not render these in §3:

| Field name | Why skipped |
|---|---|
| `id` | Auto-created primary key |
| `label` | Auto-created computed display field (the *generic* one, `ctype: label`, distinct from the named `label_column` field) |
| `created_at`, `updated_at` | Auto-maintained timestamps |

**Keep** the named `label_column` field (e.g. `product_name`, `subscription_name`). It *is* rendered as a §3 row — marked `label_column` in the Notes column — because that is how the analyst's template expresses it and how the deployer round-trips.

Identify `label_column` by matching `field.field_name == entity.label_column`. In Semantius that row has `ctype: label` but a non-generic `field_name`, which is how it differs from the skipped generic `label` row.

---

## Stage 3: Discover related tables (self-containment)

The analyst's template requires the model to be self-contained — every entity referenced by any FK must appear as its own §3 section, even if the referenced entity lives in another module or is a Semantius built-in.

Walk every field in our module's entities where `reference_table` is non-empty. For each target `table_name`:

- **Target is in our own module** → already included; skip.
- **Target is in a different module** → add to a `related_entities[]` list and pull it in.
- **Target is a Semantius built-in** (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields` — see `use-semantius/references/data-modeling.md` for the authoritative list) → add to `related_entities[]` and pull it in. Built-ins are included as normal §3 entities; the `semantic-model-deployer` skill deduplicates them at deploy-time.

For each related table:

```bash
semantius call crud read_entity '{"filters": "table_name=eq.<name>"}'
semantius call crud read_field '{"filters": "table_name=eq.<name>"}'
```

Apply the same auto-field stripping from Stage 2.

**Recursion depth.** In principle a related table might reference yet another table. In practice:

- Always walk one level out.
- Walk a second level **only** if the second-level target is a Semantius built-in (most commonly `users`) — this keeps the model self-contained without dragging in an entire sibling module.
- Stop at two levels. If the third level would add yet another non-built-in entity, do not include it; instead, note it in §6.2 as a future consideration (e.g. *"Should `<entity>` be included to round out FK targets for `<related>`?"*).

Record for each entity whether it came from our module or `related_entities[]` — §7 lists the external ones explicitly.

---

## Stage 4: Write the semantic-model file

Follow `semantic-model-analyst/references/semantic-model-template.md` verbatim. Mapping from live state to template:

| Live property | Template location |
|---|---|
| `module.module_name` | front-matter `system_slug`, §7 module name |
| `module.label` | front-matter `system_name`, top-level `#` heading |
| `module.description` | §1 Overview (expand to 2–3 sentences if short — do not invent facts, stay faithful) |
| `entity.table_name` | §2 Table name, §3 sub-heading, §4 From/To |
| `entity.singular_label` | §2 Singular label, §3 sub-heading suffix |
| `entity.plural_label` | §3 Plural label line |
| `entity.description` | §3 Description |
| `entity.label_column` | §3 Label column |
| `entity.audit_log` | §3 `**Audit log:** yes \| no` line — render `yes` when `true`, `no` when `false`/null |
| `field.field_name` | §3 Field name |
| `field.format` | §3 Format (the live value is already from the analyst's vocabulary) |
| (inferred) | §3 Required — the platform manages nullability internally and does not expose a per-field flag. Infer: `format: parent` → `yes`; `format: reference` → `no`; other formats default to `yes`. |
| `field.title` | §3 Label |
| `field.reference_table` + `reference_delete_mode` | §3 Reference / Notes + §4 summary row |
| `field.enum_values` | §3 Notes (`values listed in §5.N`) and a §5 sub-section |
| `field.unique_value` | §3 Notes (`unique`) |
| `field.description` | §3 Notes (append when non-trivial) |

### Front-matter

```yaml
---
artifact: semantic-model
system_name: <module.label>
system_slug: <module.module_name>
# domain: see inference rule below — omit when no canonical category fits
naming_mode: agent-optimized
created_at: <today, YYYY-MM-DD>
entities:
  - <table_name_1>
  - <table_name_2>
# departments and industries: see carry-over / inference rule below
---
```

**`entities` is required.** Populate it from the live module's entity list — every `table_name` rendered in §2 (in §2 order, lowercase snake_case). Include only the entities owned by *this* module; do **not** list `related_entities[]` pulled in for self-containment, since the discovery tag is meant to identify what the model is about, not its FK neighbourhood. Regenerate every run from live state — never trust a prior file's list.

**`domain` — infer from the entities you just read.** `domain` is not stored in Semantius. The live entity names are usually the strongest signal — a module containing `tickets`, `incidents`, `agents` is `ITSM`; one containing `leads`, `accounts`, `opportunities` is `CRM`; one containing `employees`, `positions`, `time_off` is `HRIS`; one dominated by clinical entities is `EHR`. Use the module label and description as supporting signal but the entity shape is what disambiguates.

The vocabulary is open: prefer the common values (`CRM`, `ITSM`, `HRIS`, `LMS`, `ERP`, `PIM`, `Project Management`, `Field Service`, `Subscription Billing`, `CMS`) when one fits cleanly, otherwise coin a new Title-case / acronym value that captures the system shape (`Talent Acquisition`, `EHR`, `Compliance`, `MES`). Only omit `domain` when you genuinely can't categorise the system. **Never write `custom`** — it adds zero discovery signal. A prior file's `domain` value is *not* carried over — re-infer from live state every run.

**`departments` and `industries` — carry over when a prior file has them, otherwise infer from the gathered live state.** These tags aren't a column in Semantius, but the live state still carries plenty of signal — `module.label`, `module.description`, the entity names you just read in Stage 2, the field names within those entities — that maps to the same inference the analyst makes from a Stage 1 capture. Use that signal, not a guess from the module name alone. **Use Title-case / acronym form** (`Sales`, `IT`, `HR`, `Healthcare`, `SaaS`, `Financial Services`) — never lowercase snake_case.

Two cases at Stage 4:

1. **Prior file exists with `departments` / `industries`.** Copy each present key byte-for-byte into the new file (same mechanic as `initial_request`). The user has already curated these tags; respect that.
2. **Prior file is missing the key (or no prior file at all).** Re-run the analyst's Stage 5 inference rule against the gathered live state — entity names, module label, module description, field names. If you can confidently propose a value, include it. If you have low or no confidence, omit the key. Never invent a value with no supporting signal.

Either way, the result is a single concrete YAML key (or omission). Do not block on user input.

> **🛑 Do not search the workspace for existing semantic-model files.** This skill exports the currently-live module from Semantius — the live state *is* the source of truth. Never glob `*semantic-model*.md`, and never read unrelated semantic-model files. Other systems' models tell you nothing about this module, and the template (already loaded in Step 0) is the only style reference you need.

**`initial_request` — one-field carry-over from a matching prior file, if and only if it exists.**

At Stage 4, do exactly this — no broader search:

1. Try to read the **exact path** `{system_slug}-semantic-model.md` in the workspace folder. Accept "file not found" as the answer and move on — that is the common case.
2. If and only if that file exists **and** contains a non-empty `initial_request` front-matter key, copy **that single value** byte-for-byte into the new file's front-matter as a YAML literal block. The analyst's immutability rule applies across the cycle: the original ask is a historical record, not yours to rewrite.
3. If the file exists but has no `initial_request` (or has an empty one), **omit the key entirely** in the new file. Do not invent a placeholder, do not write a synthetic "extracted on …" value.
4. If the file does not exist, **omit the key entirely**. The analyst's audit treats missing `initial_request` as a 🟡 Warning (not a blocker), which correctly signals that this file was reverse-engineered.

> **Only the user-curated metadata is preferentially carried over — nothing else.** From the prior file, copy `initial_request` (immutable historical record), `departments`, and `industries` byte-for-byte if present. `initial_request` is purely carry-over (omit when absent — never invent). `departments` and `industries` fall back to live-state inference when the prior file lacks them — see the dedicated rule below. Do not copy `domain`, `naming_mode`, `system_name`, the §1 Overview prose, the §2 entity list, or any structural content — the live module is the source of truth for everything the platform stores, and the prior file's structural content may be stale relative to what users have since customized in Semantius. Regenerate everything except those carry-over keys from live state.

**`naming_mode`** is not persisted in Semantius. Always write `naming_mode: agent-optimized` unless the user tells you otherwise in this conversation. **`domain`** is handled by its own inference rule above — never default it to `custom`, never carry over from a prior file; either infer from entities or omit.

### Reference notation in §3 Notes

- `format: reference` → `→ <target> (N:1, <delete_mode>)`
- `format: parent` → `↳ <target> (N:1, <delete_mode>)`
- Self-reference (`reference_table == table_name`) → append `; self-ref for hierarchy` or similar

### §4 Relationship summary

One row per FK field. Cardinality at the FK side is always N:1 in Semantius. The 1:N / M:N / 1:1 views are inferred from the direction.

Detect junctions: an entity whose fields (after auto-field stripping and after the `label_column` row) are exactly two `parent` FKs is a junction. Mark those rows `parent (junction)` in §4 Kind.

### §2 Mermaid flowchart

Follow the analyst's convention verbatim (`-->` = many, `---` = one, arrows point parent → child):

- For every `reference` or `parent` FK: draw `<reference_table> --> <child_table>`. One edge per FK, not one per entity pair.
- For junctions: draw each of the two parent entities `-->` into the junction entity. Never draw a direct edge between the two parents.
- Self-references: draw `<entity> -->|parent of| <entity>` (self-loop).
- Add a short verb label where it adds clarity (`|owns|`, `|has|`, `|funds|`). Unlabeled edges are fine when the relationship is obvious.
- `flowchart LR` is the default; switch to `flowchart TB` if the graph is wider than tall.

Regenerate the diagram from the field data every run. Never reuse a diagram from a prior `.md` — that is exactly what would go stale.

### §5 Enumerations

One sub-section per field whose `enum_values` is non-empty, sub-numbered in §2-table order. Skip fields with empty or null `enum_values`. Write the values as a bullet list, one per line, code-fenced (`` `value` ``).

### §6 Open questions

- **§6.1 🔴 Decisions needed** — write `None.` Live extraction doesn't propose anything, so nothing is ambiguous that would block redeployment.
- **§6.2 🟡 Future considerations** — write `None.` unless Stage 5 is run and surfaces items you choose to demote here.

Keep both sub-headings even when empty, per the template.

### §7 Implementation notes

Follow the analyst's §7 checklist verbatim. In addition:

- List every entity that came from `related_entities[]` in Stage 3, with its home module (or "Semantius built-in") so the downstream `semantic-model-deployer` knows to reuse, not recreate.
- Preserve the creation-order constraints — entities without FKs first, junctions last, with a second pass for self-references and mutual cross-references.

### Save

Write to `{system_slug}-semantic-model.md` in the workspace folder. If a file with exactly that name already exists, confirm before overwriting (it might have manual edits) — but do **not** read it to "merge" anything; the live module is the source of truth and what you just built from live state is what gets saved. Check only by targeted path; do not glob the workspace. After saving, report a one-line summary:

> Extracted `<slug>`: N entities (K from other modules / built-ins), M fields, E enums. Saved to `<slug>-semantic-model.md`.

Then move to Stage 5.

---

## Stage 5: Suggest optimizations (opt-in)

After the file is saved, ask one question:

> "Would you like me to suggest optimizations for this model?"

If **no** — done. Do not push further.

If **yes** — run the Mode B audit from `semantic-model-analyst/SKILL.md` against the file you just wrote. Report findings in the analyst's exact format (🔴 Blockers, 🟡 Warnings, 🟢 Suggestions, with an overall one-line verdict).

### Optimizer-specific checks (on top of the analyst's audit)

Checks that are most useful when the source is live state, not a greenfield draft:

- **Missing `label_column`** — an entity with a blank `label_column` in live state breaks the analyst's and deployer's expectations. **🔴 Blocker.**
- **`label_column` is a FK** — an entity where `label_column` matches a `reference` or `parent` field. Per `data-modeling.md`, Semantius auto-creates a field with the same name as `label_column`, which collides with the FK. Suggest a dedicated scalar label field (e.g. `<entity>_label`) — especially for junction tables. **🔴 Blocker.**
- **Singular-form `table_name`** — per Semantius platform rule. **🔴 Blocker.**
- **Inconsistent singular/plural labels** — `singular_label` should be the bare singular; field-level titles (e.g. "Product Name") belong on the auto-created `label` field's `title`, never on the entity's `singular_label`. **🟡 Warning.**
- **Missing descriptions** — entities or fields with empty `description` suggest the spec drifted during live customization. **🟢 Suggestion.**
- **Entities with no incoming or outgoing FKs** — an isolated entity is sometimes a real root (e.g. `users`) and sometimes an oversight. **🟡 Warning** unless it's clearly a root.
- **Likely missing junction** — two entities that look like they should have an M:N link (based on naming heuristics) but don't. **🟢 Suggestion.** Be conservative — false positives here are noise.

After presenting the report, ask:

> "Want me to apply the 🔴 blockers and 🟡 warnings to the `.md` file?"

If yes:

- **Only update the `.md` file** — never touch live Semantius. Live changes are the deployer's job and require a re-deploy pass.
- Regenerate the §2 Mermaid diagram if any relationship-affecting fix is applied.
- Before writing, re-run the analyst's self-audit pass on the updated draft — don't save a file that fails its own audit.
- Save back to the same filename. Share a one-line summary of what changed.

### Offer to redeploy

Once the updated `.md` is saved, the `.md` and the live module have drifted — the `.md` now reflects the fixes, Semantius still holds the unfixed shape. Close the loop by asking:

> "The `.md` file now has those fixes, but Semantius still holds the pre-fix shape. Want me to hand this off to the `semantic-model-deployer` skill to redeploy the corrected model?"

If **yes** → invoke the `semantic-model-deployer` skill with the saved `.md` file as its input. The deployer's own workflow takes over from there (parse, inspect, plan, execute) — do not try to duplicate its logic here.

If **no** → stop. Mention that the user can redeploy later by invoking the deployer against the saved `.md`.

Only make this offer when fixes were actually applied. If Stage 5 ran but the user declined to apply the findings — or the audit came back clean with zero 🔴/🟡 — the `.md` matches live state, there is nothing to redeploy, and asking would be noise.

---

## What this skill does not do

- Does **not** write to Semantius. Read-only reverse-engineering.
- Does **not** capture RBAC roles, permissions, user assignments, or webhook receivers — those are out of scope for the semantic model (the analyst excludes them too).
- Does **not** capture sample business data — schema only.
- Does **not** guess at `domain` or `naming_mode` — it uses safe defaults (`custom`, `agent-optimized`) and lets the user or the analyst's audit correct them.
- Does **not** duplicate the analyst's Audit mode. If the user wants a pure audit of an existing `.md` file without touching Semantius, route them to `semantic-model-analyst` in Audit mode. Use this skill only when the *live state* is the source of truth.
