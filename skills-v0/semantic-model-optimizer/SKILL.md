---
name: semantic-model-optimizer
description: >-
  Reverse-engineers a `*-semantic-model.md` file from a live Semantius module,
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
  model has drifted, regenerate the spec".
---

# semantic-model-optimizer Skill

Closes the loop in the semantic-model lifecycle:

```
semantic-model-analyst  →  semantic-model-deployer  →  (users customize in Semantius)  →  semantic-model-optimizer  →  …
```

The `.md` file this skill produces is **interchangeable with one produced by the analyst**: same front-matter keys (including `version`), same eight-section structure (§1 Overview, §2 Entity summary, §3 Entities, §4 Relationship summary, §5 Enumerations, §6 Cross-model link suggestions, §7 Open questions, §8 Implementation notes), same Mermaid diagram conventions. The deployer can re-deploy it; the analyst can audit or extend it. That compatibility is the main reason this skill exists, without it, live customizations in Semantius drift silently away from the `.md` and no other skill in the cycle can catch up.

## Division of responsibility

- **This skill** owns the workflow: picking the module, reading its state, discovering related tables in other modules, transforming live state into the markdown template, and (opt-in) suggesting optimizations.
- **The `use-semantius` skill** owns the execution: every read is a `semantius` call.
- **This skill is read-only against Semantius.** It never writes to the platform. Any fixes suggested in Stage 5 are applied to the `.md` file only, a re-deploy via the `semantic-model-deployer` skill is how changes make it back to Semantius.

## Writing conventions (apply to every output this skill produces)

These rules apply to chat output, the regenerated semantic-model markdown file, audit reports, and anything else this skill writes for the user to read.

**1. US English spellings, always.** Never British English. Examples (left = correct US form, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), uncategorized (not `uncategorised`), normalize (not `normalise`), harmonize (not `harmonise`), analyze (not `analyse`). When in doubt, pick the `-ize` / `-or` / `-er` form.

**2. No em-dashes (`—`, U+2014).** Banned as a parenthetical break or "and" substitute. Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.` or `X; Y`; `A — B — C` triplet → split into two sentences. The en-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is on `—` used as punctuation. Scan every file and chat message for `—` before writing.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?". Use the form that agrees with the singular implicit subject.

**4. Semantius entity-label symmetry.** When the optimizer reads `singular_label` and `plural_label` from live state and writes them into the regenerated `.md`: `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products`. If live state has an asymmetric pair, surface it in the Stage 5 audit report as a 🔴 Blocker (the entity was misconfigured at deploy time); do not "fix" it silently, the live module needs the correction, not the `.md` alone.

---

## Schema compatibility

This skill writes files at the analyst skill's `CURRENT_VERSION`. At Step 0 it reads `semantic-model-analyst/SKILL.md`; the "Skill version" section at the top of that file declares the canonical version (currently `CURRENT_VERSION = "3.0"`). The optimizer stamps that exact value on every file it writes via the front-matter `version` key. The downstream `semantic-model-deployer` carries an `EXPECTED_MAJOR` constant (currently `3`) and rejects files whose major doesn't match; as long as the optimizer stamps the analyst's current value, the round-trip stays clean. Major bumps in the analyst force a coordinated update of this skill *and* the deployer: a major bump means section numbers, table shapes, or required front-matter keys have changed, and the optimizer's output template must follow.

**`v2.0` shape addition the optimizer must emit.** v2 files carry a mandatory `### Permissions summary` sub-section under `## 2` (after the entity-summary table and the Mermaid diagram). When reverse-engineering from live Semantius state, the optimizer reads the module's permissions (via `read_permission` filtered by `module_id`), the per-permission hierarchy rows (via `read_permission_hierarchy`), and per-entity `edit_permission` values (already gathered in Stage 2 for the entity walks), then assembles the table: one row per permission, with `Type` derived from suffix (`:read` → `baseline-read`, `:manage` → `baseline-manage`, `:admin` → `baseline-admin`, anything else → `workflow`), `Description` carried over from the live `permission.description` field, `Used by` derived by walking entities (`view_permission` / `edit_permission`) and `validation_rules` (every `require_permission` argument), and `Hierarchy parent` derived from the hierarchy rows. The table goes between the §2 Mermaid diagram and the start of §3.

**`v3.0` shape additions the optimizer must emit.** v3 introduces two optional authoring keys that the optimizer reverse-engineers from live state:

- **`module_type` frontmatter key.** Read `modules.module_type` for the picked module. When the live value is `"master"`, emit `module_type: master` in the frontmatter. When `"domain"` (the platform default), omit the key entirely — analyst v3.0 treats absence as `"domain"`, so emitting it would be noise. The key sits next to `system_slug` in the frontmatter block (see Stage 4 template).
- **`**Shared master cluster:** <name>` per-entity annotation.** For every §3 entity, check whether it lives in a `module_type = "master"` module. If yes, the master module's `module_slug` IS the cluster name (e.g. an entity in a `parties` master module gets `**Shared master cluster:** parties`); emit the annotation alongside `**Audit log:**` and `**Edit permission:**`. The annotation is optional in analyst v3.0; the optimizer's rule is "emit it when the live module says master, omit it otherwise" so the round-trip stays clean.

**Module scaffold awareness.** v3 standardizes every module's scaffold to three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`) and three default roles (`<slug>_viewer`, `<slug>_manager`, optionally `<slug>_admin`). New schema columns the optimizer must be aware of: `roles.slug` (snake_case, unique, NOT NULL on INSERT, immutable for `origin in ("system", "model", "model_master")` roles), `roles.origin` (enum: `"system"` / `"model"` / `"model_master"` / `"user"`, strictly immutable after INSERT), `modules.module_type` (enum: `"domain"` / `"master"`, default `"domain"`), and five new module-level FK columns (`manage_permission_id`, `admin_permission_id`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`). The optimizer never writes any of these (read-only against Semantius), but the §2 Permissions summary parsing and the per-entity master-cluster detection both depend on reading them correctly.

**Cross-module permission_hierarchy rows.** v3 introduces `permission_hierarchy` rows tagged `origin = "model_master"` that bridge a domain module's permission (e.g. `itsm:read`) to a master module's permission (e.g. `parties:read`). These rows are how a consumer module gets visibility into a master module's entities. When assembling the §2 Permissions summary table, walk every hierarchy row whose `including_permission_id` resolves to a permission in this module AND whose `included_permission_id` resolves to a permission in a *different* module (the master) AND whose `origin = "model_master"`; the master permission (the included end) shows up in the `Hierarchy parent` cell exactly as a same-module rollup would (e.g. an ITSM module's `itsm:read` row carries `Hierarchy parent: parties:read` when consuming the `parties` master — meaning `itsm:read` *includes* `parties:read`). Cross-module rows are not invented by the optimizer; they are live state that the round-trip must preserve.

When this skill reads a prior file (for `initial_request` / `departments` / `industries` carry-over), it does **not** route on the prior file's `version`. The live module is the source of truth; the new file is regenerated from live state and stamped with the current analyst version regardless. If the prior file's major is older than `CURRENT_VERSION`, the carry-over still happens (those keys haven't changed shape), and the resulting new file is current-major.

---

## Step 0: Load required skills

Read these first:

- `<skills-root>/use-semantius/SKILL.md`
- `<skills-root>/use-semantius/references/data-modeling.md`, authoritative list of Semantius built-ins and platform constraints
- `<skills-root>/semantic-model-analyst/references/semantic-model-template.md`, the output template; the `.md` must match it exactly
- `<skills-root>/semantic-model-analyst/SKILL.md` Mode B audit checklist, reused in Stage 5

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

> **Module schema reminder.** Modules carry both `module_name` (unique human-facing display name shown in the UI selector, e.g. `CRM`, `ITSM`, `CMDB`) and `module_slug` (lowercase URL/permission handle, e.g. `crm`, `itsm`, `cmdb`). The earlier `alias` field is **removed** from the schema; the earlier `label` field is also gone. The compact tagline lives on `description` (≤40 chars, the analyst's `system_description`). Under v3, the row also carries `module_type` (`"domain"` or `"master"`, default `"domain"`) and five new FK columns linking the standard scaffold: `manage_permission_id`, `admin_permission_id` (nullable), `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` (nullable). The legacy `view_permission` text column still carries the read permission's `permission_name` (e.g. `"itsm:read"`).

Present the list as a compact table (`module_name`, `module_slug`, `module_type`, `description`). Ask the user which module to extract. Do not guess when multiple candidates match, ask. Master modules are valid extract targets — the resulting model file will declare `module_type: master` in its frontmatter (see Stage 4).

Capture `module_id`, `module_name`, `module_slug`, `module_type`, and `description` for the rest of the pipeline. Never create a module here; this skill is read-only.

---

## Stage 2: Read the module state

Pull the full schema:

```bash
# Module already resolved above; re-read only if you need the exact row.
# Filter on module_slug (the URL handle), not module_name (which is now the display name).
semantius call crud read_module '{"filters": "module_slug=eq.<slug>"}'

# Entities belonging to this module, in creation order
semantius call crud read_entity '{"filters": "module_id=eq.<id>", "order": "created_at.asc"}'

# Fields — read the whole catalog once and filter client-side; cheaper than N reads
semantius call crud read_field '{}'
```

Build in memory:

- **module**, `module_name` (display name, e.g. `CRM`), `module_slug` (URL handle, e.g. `crm`), `module_type` (`"domain"` or `"master"`), `description` (compact tagline, ≤40 chars)
- **entities[]**, each with `table_name`, `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `edit_mode`, `cube_mode`, `module_id`, **`computed_fields`** (JSON array, may be empty), **`validation_rules`** (JSON array, may be empty). `searchable` and `is_child` are read-only / auto-computed and only used for sanity checks; do not round-trip them.
- **fields_by_table**, map keyed by `table_name`, per field: `field_name`, `format`, `title`, `description`, `unique_value`, `reference_table`, `reference_delete_mode`, `relationship_label`, `singular_label_parent`, `plural_label_parent`, `cube_type`, `enum_values`, `default_value`, `ctype`, `field_order`, `searchable`
- **master_modules_by_slug**, map of every `module_type = "master"` module in the catalog keyed by `module_slug`. Read once via `semantius call crud read_module '{"filters": "module_type=eq.master"}'` and hold for Stage 3 (related-table classification) and Stage 4 (per-entity `**Shared master cluster:**` annotation emission). Includes the module being extracted when it is itself a master.

**Strip auto-generated fields** before rendering. Do not render these in §3:

| Field name | Why skipped |
|---|---|
| `id` | Auto-created primary key |
| `label` | Auto-created computed display field (the *generic* one, `ctype: label`, distinct from the named `label_column` field) |
| `created_at`, `updated_at` | Auto-maintained timestamps |

**Keep** the named `label_column` field (e.g. `product_name`, `subscription_name`). It *is* rendered as a §3 row, marked `label_column` in the Notes column, because that is how the analyst's template expresses it and how the deployer round-trips.

Identify `label_column` by matching `field.field_name == entity.label_column`. In Semantius that row has `ctype: label` but a non-generic `field_name`, which is how it differs from the skipped generic `label` row.

---

## Stage 3: Discover related tables (self-containment)

The analyst's template requires the model to be self-contained, every entity referenced by any FK must appear as its own §3 section, even if the referenced entity lives in another module or is a Semantius built-in.

Walk every field in our module's entities where `reference_table` is non-empty. For each target `table_name`:

- **Target is in our own module** → already included; skip.
- **Target is in a different module** → add to a `related_entities[]` list and pull it in.
- **Target is a Semantius built-in** (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`, see `use-semantius/references/data-modeling.md` for the authoritative list) → add to `related_entities[]` and pull it in. Built-ins are included as normal §3 entities; the `semantic-model-deployer` skill deduplicates them at deploy-time.

For each related table:

```bash
semantius call crud read_entity '{"filters": "table_name=eq.<name>"}'
semantius call crud read_field '{"filters": "table_name=eq.<name>"}'
```

Apply the same auto-field stripping from Stage 2.

**Recursion depth.** In principle a related table might reference yet another table. In practice:

- Always walk one level out.
- Walk a second level **only** if the second-level target is a Semantius built-in (most commonly `users`), this keeps the model self-contained without dragging in an entire sibling module.
- Stop at two levels. If the third level would add yet another non-built-in entity, do not include it; instead, note it in §7.2 as a future consideration (e.g. *"Should `<entity>` be included to round out FK targets for `<related>`?"*).

Record for each entity whether it came from our module or `related_entities[]`, §8 lists the external ones explicitly.

---

## Stage 4: Write the semantic-model file

Follow `semantic-model-analyst/references/semantic-model-template.md` verbatim. Mapping from live state to template:

| Live property | Template location |
|---|---|
| `module.module_name` | front-matter `system_name`, top-level `#` heading |
| `module.module_slug` | front-matter `system_slug`, §8 module name |
| `module.module_type` | front-matter `module_type` (emit only when value is `"master"`; omit entirely when `"domain"`) |
| `module.description` | front-matter `system_description` (verbatim, it is already the compact tagline) **and** §1 Overview seed (see §1 Overview rules below; do not invent facts, stay faithful) |
| `entity.table_name` | §2 Table name, §3 sub-heading, §4 From/To |
| `entity.singular_label` | §2 Singular label, §3 sub-heading suffix |
| `entity.plural_label` | §3 Plural label line |
| `entity.description` | §3 Description |
| `entity.label_column` | §3 Label column |
| (derived from `entity.module_id` + `master_modules_by_slug`) | §3 `**Shared master cluster:** <slug>` line, emit when the entity's home module is `module_type: master`; the cluster name IS the master module's slug. Omit the line entirely otherwise. |
| `entity.audit_log` | §3 `**Audit log:** yes \| no` line, render `yes` when `true`, `no` when `false`/null |
| `entity.edit_mode` | §3 `**Edit mode:** auto \| sidebar \| modal \| page` line, render the live value as-is. **Omit the line entirely when the live value is `auto`** (the platform default), so the round-trip through the deployer stays clean (the deployer also defaults `auto` when the line is absent). |
| `entity.cube_mode` | §3 `**Cube mode:** disabled \| auto` line, render the live value as-is. **Omit the line entirely when the live value is `disabled`** (the platform default), same rationale as `edit_mode`. |
| `entity.computed_fields` | §3 `**Computed fields**` sub-block as a fenced ```` ```json ```` array, byte-for-byte. Omit the heading entirely when the array is empty (`[]`). Never paraphrase JsonLogic into prose. |
| `entity.validation_rules` | §3 `**Validation rules**` sub-block as a fenced ```` ```json ```` array, byte-for-byte. Omit the heading entirely when the array is empty (`[]`). Never paraphrase JsonLogic into prose. |
| `field.field_name` | §3 Field name |
| `field.format` | §3 Format (the live value is already from the analyst's vocabulary) |
| (inferred) | §3 Required, the platform manages nullability internally and does not expose a per-field flag. Infer: `format: parent` → `yes`; `format: reference` → `no`; other formats default to `yes`. |
| `field.title` | §3 Label |
| `field.reference_table` + `reference_delete_mode` | §3 Reference / Notes + §4 summary row |
| `field.enum_values` | §3 Notes (`values listed in §5.N`) and a §5 sub-section |
| `field.unique_value` | §3 Notes (`unique`) |
| `field.description` | §3 **Description** column (5th column, analyst v1.8+). Render the live value verbatim into the cell; if empty, leave the cell blank. Never paraphrase. Never smuggle the description into the Reference / Notes column — that's the v1.7 convention the v1.8 split was designed to retire, and it trips the analyst's audit `🔴 Free prose in Notes` rule. |

### §1 Overview

§1 is **two or three sentences of plain domain prose**, expanded from `module.description` (the compact tagline) using entity names and descriptions as supporting signal. It seeds catalog discovery and is consumed verbatim by downstream skills, so its content contract matters. Apply the analyst v1.7 rules verbatim (auditing the optimizer's own output otherwise flags every reverse-engineered file as 🟡):

- **No §-number cross-references** (`§3`, `§6`, `§7.2`, "see §3"). The narrative reads as standalone prose; pointers to other sections are an audit-of-the-file artifact, not catalog content.
- **No snake_case identifiers or column-shaped tokens** (`cost_center_id`, `features.cost_center_id`, `cost_allocations`). Use plain domain words ("cost centers", "cost allocations") if the concept genuinely belongs in the narrative; usually it doesn't.
- **No platform plumbing vocabulary**: `Semantius`, `deployer`, `optimizer`, `module`, `built-in`, `auto-field`, `at runtime`, `reconciles`, `extracted from live state`. §1 talks about the system the user is modeling, not about the file or the catalog that holds it. Don't narrate the fact that the file was reverse-engineered, the front-matter and the absence of `initial_request` already signal that.
- **No scope-deferral narration**: "deliberately out of scope", "moved to a sibling domain", "deferred to <Domain>", "links out via". The audit detects deferrals from `related_domains` + §6, not from prose.
- **Two or three sentences**, no more. Additional paragraphs that narrate authoring choices or mechanics are noise.

Plain example for an extracted CRM module: *"Tracks the lifecycle of leads, accounts, and opportunities for the sales team. Captures contact history, deal pipeline, and forecast roll-up. Connects accounts to the contracts and subscriptions they own."*

### Front-matter

```yaml
---
artifact: semantic-model
version: "<CURRENT_VERSION from analyst SKILL.md>"
system_name: <module.module_name>
system_description: <module.description>
system_slug: <module.module_slug>
# module_type: master   # emit only when module.module_type == "master"; omit when "domain"
# domain: see inference rule below — omit when no canonical category fits
naming_mode: agent-optimized
created_at: <today, YYYY-MM-DD>
entities:
  - <table_name_1>
  - <table_name_2>
# departments, industries, related_domains: see carry-over / inference rule below
---
```

**`module_type` is taken directly from `module.module_type`.** When the live value is `"master"`, emit the key with value `master`. When `"domain"` (the platform default), omit the key entirely — analyst v3.0 treats absence as `"domain"`, and emitting `module_type: domain` on every file would just be noise. Master modules are formalized domain clusters that host shared / master data (vendors, currencies, departments) consumed by multiple domain modules; the round-trip through the optimizer preserves that classification.

**`version` is required.** Read the analyst's "Skill version" section (loaded in Step 0) and copy the `CURRENT_VERSION` value verbatim, as a quoted string `"MAJOR.MINOR"`. Every file written by the optimizer is stamped with the current analyst version, regardless of any prior file's value. The downstream deployer will reject files whose major doesn't match its expected major, so this stamp is what keeps the round-trip clean.

**`entities` is required.** Populate it from the live module's entity list, every `table_name` rendered in §2 (in §2 order, lowercase snake_case). Include only the entities owned by *this* module; do **not** list `related_entities[]` pulled in for self-containment, since the discovery tag is meant to identify what the model is about, not its FK neighborhood. Regenerate every run from live state, never trust a prior file's list.

**`system_name` is taken byte-for-byte from `module.module_name`.** The live display name is authoritative, preserve casing and acronyms exactly as stored (`CRM`, `ITSM`, `CMDB`). Do not retitle, expand, or "tidy" it during reverse-engineering.

**`system_slug` is taken byte-for-byte from `module.module_slug`.** Preserve the slug exactly as stored, even when it looks like a bare acronym (`ats`, `crm`, `erp`). Do **not** "improve" it to a more descriptive form during reverse-engineering: changing the slug would change the deployed module's identity and break permissions, downstream skills, and any references stored elsewhere. The analyst skill flags acronym-shaped slugs as a 🟡 Warning when *authoring*, but for the optimizer the live state wins, that warning does not apply here.

**`system_description` is taken byte-for-byte from `module.description`.** It is already the compact tagline (≤40 chars) the platform stores; copy it through unchanged. If the live `module.description` is empty or missing, fall back to inferring a tagline from `module.module_name`: for an acronym name, the plain English expansion (`CRM` → `Customer Relationship Management`, `ITSM` → `IT Service Management`); for a non-acronym name, a 2-4 word disambiguating phrase. Note in §7.2 that the tagline was inferred so the user knows to confirm and push back to live state via `update_module` if it doesn't match.

**`domain`, infer from the entities you just read.** `domain` is not stored in Semantius. The live entity names are usually the strongest signal, a module containing `tickets`, `incidents`, `agents` is `ITSM`; one containing `leads`, `accounts`, `opportunities` is `CRM`; one containing `employees`, `positions`, `time_off` is `HRIS`; one dominated by clinical entities is `EHR`. Use the module label and description as supporting signal but the entity shape is what disambiguates.

The vocabulary is open: prefer the common values (`CRM`, `ITSM`, `HRIS`, `LMS`, `ERP`, `PIM`, `Project Management`, `Field Service`, `Subscription Billing`, `CMS`) when one fits cleanly, otherwise coin a new Title-case / acronym value that captures the system shape (`Talent Acquisition`, `EHR`, `Compliance`, `MES`). Only omit `domain` when you genuinely can't categorize the system. **Never write `custom`**, it adds zero discovery signal. A prior file's `domain` value is *not* carried over, re-infer from live state every run.

**`departments` and `industries`, carry over when a prior file has them, otherwise infer from the gathered live state.** These tags aren't columns in Semantius, but the live state still carries plenty of signal, `module.module_name`, `module.description`, the entity names you just read in Stage 2, the field names within those entities, that maps to the same inference the analyst makes from a Stage 1 capture. Use that signal, not a guess from the module name alone. **Use Title-case / acronym form** (`Sales`, `IT`, `HR`, `Healthcare`, `SaaS`, `Financial Services`), never lowercase snake_case.

Two cases for `departments` / `industries` at Stage 4:

1. **Prior file exists with the key.** Copy it byte-for-byte into the new file (same mechanic as `initial_request`). The user has already curated these tags; respect that.
2. **Prior file is missing the key (or no prior file at all).** Re-run the analyst's Stage 11 inference rule against the gathered live state. If you can confidently propose a value, include it. If you have low or no confidence, omit the key. Never invent a value with no supporting signal.

Either way, the result is a single concrete YAML key (or omission). Do not block on user input.

**`related_domains`, always re-walk via the analyst's two-axis Stage 6 rule, even when the prior file has values.** This is a v1.7 analyst rule the optimizer must mirror; pure carry-over (and pure entity-shadow inference) reproduces the v1.6 failure mode where a neighboring domain disappears from the tag list because no live entity happens to shadow it. Run **both** axes from analyst knowledge of the domain and the live entity shape, then merge with any prior values:

- **Axis 1 — System-type walk (run first).** Independent of which entities are in §3, ask: *"What does a typical instance of this kind of system sit next to in a typical organization's enterprise stack?"* The answer is driven by the inferred `domain` and the kind of work the system represents, not by the current entity list. A Product Roadmap is next to OKR, Issue Tracking, Release Management, CRM, Identity & Access, AND Budgeting (because features cost money in every organization, whether or not *this* roadmap tracks cost internally). An ITSM helpdesk is next to ITAM, CMDB, HRIS, Identity & Access. An ATS is next to HRIS, Workforce Planning, Identity & Access. Produce this list from analyst knowledge of the system's domain, before walking §3.
- **Axis 2 — Entity-driven shadowing walk.** Then walk every §3 entity (including `related_entities[]` from Stage 3) and apply the shadowing test: *"would a dedicated enterprise system model this concept in meaningful depth?"* If yes, add the corresponding domain when it is not already on the Axis-1 list. Familiar shadows: `objectives` shadows OKR, `users` shadows Identity & Access, `vendors` shadows Vendor Management, `assets` shadows CMDB / ITAM, `tickets` shadows ITSM, `employees` shadows HRIS, `releases` shadows Release Management, `features` shadows Issue Tracking. Junctions and weak shadows (`comments`, `tags` that no enterprise system materially expands on) are skipped; on borderline cases the bias is toward inclusion.
- **Absence of an internal shadow is NOT evidence the domain is not a neighbor.** Axis 1 catches what Axis 2 misses. If the prior file listed a neighbor (e.g. Budgeting next to a roadmap) and the live module has since dropped its `cost_centers`, the neighbor still belongs in `related_domains` because the neighborhood is about the *system type's position in the enterprise*, not the current §3 count. Do **not** silently drop a prior-file domain just because no live entity shadows it; re-derive via Axis 1 and confirm.
- **Merge with prior values, take the union.** Axis 1 ∪ Axis 2 ∪ prior-file values. Never silently drop a prior-curated value just because the new walk didn't surface it (the prior value reflects user-confirmed neighborhood knowledge); only drop when the live module's `domain` has clearly shifted and the prior tag is now misleading. Use **Title-case / acronym form** (`ITAM`, `CMDB`, `Change Management`, `Vendor Management`, `Identity & Access`), never lowercase snake_case.
- **Result is a concrete YAML list (or omission when the system genuinely has no adjacent domains, rare).** Do not block on user input; if Stage 5 runs, the user can review and edit the inferred neighborhood there.

> **🛑 Do not search the workspace for existing semantic-model files.** This skill exports the currently-live module from Semantius, the live state *is* the source of truth. Never glob `*semantic-model*.md`, and never read unrelated semantic-model files. Other systems' models tell you nothing about this module, and the template (already loaded in Step 0) is the only style reference you need.

**`initial_request`, one-field carry-over from a matching prior file, if and only if it exists.**

At Stage 4, do exactly this, no broader search:

1. Try to read the **exact path** `{system_slug}-semantic-model.md` in the workspace folder. Accept "file not found" as the answer and move on, that is the common case.
2. If and only if that file exists **and** contains a non-empty `initial_request` front-matter key, copy **that single value** byte-for-byte into the new file's front-matter as a YAML literal block. The analyst's immutability rule applies across the cycle: the original ask is a historical record, not yours to rewrite.
3. If the file exists but has no `initial_request` (or has an empty one), **omit the key entirely** in the new file. Do not invent a placeholder, do not write a synthetic "extracted on …" value.
4. If the file does not exist, **omit the key entirely**. The analyst's audit treats missing `initial_request` as a 🟡 Warning (not a blocker), which correctly signals that this file was reverse-engineered.

> **Only the user-curated metadata is preferentially carried over, nothing else.** From the prior file, copy `initial_request` (immutable historical record), `departments`, `industries`, and `related_domains` byte-for-byte if present. `initial_request` is purely carry-over (omit when absent, never invent). `departments`, `industries`, and `related_domains` fall back to live-state inference when the prior file lacks them, see the dedicated rule above. Do not copy `domain`, `naming_mode`, `system_name`, the §1 Overview prose, the §2 entity list, or any structural content, the live module is the source of truth for everything the platform stores, and the prior file's structural content may be stale relative to what users have since customized in Semantius. Regenerate everything except those carry-over keys from live state.

**`naming_mode`** is not persisted in Semantius. Always write `naming_mode: agent-optimized` unless the user tells you otherwise in this conversation. **`domain`** is handled by its own inference rule above, never default it to `custom`, never carry over from a prior file; either infer from entities or omit.

### Computed fields and validation rules round-trip

Render each entity's `computed_fields` and `validation_rules` arrays into the §3 sub-blocks **byte-for-byte**, wrapped in fenced ```` ```json ```` blocks. The deployer reads these arrays and passes them back to `create_entity` / `update_entity` verbatim, so any reformatting (key reordering, whitespace normalization, JSON5-style trailing commas) breaks the round-trip silently — the deployer would re-deploy a "different" array and the live trigger would regenerate without functional change but with a noise diff.

**Rules:**

- When the live entity's array is empty (`[]`), **omit the §3 heading entirely**. Do not write `**Computed fields**` followed by an empty `[]` block; that's scaffolding noise. The analyst's audit treats absence as "no rules" and that's the correct round-trip.
- When the live array is non-empty, render `**Computed fields**` (or `**Validation rules**`) on its own line, blank line, then a ```` ```json ```` fenced block containing the array. Pretty-print the JSON with 2-space indentation so a human reviewer can read it; this is the canonical form the analyst writes too, so the round-trip stays stable.
- Do **not** add a `description` to entries that lack one in live state, and do not fabricate. If the live entry has no `description` key, the rendered JSON entry has none either.
- Do **not** paraphrase JsonLogic into prose, and do not "explain" the expression in the §3 prose around it. The expression is the contract.

### Reference notation in §3 Notes

- `format: reference` → `→ <target> (N:1, <delete_mode>)`
- `format: parent` → `↳ <target> (N:1, <delete_mode>)`
- Self-reference (`reference_table == table_name`) → append `; self-ref for hierarchy` or similar
- When the field carries a non-empty `relationship_label`, append `, relationship_label: "<verb>"` to the same Notes cell so the round-trip preserves it
- For `parent` fields with non-empty `singular_label_parent` / `plural_label_parent`, append `, parent label: "<singular>" / "<plural>"` so the override is preserved on re-deploy
- For fields with `cube_type` ∈ {`dimension`, `measure`, `disabled`} (i.e. anything other than the `auto` default), append `, cube_type: <value>`
- When `default_value` is non-empty, append `, default: "<value>"` so the round-trip preserves it. The deployer relies on this annotation to satisfy Postgres' NOT NULL / CHECK constraint when the field gets re-added to a non-empty table.

### §4 Relationship summary

One row per FK field. Cardinality at the FK side is always N:1 in Semantius. The 1:N / M:N / 1:1 views are inferred from the direction.

Detect junctions: an entity whose fields (after auto-field stripping and after the `label_column` row) are exactly two `parent` FKs is a junction. Mark those rows `parent (junction)` in §4 Kind.

### §2 Mermaid flowchart

Follow the analyst's convention verbatim (`-->` = many, `---` = one, arrows point parent → child):

- For every `reference` or `parent` FK: draw `<reference_table> --> <child_table>`. One edge per FK, not one per entity pair.
- For junctions: draw each of the two parent entities `-->` into the junction entity. Never draw a direct edge between the two parents.
- Self-references: draw `<entity> -->|parent of| <entity>` (self-loop).
- **Edge label comes verbatim from the field's `relationship_label`**, render it as `|<verb>|` exactly as stored in `fields_by_table[entity][field].relationship_label`. **Never invent, paraphrase, shorten, or "polish" the verb**, if live state says `"owns"`, the diagram says `|owns|`, not `|has many|` or `|holds|`. When `relationship_label` is empty/null, leave the edge unlabeled. The Stage 5 audit will flag empty values; this stage's job is to surface live state truthfully, not to fill gaps with guesses. Self-reference fallback (`|parent of|`) is the one exception, used only when no `relationship_label` is set on the self-reference field.
- Also persist the same verb on the FK row in §3 Notes as `relationship_label: "<verb>"` so the round-trip preserves it. The §3 annotation and the diagram label must agree byte-for-byte.

**Build-then-verify procedure (mandatory):**

1. **Build mechanically from `fields_by_table`.** For every FK with a non-empty `reference_table`, emit one edge labeled with the literal `relationship_label` value from live state, or no label if the value is empty/null. Do not consult your intuition about what a "good" verb would be; the platform owns that string now.
2. **Self-verify before saving.** After the Mermaid block is drafted, walk every edge and confirm three things:
   - it corresponds to a real FK row in §3
   - the edge label, when present, equals the field's `relationship_label` byte-for-byte (no hallucinated, paraphrased, or "improved" verbs)
   - the same verb is also written to that FK's §3 Notes as `relationship_label: "<verb>"`
   If any mismatch is found, regenerate the affected edge from live state. The Stage 5 audit treats hallucinated verbs as data corruption, do not save a file that fails this check.
- `flowchart LR` is the default; switch to `flowchart TB` if the graph is wider than tall.

Regenerate the diagram from the field data every run. Never reuse a diagram from a prior `.md`, that is exactly what would go stale.

### §5 Enumerations

One sub-section per field whose `enum_values` is non-empty, sub-numbered in §2-table order. Skip fields with empty or null `enum_values`. Write the values as a bullet list, one per line, code-fenced (`` `value` ``).

### §6 Cross-model link suggestions

Live extraction is reverse-engineering, not authoring. Every cross-module FK that already exists in the catalog appears as a normal §3 reference field (with `reference_table` pointing at an entity from another module, pulled in via Stage 3's `related_entities[]`). There is no need to *suggest* a link the catalog already has.

Always write `No cross-model link suggestions.` under §6. The `related_domains` front-matter is independent: infer it from the live entity shape and module description (the same way `domain` is inferred), since a discovery tag for humans browsing the catalog still adds value on a reverse-engineered model. If the user wants speculative §6 hint rows (links that *would* add value if other modules later arrive), they author them via the analyst skill in Extend mode after the optimizer's output is saved, that is not the optimizer's job.

### §7 Open questions

- **§7.1 🔴 Decisions needed**, write `None.` Live extraction doesn't propose anything, so nothing is ambiguous that would block redeployment.
- **§7.2 🟡 Future considerations**, write `None.` unless Stage 5 is run and surfaces items you choose to demote here.

Keep both sub-headings even when empty, per the template.

### §8 Implementation notes

Follow the analyst's §8 checklist verbatim. In addition:

- List every entity that came from `related_entities[]` in Stage 3, with its home module (or "Semantius built-in") so the downstream `semantic-model-deployer` knows to reuse, not recreate.
- Preserve the creation-order constraints, entities without FKs first, junctions last, with a second pass for self-references and mutual cross-references.

### Save

Write to `{system_slug}-semantic-model.md` in the workspace folder. If a file with exactly that name already exists, confirm before overwriting (it might have manual edits), but do **not** read it to "merge" anything; the live module is the source of truth and what you just built from live state is what gets saved. Check only by targeted path; do not glob the workspace. After saving, report a one-line summary:

> Extracted `<slug>`: N entities (K from other modules / built-ins), M fields, E enums. Saved to `<slug>-semantic-model.md`.

Then move to Stage 5.

---

## Stage 5: Suggest optimizations (opt-in)

After the file is saved, ask one question:

> "Would you like me to suggest optimizations for this model?"

If **no**, done. Do not push further.

If **yes**, run the Mode B audit from `semantic-model-analyst/SKILL.md` against the file you just wrote. Report findings in the analyst's exact format (🔴 Blockers, 🟡 Warnings, 🟢 Suggestions, with an overall one-line verdict).

### Audit findings that are expected on a reverse-engineered file

A few of the analyst's checks are designed for greenfield authoring and will fire on every file the optimizer writes by construction, not because the live module is broken. **Demote these to an "expected on extraction" note in the report rather than surfacing them as actionable**, otherwise every reverse-engineered file looks worse than it is and the user learns to ignore the audit:

- **🟡 `initial_request` missing.** The analyst writes this from a Stage 1 capture; the live module has no equivalent and the optimizer omits the key when no prior file exists. The audit's own rule treats this as 🟡, not 🔴, exactly because reverse-engineered files won't have it. Note this as expected, do not propose to backfill (a synthetic "extracted on …" value would lie about the historical record).
- **🟡 §6 completeness against `related_domains`.** Analyst v1.5+ flags 🟡 when a `related_domains` entry has zero §6 rows. Stage 4 of this skill deliberately writes `No cross-model link suggestions.` because live extraction is reverse-engineering, not authoring; every cross-module FK that the catalog actually carries already shows up as a normal §3 reference field. Surface the analyst's finding as expected-noise on extracted files, then offer a concrete handoff: *"If you want speculative §6 hint rows for `<domain1>`, `<domain2>`, …, route to the analyst skill in Extend mode against this file."* The analyst is the right home for that authoring pass; the optimizer stays read-only against the catalog.
- **🟡 Pair-overlap and system-type-neighbor §6 rules from analyst v1.7.** Same rationale, the optimizer doesn't author §6 hints. Group these with the §6 completeness finding above so the user sees one expected-noise block, not three.

Everything else in the analyst's audit is real signal even on a reverse-engineered file (label_column shape, naming consistency, format/kind coupling, computed_fields / validation_rules integrity, `relationship_label` quality), surface those as actionable findings.

### Optimizer-specific checks (on top of the analyst's audit)

Checks that are most useful when the source is live state, not a greenfield draft:

- **Missing `label_column`**, an entity with a blank `label_column` in live state breaks the analyst's and deployer's expectations. **🔴 Blocker.**
- **`label_column` is a FK**, an entity where `label_column` matches a `reference` or `parent` field. Per `data-modeling.md`, Semantius auto-creates a field with the same name as `label_column`, which collides with the FK. Suggest a dedicated scalar label field (e.g. `<entity>_label`), especially for junction tables. **🔴 Blocker.**
- **Singular-form `table_name`**, per Semantius platform rule. **🔴 Blocker.**
- **Inconsistent singular/plural labels**, `singular_label` should be the bare singular; field-level titles (e.g. "Product Name") belong on the auto-created `label` field's `title`, never on the entity's `singular_label`. **🟡 Warning.**
- **Missing descriptions**, entities or fields with empty `description` suggest the spec drifted during live customization. **🟢 Suggestion.**
- **Entities with no incoming or outgoing FKs**, an isolated entity is sometimes a real root (e.g. `users`) and sometimes an oversight. **🟡 Warning** unless it's clearly a root.
- **Likely missing junction**, two entities that look like they should have an M:N link (based on naming heuristics) but don't. **🟢 Suggestion.** Be conservative, false positives here are noise.
- **Missing or weak `relationship_label`**, any FK field with empty `relationship_label`, or a filler verb (`"has"`, `"references"`, `"belongs to"`, `"relates to"`). The verb is now managed metadata that drives the §2 Mermaid diagram, navigation breadcrumbs, and ER docs in the Semantius UI, empty or generic values reproduce on every UI surface. **🟡 Warning.** Propose a domain-specific verb in the parent's voice (e.g. `accounts → opportunities` is `"owns"`, `users → tasks` is `"manages"`). When live state has many empty values (a module that predates the field), offer one batch sweep that proposes verbs across all FKs in one pass, do not turn it into a per-FK Q&A.
- **Same-parent FKs with identical / missing `relationship_label`**, e.g. `tasks.created_by_user_id` and `tasks.assigned_to_user_id` both → `users` with the same or empty verb. The verbs must differentiate. **🔴 Blocker.**
- **`computed_fields` references a non-existent field**, the live entity carries a `computed_fields[].name` that does not match any field on the entity. The platform should have rejected this on write, but live drift (a field rename or delete after the rule was set) can leave it stale. **🔴 Blocker.** Surface in the report and propose either fixing the JsonLogic to point at the renamed field or removing the entry.
- **`validation_rules` carries duplicate `code` within an entity**, two entries share a `code`. **🔴 Blocker.** Surface the codes; only one will keep its UI/i18n binding.
- **`validation_rules` entry missing `message`**, the platform's default error text has nothing to return. **🟡 Warning.** Propose a default English message tied to the rule's intent.
- **`computed_fields` / `validation_rules` references cross-row data**, the JsonLogic expression names a column that is not on this entity. **Check the shape before flagging.** If the column reference is qualified by a `set_record` / `let` binding (e.g. `{"var": "order.status"}` inside `{"set_record": ["order", "orders", ...]}`), the platform resolves it against the bound entity at runtime — this is the canonical analyst-v3.2 cross-entity pattern (parent-state gate, inherited value, merged label) and is **valid**. Walk the binding's `<entity_name>` against the live catalog: if it exists and the bound `<column>` is a real field on that entity, emit no warning. An *unbound* reference to a missing column, or a `set_record` against an entity that doesn't exist in the live catalog, is a 🟡 Warning. True aggregates and table scans remain out of scope and stay 🟡 (`set_record` reads a single row by id, not many).
- **JsonLogic expression is malformed**, the live entity carries an entry whose `jsonlogic` is not a valid expression (the platform usually rejects this on write, but bypass paths exist). **🔴 Blocker.** Surface the offending entry's index and propose a fix.

After presenting the report, ask:

> "Want me to apply the 🔴 blockers and 🟡 warnings to the `.md` file?"

If yes:

- **Only update the `.md` file**, never touch live Semantius. Live changes are the deployer's job and require a re-deploy pass.
- Regenerate the §2 Mermaid diagram if any relationship-affecting fix is applied.
- Before writing, re-run the analyst's self-audit pass on the updated draft, don't save a file that fails its own audit.
- Save back to the same filename. Share a one-line summary of what changed.

### Offer to redeploy

Once the updated `.md` is saved, the `.md` and the live module have drifted, the `.md` now reflects the fixes, Semantius still holds the unfixed shape. Close the loop by asking:

> "The `.md` file now has those fixes, but Semantius still holds the pre-fix shape. Want me to hand this off to the `semantic-model-deployer` skill to redeploy the corrected model?"

If **yes** → invoke the `semantic-model-deployer` skill with the saved `.md` file as its input. The deployer's own workflow takes over from there (parse, inspect, plan, execute), do not try to duplicate its logic here.

If **no** → stop. Mention that the user can redeploy later by invoking the deployer against the saved `.md`.

Only make this offer when fixes were actually applied. If Stage 5 ran but the user declined to apply the findings, or the audit came back clean with zero 🔴/🟡, the `.md` matches live state, there is nothing to redeploy, and asking would be noise.

### Offer a Mode D rebuild when the audit surfaces structural drift

The Stage 5 audit catches rule violations in the live shape; it does not reconsider entity granularity, naming choices, or scope boundaries. When the findings make it clear the live module has drifted *structurally* (a long list of 🟡 / 🔴 across many entities, junk entities the live admin added that don't fit the domain, an entity that has accumulated unrelated fields and now models two concepts, a slug that no longer matches what the system has become), suggest the analyst's **Mode D Rebuild** as a parallel option:

> "The live module looks like it has drifted structurally beyond what spot-fixes can clean up (`<short reason>`). Want me to hand the saved `.md` to the `semantic-model-analyst` skill in Mode D (Rebuild)? Mode D treats the file as archived knowledge and re-authors a brand-new model at the current analyst version, keeping `initial_request` (if any) and curated metadata, with every other decision back on the table."

If **yes** → invoke the analyst skill with the saved `.md` as input and "Mode D" as the explicit mode signal. The analyst's own workflow takes over (Stages 1-4 run end-to-end with the prior content as Stage 1 seed); do not attempt to drive the rebuild from here.

If **no** → stop. Mention the option remains available, and that the deployer hand-off above is still the right path for spot-fix-level changes.

Only make this offer when the audit findings genuinely point at structural drift, not when they are spot-fixable rule violations (a missing `relationship_label`, a label-column FK collision, a malformed JsonLogic expression). For those, the redeploy path above is the right call. Mode D is the heavier hammer for the case where the live module no longer resembles the system the model is meant to describe.

---

## What this skill does not do

- Does **not** write to Semantius. Read-only reverse-engineering.
- Does **not** capture RBAC roles, permissions, user assignments, or webhook receivers, those are out of scope for the semantic model (the analyst excludes them too).
- Does **not** capture sample business data, schema only.
- Does **not** invent `naming_mode`, defaults to `agent-optimized` unless the user says otherwise. `domain` is inferred from the live entity shape (per the dedicated rule in Stage 4), or omitted when no canonical category fits, never written as `custom`.
- Does **not** duplicate the analyst's Audit mode. If the user wants a pure audit of an existing `.md` file without touching Semantius, route them to `semantic-model-analyst` in Audit mode. Use this skill only when the *live state* is the source of truth.
