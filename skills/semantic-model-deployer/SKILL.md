---
name: semantic-model-deployer
description: Safely deploys a *-semantic-model.md file (produced by the semantic-model-analyst skill) to a live Semantius instance using the semantius. Before any writes, reconciles the model against the existing catalog — updates an existing module in place when the slug matches, extends Semantius built-ins (`users`, `roles`, `permissions`, …) additively instead of replacing them, refuses duplicate entity names across modules, and surfaces explicit merge/rename decisions for near-duplicates (e.g. `contracts` vs `saas_contracts` vs `vendor_contracts`). Use whenever a semantic-model file exists and the user wants to deploy, apply, push, sync, integrate, reconcile, or roll out the model — including phrasings like "implement the model", "deploy the model", "apply the schema", "set up the entities", "create the entities in Semantius", "push this to Semantius", "integrate this model with what's already there", or "now make it real". Also trigger when the user uploads or references a *-semantic-model.md and asks to do anything that would materialize it. Trigger proactively when such a file is present and the user's intent is clearly to deploy it.
---

# semantic-model-deployer Skill

This skill bridges the gap between a self-contained semantic model (produced by the `semantic-model-analyst` skill) and a live Semantius instance.

**Division of responsibility:**
- This skill owns the *workflow* — parsing the model, inspecting what's already deployed, diffing, deduplicating against built-ins, **detecting name collisions and near-collisions across the entire entity catalog**, planning, and orchestrating the sequence of steps.
- The **use-semantius skill** owns the *execution* — all Semantius operations are done via the `semantius` CLI tool, following that skill's patterns and reference docs.

## Your role: gatekeeper of a unified catalog

Semantius is a **unified platform — a universal system of records**. It is **not** a collection of independent silos stitched together. Each semantic model you implement is a *point solution* that drops into a shared catalog of modules, entities and fields. Other point solutions have been — or will be — installed into the same instance.

**Two entities called `contracts` owned by two different modules is exactly the kind of drift that makes the platform unusable for both humans and agents.** The moment the catalog contains ambiguous names, downstream reasoning falls apart: users don't know which table to use, agents pick the wrong one, reports double-count, and FK references point to the wrong concept.

**The federation contract.** Closing silos goes beyond name-collision policing. Each model declares its links to neighboring modules in §8 Related domains and the front-matter `related_models` array. When a related sibling is already deployed, the deployer must (a) reuse the sibling's tables for any **Defers to sibling** entries (same machinery as built-in dedup), and (b) propose additive FK extensions to the sibling's tables for any **Expects on sibling** entries (always user-confirmed; declines persist on sibling module metadata so the proposal does not nag on every redeploy). Cross-module changes are strictly additive — new optional FKs and new fields on existing tables — never renames, type changes, or deletions. See Stage 2g and Stage 4f.

Your job as the implementer is to **refuse to introduce ambiguity**. Before creating any entity you must:

1. Check whether it already exists as a built-in (see Stage 2b) — never replace, may extend additively.
2. Check whether it already exists as a custom entity in this same module (Stage 2c) — this is a re-run; update in place.
3. Check whether an entity with the **same** name already exists in a **different** module (Stage 2d) — **ambiguity gate; the user must decide merge vs rename before you proceed.**
4. Check whether an entity with a **similar** name exists anywhere (Stage 2d) — **ambiguity gate; the user must decide.**

Never silently coexist conflicting names. Never pick a side for the user. Resolving catalog ambiguity is the single most important thing this skill does.

**This skill is designed to be re-run whenever the model changes.** Because it always inspects Semantius before acting, re-running on an updated model is safe — it diffs the new model against what's already deployed and applies only the delta (new entities, new fields, updated labels/enums). If a module with the same `system_slug` already exists, **always update that module** — never create a duplicate. Things that haven't changed are skipped. Things in Semantius that are no longer in the model are left alone.

**The model is self-contained.** The semantic-model file produced by `semantic-model-analyst` declares every entity the domain needs, including ones that happen to overlap with Semantius built-ins (e.g. `users`, `roles`, `permissions`, `webhook_receivers`). Those built-ins are platform infrastructure — they control authentication, RBAC, and integration, and **must never be replaced**. They *may* be extended additively (new fields on `users`, for instance). See Stage 2b.

---

## Step 0: Load the use-semantius Skill

Before doing anything else, read the use-semantius skill and its data-modeling reference:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
```

The data-modeling reference gives you the mandatory creation order, all field formats, the Golden Rules, and exact CLI syntax. Everything in the execution stages below follows those patterns. Also read `references/cli-usage.md` if you need help with CLI invocation, piping, or error handling.

All Semantius operations in this skill are performed using the **`semantius` command-line tool**, for example:

```bash
semantius call crud read_module '{"filters": "name=eq.lead_manager"}'
semantius call crud create_entity '{"data": {...}}'
```

---

## High-Level Workflow

```
1. Parse PRD  →  2. Inspect Semantius  →  3. Plan & Present  →  4. Execute  →  5. Verify  →  6. Sample Data?
```

Work through each stage in order. Narrate what you're doing at each step.

---

## Stage 1: Parse the semantic model

Locate the `*-semantic-model.md` file. Extract:

- **`system_slug`** from YAML frontmatter — this is the module name
- **Human-readable system name** — from the top-level heading (`# ... — Semantic Model`)
- **Entity list** — from the §2 entity summary table, in order
- **Per-entity details** from each §3 entity subsection:
  - `table_name`, `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`
  - Fields: `field_name`, `format`, required, `title` (= Label column), reference targets, delete modes
  - Enum values from §5
- **Relationship table** (§4) — confirms `reference_delete_mode` for each FK field
- **§2 Mermaid diagram** — sanity-check it agrees with §3/§4 (the model's own audit should have caught mismatches; if it disagrees here, flag for the user before proceeding rather than silently picking one side)
- **§6 Open questions** — scan both sub-sections. **§6.1 🔴 Decisions needed is a gate**: if any entry is present and unresolved, stop before Stage 4 and list the blockers to the user; ask them to either (a) answer each question so the model can be updated first via the semantic-model-analyst skill, or (b) explicitly waive and proceed at their own risk. Do not make up answers, and do not silently proceed. **§6.2 🟡 Future considerations is informational only** — note them for the user but do not block. Models that predate the two-bucket format (flat §6 list) should be treated conservatively: surface every flat entry as a potential blocker and ask the user to classify each before proceeding.
- **Implementation notes** (§7) — always follow these
- **`related_models` front-matter and §8 Related domains** — extract the array of sibling slugs from front-matter, then parse §8 sub-sections into a per-sibling structure carrying `{relationship, exposes: [tables], expects_on_sibling: [{sibling_table, fk_field, target_table, cardinality, delete_mode, rationale}], defers_to_sibling: [{local_table, sibling_table, additive_fields}]}`. If `related_models` is absent and §8 is empty (or reads "No related domains identified."), the model has no federation surface and Stages 2g and 4f are no-ops. **Mismatch between front-matter and §8** (slug in front-matter with no §8 entry, or §8 entry with no front-matter slug) is a 🔴 — stop before Stage 2g and ask the user to fix the model via the analyst skill, since the deployer cannot guess which is authoritative. Files that predate §8 (only seven sections) skip Stages 2g/4f silently.

### Model-to-Entity Mapping

| Model line | `create_entity` / `update_entity` parameter |
|---|---|
| `table_name` (§3 heading) | `table_name` |
| Singular / Plural labels | `singular_label` / `plural_label` |
| Description | `description` |
| Label column | `label_column` |
| `**Audit log:** yes \| no` | `audit_log` (boolean; omit or pass `false` when the model says `no` or is silent) |
| `**Edit mode:** auto \| sidebar \| modal \| page` (when present) | `edit_mode` (omit when absent — defaults to `auto`) |
| `**Cube mode:** disabled \| auto` (when present) | `cube_mode` (omit when absent — defaults to `disabled`) |

> `searchable` and `is_child` on the entity are read-only / auto-computed by the platform. **Never** pass them on `create_entity` / `update_entity`.

### Model-to-Field Mapping

| Model column | `create_field` parameter |
|---|---|
| Field name | `field_name` |
| Format | `format` |
| Label | `title` |
| → `table` | `reference_table` |
| Delete mode from §4 | `reference_delete_mode` |
| Notes annotation `relationship_label: "<verb>"` (FK rows) — must equal the §2 Mermaid edge label `\|<verb>\|` for the same FK | `relationship_label` |
| Notes annotation `parent label: "<singular>" / "<plural>"` (parent FK rows only) | `singular_label_parent` / `plural_label_parent` |
| Notes annotation `cube_type: <value>` | `cube_type` (omit when absent — defaults to `auto`) |
| Notes annotation `default: "<value>"` | `default_value` |
| Enum values from §5 | `enum_values` |

> **Default-value guard (re-deploy safety).** Before issuing `create_field` for a **required** field on an **existing entity that already holds rows**, verify a default is supplied. Postgres rejects `ALTER TABLE ... ADD COLUMN ... NOT NULL` (and CHECK-constrained enums in particular) on a non-empty table when no default exists, with `(23514) check constraint "..._check" of relation "..." is violated by some row`. Specifically:
> - For required enums: `default_value` MUST be present in the model and be one of the listed `enum_values`. If the §3 Notes don't carry a `default: "<value>"` annotation, stop and surface this as a 🔴 — ask the analyst skill to set one (convention: first enum value, the initial lifecycle state).
> - For required non-FK scalars on a non-empty existing entity: same — refuse to add the column without a default, surface the gap, and ask before proceeding.
> - For required FK fields on a non-empty existing entity: there is no meaningful default. Stop and ask whether to add the column nullable (drop "required") or backfill the FK to a chosen target row before re-running.
> - For brand-new entities (created in this run, zero rows): no guard needed — defaults are nice-to-have but the create won't fail without them.
> Run a quick `read_entity` / `count` against the live table to determine whether it has rows; do not assume.

> **Verb consistency check.** When the §2 Mermaid edge for an FK is labeled `|owns|` but the §3 Notes for that FK has no `relationship_label: "..."` annotation (or a different verb), stop and surface this as a mismatch — do not silently pick one side. The diagram label and the field metadata must agree. The optimizer regenerates the diagram from `relationship_label`, so a mismatch here means the round-trip will lose information.

> The §3 `Required` column is captured as author intent in the model document but is **not** passed to `create_field`. The platform manages nullability internally based on format and delete-mode semantics — do not send an `is_nullable` (or equivalent) parameter.

### Fields That Are Auto-Generated — Never Create These

`create_entity` automatically creates these — skip them when iterating over model fields:

- `id`, `label`, `created_at`, `updated_at`
- The field named in `label_column` (auto-created with `ctype: label`)

> **Title correction:** The auto-created `label_column` field gets its title from `singular_label`. If the model specifies a different title for that field, use `update_field` to fix it after entity creation.

### Self-References

Fields that reference their own entity (e.g., `campaign.parent_campaign_id → campaigns`) must be created in a second pass after all entities exist. Flag them during parsing.

---

## Stage 2: Inspect the Unified Catalog

**Read before writing — always.** (use-semantius Golden Rule #1)

This stage does four things in order: (a) resolve the module, (b) inspect built-ins, (c) load the full entity catalog, (d) classify every model entity and surface ambiguity.

### 2a. Resolve the module — update if it already exists

Look up the module by `system_slug`:

```bash
semantius call crud read_module '{"filters": "module_name=eq.<system_slug>"}'
```

- **Exists** → plan an `update_module` (refresh `label` and `description` from the model's `system_name` and §1 Overview). Capture the existing `module_id` to reuse. **Never create a second module with the same slug.**
- **Missing** → plan a `create_module` followed by baseline permissions `<slug>:read` and `<slug>:manage`.

If the module exists but the user's model genuinely belongs to a different domain and the shared slug is itself the collision, stop and ask — that's a model-level naming problem the analyst skill should fix, not something to paper over.

### 2b. Inspect Semantius built-ins

The semantic model may declare entities that already exist as built-ins (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields` — see `use-semantius/references/data-modeling.md` for the authoritative list). **These tables control the platform (authentication, RBAC, integration). They must never be replaced.**

For each built-in referenced by the model:

- **Skip `create_entity`** entirely. The built-in already exists; recreating would break the platform.
- **Reuse as a `reference_table` target** for any FK in the model that points at it.
- **Additive fields only.** If the model declares extra scalar fields on a built-in (e.g. `users.department`, `users.employee_id`), offer them to the user as `create_field` calls. **Never modify existing built-in fields**, never change formats or enum values on a built-in.

### 2c. Load the full entity catalog

Ambiguity detection only works if you can see every entity in the instance, not just the ones in this module. Load the catalog:

```bash
semantius call crud read_entity '{}'
```

Build an index of every existing entity keyed by `table_name`, carrying at least `{module_id, module_name, singular, plural, description, label_column}`. You will use it in 2d.

### 2d. Classify each model entity

For every entity declared in the model's §2, determine which bucket it falls into. **Buckets marked 🛑 are ambiguity gates — the user must make an explicit decision in Stage 3 before any writes happen.**

| Bucket | Condition | Action |
|---|---|---|
| 🔒 Built-in | `table_name` matches a Semantius built-in | Reuse. Offer additive fields only (see 2b). |
| ♻️ Same-module match | Entity exists and its `module_id` equals our module's id | Re-run case — proceed to field-level diff (see "What to compare" below). |
| 🛑 Cross-module exact name | Entity exists with the **same `table_name`** but `module_id` ≠ our module | **Gatekeeper decision required.** Never silently coexist — see 2e. |
| 🛑 Similar name | An existing entity's `table_name` is *near* a model entity's name (see heuristic below) | **Gatekeeper decision required.** Similarity is a hint, not a verdict; the user decides. |
| ✨ New | No match of any kind | Create normally in Stage 4. |

For field-level checks on a same-module match, run the usual reads:

```bash
semantius call crud read_permission '{"filters": "permission_name=eq.<slug>:read"}'
semantius call crud read_field '{"filters": "table_name=eq.<table_name>&field_name=eq.<field_name>"}'
```

### 2e. Similarity heuristic — when to flag

You, the agent, are responsible for detecting near-names. Flag any pair where:

- One name is a prefix or suffix of the other — `contracts` ↔ `saas_contracts`, `orders` ↔ `sales_orders`
- They share a singular root or a lemma — `contract` ↔ `contracts`, `customer` ↔ `customers`, `vendor` ↔ `vendors`
- They differ only by a domain qualifier — `vendor_contracts` ↔ `saas_contracts`, `support_ticket` ↔ `it_ticket`
- They are obvious synonyms for the same business concept — `customers` ↔ `clients`, `employees` ↔ `staff`, `products` ↔ `items`
- Edit distance is small and the tokens look related (not just typos of unrelated words)

If you're uncertain whether two names refer to the same concept, **flag it**. A false positive costs the user one confirmation click; a missed collision pollutes the catalog permanently and cannot be cleaned up without data migration.

### 2f. For each 🛑, compare the concepts before asking the user

You cannot ask a useful question without first understanding both entities. For every flagged pair, pull the existing entity's fields and build a side-by-side comparison:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<existing_table_name>"}'
```

Note for each:

- Module it lives in, `singular`, `plural`, `description`, `label_column`
- Field names, formats, required-ness
- Overlap: which fields mean the same thing (often same name, sometimes just same concept under a different name)
- Format conflicts on conceptually-same fields (immutable → blocks merge)

This comparison goes into the Stage 3 plan so the user can decide on informed grounds.

### What to compare when a same-module entity already exists

| Property | Risk | Notes |
|---|---|---|
| Field `format` | 🛑 High — **immutable** | Cannot be changed after creation |
| Field `enum_values` | ⚠️ Medium | Changing values may affect existing records |
| Entity labels, descriptions | ✅ Low | Safely updatable |
| Field `title`, `description` | ✅ Low | Safely updatable |

### 2g. Inspect related modules (federation surface)

Read every slug in the model's `related_models` front-matter array. For each one, check whether the sibling module is deployed:

```bash
semantius call crud read_module '{"filters": "module_name=eq.<sibling_slug>"}'
```

Build a `siblings_live` map keyed by slug: `{module_id, module_name, decline_metadata}`. The decline metadata captures previous user-confirmed declines so Stage 4f does not nag — read it from the sibling module's `description` field or a dedicated metadata field if the platform exposes one. Format convention: `cross_module_declines: [<sibling_slug>:<sibling_table>.<fk_field>, ...]` appended to the sibling module's metadata so the deployer can recognize which extension proposals the user already turned down.

For each live sibling, walk its §8 sub-section and pre-compute:

- **Defers-to dedup actions.** For each `Defers to sibling` entry whose local table is in this model's §3, mark the local entity as 🔒 **Deferred to sibling** and record the rewire mapping `{local_table → sibling_table}`. From here on, treat the local table the same way Stage 2b treats Semantius built-ins: skip `create_entity`, reuse the sibling's table as `reference_table` for all FK targets, and propose any non-overlapping fields the sibling lacks as additive extensions on the sibling's table.
- **Expects-on-sibling extension proposals.** For each `Expects on sibling` FK, look up the sibling table in the live catalog (loaded in 2c). If the FK already exists, mark it ✅ Already in place. If the FK is missing, mark it ✨ Proposed and stash the spec for Stage 3 to present and Stage 4f to execute. If the user previously declined this exact FK (per `cross_module_declines`), mark it 🔇 Suppressed and skip silently.
- **Ownership conflicts.** If two siblings both claim canonical ownership of the same local entity via competing `Defers to` entries (e.g. both `identity_and_access` and `org_management` declare ownership of `teams`), mark a 🛑 federation gate. Stage 3 must surface this for explicit user resolution before any rewires happen.

Dormant siblings (slug listed in `related_models` but module not deployed) require no action this run — their `Exposes` entries get indexed for future reciprocity but produce no plan items now.

Carry the federation summary into Stage 3 so the user sees the cross-module impact alongside the in-module plan.

---

## Stage 3: Plan and Present (and resolve ambiguity)

Before running any writes, show the user a clear plan. The plan must have two parts: (1) the normal module/permission/entity summary, and (2) **an ambiguity-decisions section if any 🛑 buckets were raised in Stage 2**. No writes happen until every 🛑 has an explicit decision.

### Normal plan (example)

```
📦 Module: saas_expense_tracker
  ✨ Will create (new module)
  🔑 Permissions: ✨ saas_expense_tracker:read, ✨ saas_expense_tracker:manage

🗂 Entities (7 total):
  🔒 users — Semantius built-in, reusing (model declares 3 extra fields: `department_id`, `job_title`, `employee_id` — will add additively with user confirmation)
  ✨ vendors — will create + 6 fields
  ✨ subscriptions — will create + 26 fields
  ✨ departments — will create + 5 fields
  ✨ budget_periods — will create + 6 fields
  ✨ budget_lines — will create + 8 fields
  ✨ license_assignments — will create + 7 fields

Total to create: 1 module, 2 permissions, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🔗 Federation (from §8 + `related_models`):
  🔒 vendors — deferred to live `vendor_management` module; skipping local create, rewiring 2 FKs
  ✨ Propose on live `change_management.change_requests`: + `affected_ci_id → configuration_items` (clear) — pending confirmation
  ✨ Propose on live `itsm.incidents`: + `affected_ci_id → configuration_items` (clear) — pending confirmation
  💤 Dormant siblings (indexed for future deploys): `software_asset_management`, `org_management`
  🔇 Suppressed (previously declined): none
```

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12) — will update module metadata from the new model; will diff entities and apply only changes`.

### Ambiguity decisions (required when any 🛑 was raised)

**Every 🛑 decision must be taken via the `AskUserQuestion` tool** — not via prose options the user has to type back ("a or b"). Structured widgets remove the letter-mapping friction, survive multi-decision flows cleanly, and match how the `semantic-model-analyst` skill handles its own big decision. Never propose a default silently.

**The protocol for each 🛑:**

1. **Print the comparison block first as prose** — so the user has the facts in front of them before the widget appears. Comparison blocks carry information; the tool carries only the choice.
2. **Then call `AskUserQuestion`** with the decision as a single question. Use 4 explicit options; the runtime auto-adds an "Other" slot you can use for free-text renames or "abort".
3. **Batch multiple 🛑 gates into one `AskUserQuestion` call** with one question per gate. Never drip decisions one turn at a time. Never squash two decisions into the same prose paragraph (the screenshot of "(a or b) and (yes/no)" is exactly the failure mode this directive prevents).

**Example — comparison block (prose, shown first):**

```
⚠️ Ambiguity: `contracts`

  Incoming (this model → module `saas_expense_tracker`):
    Purpose: A signed commercial agreement for a SaaS subscription
    Label column: contract_number
    Fields: contract_number, signed_date, total_contract_value,
            renewal_notice_days, vendor_id (→ vendors), signatory_user_id (→ users)

  Existing (module `facility_management`, created 2026-01-14):
    Purpose: Lease and service agreements for physical properties
    Label column: contract_number
    Fields: contract_number, effective_date, termination_date,
            landlord_id (→ landlords), property_id (→ properties),
            monthly_rent

  Overlap: both share `contract_number` (string). Other fields are disjoint;
  the entities model different concepts that happen to share an English word.
```

**Example — the matching `AskUserQuestion` call:**

- **question**: `"How should I resolve the name collision on `contracts`?"`
- **header**: `"Ambiguity: contracts"`
- **multiSelect**: `false`
- **options** (4; the runtime appends Other):
  1. label `"Rename incoming → saas_contracts"`, description `"Keep the two concepts isolated. Recommended when they are genuinely different — the facility-management lease is not the same thing as a SaaS subscription agreement."`
  2. label `"Rename both (saas_contracts + facility_contracts)"`, description `"Most conservative. Removes ambiguity entirely by marking the catalog explicitly domain-scoped. High-risk second half — renaming the existing entity touches live records and FKs."`
  3. label `"Merge into existing `contracts`"`, description `"Treat as the same entity. Non-overlapping fields are added additively. Only safe when the two truly represent the same business concept (does not look like it here)."`
  4. label `"Rename existing → facility_contracts"`, description `"Keep the incoming name as `contracts`. High-risk — touches live records and any FK pointing at the existing table; may require data migration. Confirm twice before proceeding."`

The auto-"Other" slot handles: the user wants to abort, or the user wants a different custom name than the four suggested ones.

### If multiple 🛑 were raised

Send them all in **one** `AskUserQuestion` call as separate questions in the `questions` array. The comparison blocks print as prose in order above the tool call; the widgets appear as independent choices. Do not chain one-question calls across turns — that's exactly the pattern that produced the confusing "(a or b) and (yes/no)" UX.

### For similar-name flags

Use the same protocol; phrase the question to make clear the match is a *heuristic*, not a verdict (e.g. `"Does `lease_contracts` in this model refer to the same concept as the existing `contracts`?"`). Include the heuristic that matched (prefix/suffix/synonym/qualifier) in the comparison block so the user can judge whether it's a real collision or a coincidence.

### Fallback — when `AskUserQuestion` isn't available

If the tool is not available in the harness, fall back to labeled prose options with the same content — but present **exactly one decision per turn**, not multiple. Use clearly labeled choices ("A", "B", "C", "D", "Other — specify") and wait for the user's reply before moving to the next decision. Never combine multiple decisions into one prose prompt.

### Merge / rename rules

**Merge (a):**

- Do a field-by-field mapping. For each incoming field, either point it at an existing field with the same meaning, or add it as a new field on the existing entity.
- **Format mismatch on a conceptually-same field is a hard block.** Formats are immutable; a merge that requires changing a format is impossible. Fall back to rename.
- The merged entity stays in its current module (keeps existing records and FKs intact). The incoming model's module just references it.

**Rename incoming (b):**

- Pick a qualifier from the model's domain (`saas_`, `hr_`, `billing_`) and propose it. The user may override.
- **Rewrite every reference in the plan before any Stage 4 writes.** Purely in-memory — no live data exists yet for the incoming entity, so this is safe as long as it's *complete*:
  - The entity's `table_name` in the plan
  - **Every field in this model where `reference_table` equals the old name.** Fields in *other entities in this same model* that point at the renamed entity (e.g. `license_assignments.subscription_id → subscriptions` when renaming `subscriptions` → `saas_subscriptions`) silently break if this step is missed — they'd end up pointing at a non-existent table.
  - Relationship prose in the plan summary
  - Mermaid diagram node + edge names
- The source `.md` file is left unchanged unless the user explicitly asks the analyst skill to update it.

**Rename existing (c):**

- **High-risk.** Confirm twice. The data-modeling reference calls `table_name` immutable, so `update_entity` may reject the rename outright. If it does, stop immediately and offer option (a) merge or (d) rename-both as fallback. Never attempt DDL directly.
- **No catalog-side FK fix-up is needed.** Semantius propagates renames automatically — every `reference_table` in the catalog that pointed at the old name is updated by the platform as part of the rename. Do not scan, do not issue `update_field` calls for existing FKs. Your only job is to request the rename and confirm it succeeded.
- Incoming fields in *this* model that point at the renamed entity must still use the new name — that's an in-memory plan rewrite (same mechanic as option (b)) and happens before Stage 4 writes.

**Rename both (d):**

- Apply (b) to the incoming entity, then (c) to the existing one. Only the (b) half needs a `reference_table` rewrite (in-memory, across this model). The (c) half's catalog-side FKs are repointed by the platform automatically.

Do not proceed to Stage 4 until every 🛑 has a recorded decision. Restate the resolved plan once before executing.

**Exception:** If there are zero built-in overlaps, zero cross-module collisions, zero similar-name flags, and the module doesn't exist yet, proceed immediately: "No existing model found and no catalog collisions — creating everything from scratch now."

---

## Stage 4: Execute

Follow the use-semantius mandatory creation order exactly:

```
Module → Permissions → Entities → Fields (per entity, in model order)
```

Refer to `use-semantius/references/data-modeling.md` for the exact CLI syntax for each operation. **Before executing, apply every ambiguity decision from Stage 3** to the in-memory plan — renames propagate to every `reference_table` and relationship reference in the model. The sequence:

**4a. Module** — If missing, `create_module`. If it already exists, `update_module` with the current `label`/`description` from the model. Never create a duplicate module with the same `module_name`.

**4b. Permissions** — Ensure `<slug>:read` and `<slug>:manage` exist. `read_permission` first; `create_permission` only for the missing ones.

**4c. Entities** — Walk model §2 in order and apply each entity's bucket decision:

- 🔒 Built-in → skip entirely. Do not `create_entity` for `users`, `roles`, etc.
- ♻️ Same-module match → skip `create_entity`. If the model's `**Audit log:**` value (or `singular_label` / `plural_label` / `description`) differs from the live entity, call `update_entity` to sync. Then fall through to 4d (field diff).
- ✨ New → `create_entity`. Pass `audit_log` from the §3 `**Audit log:**` line (default `false` when the line is missing or says `no`). After creation, correct the `label_column` field title if needed with `update_field`.
- 🛑 Resolved as **merge** → skip `create_entity`. The target is the existing entity in the other module. Record the mapping; the merge is realized in 4d by adding the non-overlapping fields additively to the existing entity.
- 🛑 Resolved as **rename incoming** → `create_entity` using the new name. (Plan-level rewrite of `reference_table` values has already happened before this stage.)
- 🛑 Resolved as **rename existing** → attempt `update_entity` on the existing entity's `table_name` first, before any new creates. If the platform rejects the rename, stop and return to Stage 3 — never continue silently. Once the rename succeeds, Semantius repoints every catalog-side `reference_table` automatically; no follow-up `update_field` pass is needed.
- 🛑 Resolved as **rename both** → do the existing-rename first, then `create_entity` for the incoming under its new name.
- 🛑 Resolved as **abort** → stop Stage 4 entirely; tell the user to iterate on the model with the analyst skill.

**4d. Fields** — For each entity, create missing fields in model order with `create_field`. Skip auto-generated ones (`id`, `label`, `created_at`, `updated_at`, and the `label_column` field). Always include `width: "default"` and `input_type: "default"`. For FK fields whose `reference_table` is a built-in (`users`, `roles`, …) or a merged existing entity, point directly at that `table_name` — the platform doesn't care whose module owns it.

For ♻️ same-module matches and 🛑 merges, only create fields that don't already exist; `update_field` for safe diffs (title, description, enum extensions, searchable). Never attempt a format change — formats are immutable and that requires an analyst-level rethink.

**4e. Built-in extensions** — If the user confirmed additive field extensions on a built-in (e.g. the model declares `users.department_id` and the built-in doesn't have it), create those fields after all custom entities are done. Do not modify existing built-in fields, do not change formats or enum values.

**Second pass** — After all entities exist, create any self-reference fields (e.g. `departments.parent_department_id` → `departments`) and any cross-reference pairs that had to wait (e.g. the mutual `departments.manager_user_id` ↔ `users.department_id`).

After each entity's fields are done, share the UI link:
`https://tests.semantius.app/<module_name>/<table_name>`

**4f. Cross-module extensions (federation)** — After all in-module creates and built-in extensions are done, walk the federation plan from Stage 2g and apply confirmed cross-module changes. Two flavors:

- **Defers-to rewires** are already applied implicitly: the local entity was skipped in 4c, and FKs were pointed at the sibling's table in 4d. Nothing more to do here other than logging which locals were deferred to which siblings (for the verification summary). If the local table was created in a previous run before §8 was added, do not delete it — surface it to the user as a manual cleanup decision.
- **Expects-on-sibling proposals confirmed in Stage 3** are executed now as additive `create_field` calls against the sibling's table. Always include `width: "default"` and `input_type: "default"`. The new FK's `format` is `reference` (not `parent` — cross-module ownership is not allowed; an `Expects on sibling` entry must never be cascade-delete because the sibling does not own the local table). Use `reference_delete_mode: "clear"` unless the §8 entry explicitly specifies `restrict`. Set `relationship_label` from the §8 rationale when present, or leave it for the sibling's analyst to fill in later.

```bash
# Example: this model is `cmdb`; sibling `change_management` is live and the user confirmed
# the §8 proposal "change_management.change_requests.affected_ci_id → cmdb.configuration_items"
semantius call crud create_field '{
  "data": {
    "table_name": "change_requests",
    "field_name": "affected_ci_id",
    "title": "Affected CI",
    "format": "reference",
    "reference_table": "configuration_items",
    "reference_delete_mode": "clear",
    "relationship_label": "affects",
    "width": "default",
    "input_type": "default"
  }
}'
```

For each confirmed extension, also share the UI link to the sibling table so the user can inspect:
`https://tests.semantius.app/<sibling_module_name>/<sibling_table_name>`

**Persist declines.** For every Stage-3 federation proposal the user declined, append the entry to the sibling module's `cross_module_declines` metadata via `update_module` so the next deploy of this model does not re-prompt. Format: `<this_slug>:<sibling_table>.<fk_field>`. The sticky-decline mechanism is what keeps federation reconciliation feeling like a one-time cleanup rather than a recurring nag.

**Skip silently** for any Stage-3 proposal the user accepted but the platform rejected (e.g. the sibling's table was renamed between Stage 2g inspection and 4f write). Surface the failure in the verification summary; do not retry.

---

## Stage 5: Verify

After all creates are done:

1. `read_entity` on each custom entity — confirm `label_column` is set
2. `read_field` per entity — confirm field count matches the model (minus auto-generated)
3. Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`)

Print a final summary: "✅ Done. Created 1 module, 2 permissions, 5 entities, 47 fields. Reused built-ins: users. Additive fields on built-ins: 2."

---

## Closing Contract — clean and sticky

The final assistant message of a deployment session is a **call-to-action**, not a recap. It must contain exactly three things, in this order, and nothing else:

1. One status line: `The <System Name> model is live in Semantius ✅`
2. **Open in UI:** `https://tests.semantius.app/<module_name>` — module landing page, on its own line, prominent (use a markdown link so it's clickable, e.g. `[Open <System Name> in Semantius →](https://tests.semantius.app/<module_name>)`).
3. The Stage 6 sample-data offer.

Everything else — what was created, what was skipped, why built-ins were reused, counts, per-entity links, caveats, justifications — belongs in the Stage 5 verification summary **before** this closing block, separated by a horizontal rule (`---`). Do not mix the two. The closing must not contain reasoning, parentheticals, or "by the way" notes; those dilute the call to action.

This block is **sticky**: if a follow-up turn (audit, "did I miss anything?", fix-up, clarification) interrupts before the user has answered the sample-data question, **re-emit the same three lines at the end of the follow-up reply**. Treat them as a footer that re-attaches itself until the user accepts sample data, declines it, or explicitly closes the session ("we're done", "thanks, that's all"). Before sending any assistant message that comes after Stage 4 writes have started, scan the draft: if it does not contain both the module landing-page link and the sample-data question, append the closing block.

---

## Stage 6: Sample Data

After verification, the closing message asks:

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](https://tests.semantius.app/<module_name>)
>
> Would you like me to generate 10 realistic sample records for each newly-created entity?

### Scope — whose tables get sample data

**Only entities this run created get sample records.** Everything else is off-limits. Writing seed data into an existing table pollutes live records, confuses reports, and can break referential integrity for users who are actively using the platform.

| Bucket | Eligible for sample data? |
|---|---|
| ✨ New entities created this run | ✅ Yes |
| 🛑 Resolved as "rename incoming" (a new table under the renamed name) | ✅ Yes — it's a new table |
| 🛑 Resolved as "rename both" — the *incoming* side | ✅ Yes — new table |
| 🛑 Resolved as "rename existing" | ❌ **Never** — the table already has records |
| 🛑 Resolved as "merge" — target existing entity | ❌ **Never** — existing table |
| ♻️ Same-module match (entity already existed) | ❌ **Never** — existing table |
| 🔒 Built-in `users` | ⚠️ Off by default — allowed only after explicit confirmed override (see below) |
| 🔒 Other Semantius built-ins (`roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`) | ❌ **Never, under any circumstances** — no override |

**Sample `users` — off by default, confirmed override allowed.** `users` is platform infrastructure — it controls authentication. Fake users cannot log in (no password, no real IdP identity), cannot receive meaningful role assignments, and will pollute audit trails. **Default behavior: decline and explain these limitations.** If after that explanation the user still wants sample users and explicitly confirms they understand the generated users cannot log in, you may proceed. When you do:

- Use clearly-synthetic identifiers: `email: "sample1@example.invalid"` (the `.invalid` TLD is reserved exactly for this), `full_name: "Sample User 1"`, etc.
- If the model has a `status` / `is_active` / similar field on users, seed to an inactive/test value so the rows can't be mistaken for real accounts.
- Never assign roles to sample users (no `user_roles` inserts — that's the absolute-never bucket below).
- Surface the override in the final summary: *"Created N sample users per your explicit request — none of them can log in."*

**Other built-in tables stay absolute — no override.** `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. These control RBAC, integrations, and the platform's own schema; seeding fake rows corrupts real users' access and the platform itself. Decline every request, even confirmed ones.

### FK fields that point at ineligible tables

A new entity often has FKs to built-ins or existing entities (e.g. `subscriptions.business_owner_id → users`, `subscriptions.primary_department_id → departments` when `departments` is pre-existing). For those fields:

- **Read existing records** from the target table (e.g. `GET /users?select=id&limit=20`) and **pick real IDs at random** to use as FK values.
- Never insert synthetic target records to satisfy the FK. If the target table has zero rows and seeding would require inventing one, skip the FK (leave it null if nullable) or skip the sample record entirely.
- For FKs into **other newly-created entities** in the same run, capture the inserted IDs from those earlier POSTs (see script pattern below) and reference them normally.

Create records in dependency order (entities with no parent FKs first, junction tables last — the model §4 order is usually correct), restricted to the eligible set defined above.

**Generate a single shell script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script to a temp file, run it once, and check the output.

The script should consist of sequential `semantius call crud postgrestRequest` calls, one per record, capturing inserted IDs directly from the POST response for use in FK fields.

### postgrestRequest response envelope

`postgrestRequest` always wraps its result in `{"request":{...},"response":{"status":201,"data":[{...}]}}`. The inserted record is at `response.data[0]`, **not** at the top level. Always use this extractor:

```bash
# Correct — navigate the envelope
ID=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")

# WRONG — treats response as a bare array, always fails with KeyError
ID=$(... | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
```

The same envelope applies to GET — use `d['response']['data']` to access the array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['response']['data']))")
```

### Script pattern

```bash
#!/usr/bin/env bash
set -e

PG='semantius call crud postgrestRequest'

echo "=== Seeding campaigns ==="
C_SPRING=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Spring Launch","status":"active"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
C_FALL=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Fall Promo","status":"draft"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
echo "  spring=$C_SPRING fall=$C_FALL"

echo "=== Seeding leads ==="
# Use captured IDs for FK fields — never assume sequential IDs
$PG "{\"method\":\"POST\",\"path\":\"/leads\",\"body\":{\"lead_name\":\"Jane Smith\",\"campaign_id\":$C_SPRING}}" > /dev/null
# ... etc ...
```

**Important for FK fields:** Capture IDs directly from each POST response — do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely.

**Enum safety — read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not — using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**String safety — ASCII only in seed data:** Do not use Unicode punctuation (em dash `—`, smart quotes `""`/`''`, ellipsis `…`) in seed strings. These characters break bash argument parsing when the script is executed. Use plain ASCII alternatives: `-` instead of `—`, `"` instead of `""`, etc.

Generate realistic data:
- Real-sounding names and emails (not "Test User 1")
- Enums: cycle through all valid model §5 values for that specific field so every value appears at least once
- Dates: realistic mix of past and future
- Numbers: plausible domain ranges
- Booleans: realistic mix

Run the complete script in one bash call and report the final output summary.

---

## Conflict Resolution Reference

| Conflict | Risk | Action |
|---|---|---|
| Module with same `system_slug` already exists | ✅ Low | `update_module` — never create a duplicate |
| Field `format` mismatch | 🛑 High | Skip (keep as-is), or require rename/analyst rethink |
| Entity label/description mismatch | ✅ Low | Offer `update_entity` (skip for built-ins) |
| Field title/description mismatch | ✅ Low | Offer `update_field` |
| `enum_values` differ | ⚠️ Medium | Offer update, warn about impact on existing records |
| Extra fields/entities not in model | None | Leave them alone |
| Model declares a built-in (`users`, `roles`, …) | None | Dedup: skip create, reuse built-in as `reference_table` target; never replace |
| Model declares extra fields on a built-in | ⚠️ Medium | Offer additive `create_field`; never modify existing built-in fields |
| **Cross-module exact-name collision** (entity with same `table_name` exists in another module) | 🛑 High — ambiguity gate | Stage 3 decision dialog: merge / rename incoming / rename existing / rename both / abort. Never silently coexist. |
| **Similar-name collision** (root, synonym, qualifier, prefix/suffix) | 🛑 High — ambiguity gate | Same dialog as above. User may decline, in which case record the decision and proceed. |
| Merge requires changing an immutable field format | 🛑 High | Merge is impossible — fall back to a rename option. |
| Existing-entity rename rejected by platform | 🛑 High | Stop. Offer "rename incoming" or "rename both" as fallback. Never continue silently. |
| §8 sibling slug listed in `related_models` is deployed and declares **Defers to sibling** for a local entity | ✅ Low | Skip local create, rewire FKs to sibling's table (same machinery as built-in dedup). Propose any non-overlapping local fields as additive extensions on the sibling. |
| §8 sibling is deployed and **Expects on sibling** FK is missing on its table | ⚠️ Medium | Stage 3 user-confirmed proposal; Stage 4f executes as `create_field` on the sibling. Decline persists in sibling module metadata. |
| Two siblings both claim **Defers to** ownership of the same local entity | 🛑 High — federation gate | Stage 3 dialog asks the user which sibling owns it. Never silently pick. |
| `related_models` slug listed but sibling module not deployed | ✅ Low | Dormant. No action this run; sibling's `Exposes` entries indexed for future reciprocity. |
| `related_models` and §8 disagree (slug missing one side) | 🛑 High | Stop before Stage 2g. Ask the user to fix the model via the analyst skill; deployer cannot pick which is authoritative. |
| Cross-module rename, type change, or deletion proposed by §8 | 🛑 High | Out of scope. §8 changes are additive only. Surface as a separate manual task. |
