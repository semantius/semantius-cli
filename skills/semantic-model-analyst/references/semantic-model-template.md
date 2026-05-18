# Semantic Model Template

Use this template verbatim for the final semantic-model output in Stage 11. Each `{{placeholder}}` gets replaced with the value gathered during the workflow. Keep the section order and the table columns identical, downstream agents rely on the structure to parse entities and fields deterministically.

---

## Template starts below this line

```markdown
---
artifact: semantic-model
version: "{{analyst_skill_version}}"
system_name: {{System display name — keep acronyms as acronyms (CRM, ITSM, CMDB)}}
system_description: {{Compact tagline ≤40 chars shown beside system_name in the UI module selector and landing page. For acronyms use the plain English expansion (CRM → "Customer Relationship Management"). For non-acronym names use a 2-4 word disambiguating phrase.}}
system_slug: {{system_slug}}
module_type: {{domain | master}}  # optional, analyst v3.0+; omit for the default "domain". Set to "master" when authoring a master model (a self-contained spec for a master-data module hosting shared concepts consumed by multiple domain modules, e.g. `vendor_management` declaring `vendors` + siblings; `finance` declaring `currencies` + `cost_centers` + `ledger_accounts`). See SKILL.md "Skill version" and the §3 `**Shared master cluster:**` annotation below for the surrounding shape.
domain: {{System category, e.g. CRM, ITSM, HRIS, LMS, ERP, PIM, Project Management, Field Service, Subscription Billing, CMS}}
naming_mode: {{template:<vendor> | agent-optimized}}
created_at: {{YYYY-MM-DD}}
entities:
  - {{table_name_1}}
  - {{table_name_2}}
related_domains:
  - {{Title-case domain or acronym, e.g. ITAM, CMDB, Change Management}}
  - {{...}}
departments:
  - {{department_name}}
industries:
  - {{industry_name}}
initial_request: |
  {{Verbatim user request that kicked off this model — e.g. "I need a basic lead tracker". Captured once at creation and NEVER modified by later audits or extensions.}}
---

# {{System display name}} — Semantic Model

## 1. Overview

{{Two or three sentences describing the system, its users, and the problem it solves. Written for a human reviewer; keep it concrete and avoid marketing tone. §1 is the catalog-readable system narrative — downstream skills (notably semantius-skill-maker) copy it verbatim into their human-facing README. Hard bans: no §-number cross-references (no "see §6", "via §6 hint rows"); no snake_case identifiers or column-shaped tokens (no `cost_center_id`, no `features.cost_center_id`); no platform plumbing words ("Semantius", "deployer", "deploy time", "self-contained"); no scope-deferral or authoring-decision narration ("deliberately out of scope", "moved to a sibling domain", "fully declared even though..."). Deferrals live in `related_domains` plus §6, never in §1 prose. Authoring decisions about platform built-ins are the deployer's concern at deploy time, not §1's. If you find yourself wanting to add a third paragraph that explains a *modeling choice*, delete it: §1 describes the system, not the model file.}}

## 2. Entity summary

| # | Table name | Singular label | Purpose |
|---|---|---|---|
| 1 | `{{table_name}}` | {{Singular Label}} | {{one-line purpose}} |
| 2 | … | … | … |

### Entity-relationship diagram

A Mermaid **flowchart** showing every entity in this model and every relationship declared in §3/§4. The diagram must be **complete** (every entity and every relationship appears) and **consistent** (cardinality and direction match §3/§4). The audit cycle verifies this.

```mermaid
flowchart LR
    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;
    classDef master fill:#d4f4dd,stroke:#27ae60,color:#1a4d2e;
    {{TABLE_A}} -->|{{verb}}| {{TABLE_B}}
    {{TABLE_A}} ---|{{verb}}| {{TABLE_C}}
    {{TABLE_B}} --> {{JUNCTION}}
    {{TABLE_D}} --> {{JUNCTION}}
    class {{TABLE_DEDUP_AGAINST_SEMANTIUS_BUILTIN}} builtin;
    class {{TABLE_WITH_SHARED_MASTER_CLUSTER}} master;
```

**Shared / external entities are highlighted in green-family styling (analyst v3.1+ for `builtin`, v3.0+ for `master`).** Two classes capture entities that aren't solely owned by this module:

- **`builtin`** (deeper green) tags entities that the deployer will dedup against a Semantius platform built-in at deploy time (`users`, `roles`, `permissions`, etc.). The deployer skips `create_entity` for these and reuses the built-in as the FK target. Add `class <table_name> builtin;` per such entity.
- **`master`** (mint green) tags entities carrying a `**Shared master cluster:** <name>` annotation in §3 (vendors, currencies, cost_centers, departments, …). Created here by default; the deployer may offer to host them in a shared master module so other domain modules can FK to the same row. Add `class <table_name> master;` per such entity.

Both classes are visual aids — they don't change deploy behavior; the deployer keys off the §3 annotations and the built-in catalog directly. Omit each `classDef` line (and its `class` tags) entirely when no entity in the model qualifies. Keep `classDef builtin` and `classDef master` exactly as written above so reviewers across model files see consistent shades.

**Edge labels are managed metadata, not free guesses.** When an FK field carries a `relationship_label` (the verb describing the relationship, e.g. `"owns"`, `"employs"`), that string is the edge label and goes into the diagram verbatim. The downstream deployer reads it from §3 (annotated as `relationship_label: "<verb>"` on the FK row) and persists it on the field; the optimizer reads it back from live state when it regenerates the model. Do not invent a verb for the diagram that isn't also captured on the field.

**Mermaid flowchart cardinality conventions** (use these exactly):

The convention: **arrows (`-->`) mean "many"**, **flat connectors (`---`) mean "one"**. The arrow/connector points *from the parent to the related side* and describes how many of the related side the parent has.

| Cardinality | Syntax | Example (reads as…) |
|---|---|---|
| 1:N (one-to-many) | `A --> B` | `accounts --> contacts` — an account has **many** contacts |
| 1:1 (one-to-one) | `A --- B` | `users --- user_profiles` — a user has **one** profile |
| M:N (many-to-many) | two `-->` edges via a junction | `contacts --> campaign_members` **and** `campaigns --> campaign_members` — both sides have many junction rows |
| Labeled edge | `A -->|verb| B` / `A ---|verb| B` | `accounts -->|owns| opportunities` |

Convention: always model junction tables explicitly in the diagram as their own node with two `-->` edges in from the parents, matching how §3 models them. Never draw a direct `-->` edge between two parents of an M:N relationship — route it through the junction.

### Permissions summary

_Mandatory in analyst v2.0+. The single source of truth for the module's permission catalog. The deployer reads this table directly and creates each permission (and its hierarchy row) in row order._

| Permission | Type | Description | Used by | Hierarchy parent |
|---|---|---|---|---|
| `{{system_slug}}:read` | baseline-read | Read every record in the module. Typically: every user of the module. | every entity (`view_permission`) | `{{system_slug}}:manage` |
| `{{system_slug}}:manage` | baseline-manage | Edit operational records. Typically: {{primary operational role, e.g. "recruiters, coordinators"}}. | every operational entity (`edit_permission`) | `{{system_slug}}:admin` _(if baseline-admin row exists; else `—`)_ |
| `{{system_slug}}:admin` | baseline-admin | Edit reference/config data and inherit every workflow override. Typically: {{leadership role, e.g. "RecOps, hiring directors"}}. | `{{admin_tier_entity_1}}`, … (`edit_permission`) _(or "(rollup target only; no entity uses as edit_permission)" when no admin-tier entity exists)_ | — |
| `{{system_slug}}:{{workflow_perm_1}}` | workflow | {{Verb-led action sentence under 120 chars}}. Typically: {{role}}. | `{{entity}}` rule `{{rule_code}}` (`require_permission`) | `{{system_slug}}:admin` |
| `{{system_slug}}:{{narrow_perm_1}}` | workflow-narrow | {{Narrow-tier role description under 120 chars}}. Typically: {{external-participant role, e.g. "panel interviewers, external reviewers"}}. | `{{entity}}` (`edit_permission`); optional `{{entity}}` rule `{{rule_code}}` (`require_permission`) | `{{system_slug}}:manage` |
| … | | | | |

**Column rules:**

- `Permission` — fully qualified code (`<slug>:<suffix>`), never bare suffix.
- `Type` — exactly one of `baseline-read`, `baseline-manage`, `baseline-admin`, `workflow`, `workflow-narrow`. `workflow` is the **elevated** case (grants more than `manage` — approval / sign-off / manager-override). `workflow-narrow` (analyst v2.1+) is the **inverse** case (grants less than `manage` — held by external participants who write specific tables without the rest of operational access).
- `Description` — **the text the role-assignment UI shows.** Shape: *"[Verb] [object]. Typically: [role]."* under 120 characters. Verb-led, action-oriented, no rule codes, no JsonLogic operator names, no family-NN taxonomy, no §N.M references. Rationale (why the rule exists, what JsonLogic shape encodes it) belongs in `validation_rules[].description` for the corresponding rule, not here.
- `Used by` — comma-separated list of consumers. Baselines say `every entity (view_permission)` / `every operational entity (edit_permission)` / list of admin-tier `<table_name>` values. Elevated `workflow` rows list every `<entity> rule <rule_code>` pair where `require_permission(<perm>)` appears. `workflow-narrow` rows list every entity whose §3 `Edit permission:` annotation binds to this narrow code (the `(edit_permission)` form) plus any row-level rule that invokes it via `require_permission`.
- `Hierarchy parent` — the broader permission this row rolls up under (i.e. the permission that *includes* this one). In the platform schema, the deployer maps this cell to `including_permission_id` and the row's own `Permission` to `included_permission_id` when calling `create_permission_hierarchy`. Use `—` for top-level (no rollup). Direction depends on Type:
  - Baseline-manage rolls up under baseline-admin when the latter exists; baseline-read rolls up under nothing (`—`).
  - Elevated `workflow` permissions roll up under baseline-admin (default) or `—` (standalone, no rollup). **Never `<slug>:manage`** — that defeats the elevated gate by auto-granting every manager the gated authority.
  - Narrow `workflow-narrow` permissions roll up under `<slug>:manage` (default) or higher. **Never `—`, never `<slug>:admin` alone without `manage` in the chain** — those rollup directions exclude `manage` holders from the narrow tier, inverting intent.

The table is exhaustive: every permission the model declares appears in exactly one row. Per-entity `**Edit permission:**` annotations in §3 and per-rule `require_permission(<code>)` references inside `validation_rules` continue to live where they are (per-entity / per-rule data); the *catalog* of permissions lives here in §2.

**Two-permission fallback:** if the model is purely operational (zero admin-tier entities and zero workflow permissions), omit the `baseline-admin` row entirely and the `baseline-manage` row's `Hierarchy parent` is `—`. State the reason in §1 Overview or as a one-line note above this table.

## 3. Entities

For each entity, repeat the following sub-structure.

### 3.{{N}} `{{table_name}}` — {{Singular Label}}

**Plural label:** {{Plural Label}}
**Label column:** `{{field_name_used_as_label}}`  _(the human-identifying field; auto-wired by Semantius)_
**Audit log:** {{yes | no}}  _(optional; defaults to no. Set yes when INSERT/UPDATE/DELETE history matters — contracts, financial records, policy data, anything subject to compliance or dispute. Leave no for high-volume/ephemeral data where audit noise outweighs the value.)_
**Edit permission:** {{manage | admin | <narrow_suffix>}}  _(optional; defaults to manage. Set `admin` for reference / config / master-data entities classified in Stage 9 (small, slowly-changing, referenced by operational entities as a lookup/category/stage/type/source, typically ships seeded values). Set a bare narrow-tier suffix (analyst v2.1+, e.g. `interview` resolving to `<system_slug>:interview`) when Stage 10 W4n classified this entity as written by external participants and a `Type: workflow-narrow` row exists for the named code in §2. Omit the line entirely for operational entities — the default is manage. Drives the deployer's per-entity `edit_permission` assignment; `view_permission` is always `<system_slug>:read`.)_
**Shared master cluster:** {{cluster_name}}  _(optional, analyst v3.0+. Emit for entities the analyst recognizes as classic master concepts (finance reference data, parties, organization data, products, employees). Common patterns: `finance` (currencies, cost_centers, budget_periods, ledger_accounts, fiscal_years, tax_rates, gl_accounts); `parties` (vendors, customers, partners, suppliers); `organization` (departments, business_units, locations, sites); `products` (products, product_categories, skus); `employees` (employees, job_titles). The hint is consulted by the deployer ONLY when this entity becomes a Branch B promotion candidate (cross-module collision in another domain module); it shapes the recommended host-master selection at the deploy-time prompt. Has no effect when the entity isn't promoted. The user can always override at the deploy prompt. Omit when the entity is not a classic master concept.)_
**Description:** {{1-2 sentence description of what a record represents and when it's created}}

**Fields**

| Field name | Format | Required | Label | Description | Reference / Notes |
|---|---|---|---|---|---|
| `{{field_name}}` | `{{format}}` | {{yes \| no}} | {{Human Label}} | {{one short sentence — leave blank when the title + format + enum/FK already says it; fill for units (e.g. "person-months"), ranges not in a validation rule, direction-mattering semantics, sign/polarity conventions, freeform-string shape hints, or overloaded terms; see SKILL.md "Fill the §3 Description column" for when to fill vs leave blank}} | {{structured annotations ONLY — no free prose: e.g., → `accounts` (N:1), `relationship_label: "owns"`, `default: "draft"`, `precision: 2`, `cube_type: dimension`, `parent label: "X" / "Ys"`, `label_column`, `unique`, `searchable`, `enum_values: ["a", "b", "c"]`}} |
| … | … | … | … | … |

> Do not include `id`, `created_at`, `updated_at`, or the auto-generated `label` field — Semantius creates these automatically.

**Relationships**

- {{Prose description of each relationship this entity participates in, including cardinality and ownership. Example: "A `{{this}}` belongs to one `{{parent}}` (N:1, required, cascade on delete)." / "A `{{this}}` may have many `{{child}}` records (1:N, via `{{child}}.{{this}}_id`)." / "`{{this}}` ↔ `{{other}}` is many-to-many through the `{{junction}}` junction table."}}

**Computed fields** _(optional; omit the heading entirely when none)_

A JSON array, byte-stable for round-trip through the deployer/optimizer. Each entry derives a value into an existing scalar field on this entity via JsonLogic, evaluated against the merged record on every write. The platform overwrites any caller-supplied value for a `computed_fields[].name`. Reserved variables `$today`, `$now`, `$user_id` are available via `{"var": "$today"}` etc. Cross-entity primitives `{"set_record": ["<name>", "<entity>", <id-expr>, <body>]}` and `{"let": ["<name>", <value>, <body>]}` (analyst v3.2+) let the body read columns of a parent / referenced record (inherited values, merged labels) — see `./references/data-modeling.md` § "Cross-entity lookups inside JsonLogic".

```json
[
  {
    "name": "<existing-scalar-field>",
    "description": "<one-line human note>",
    "jsonlogic": { /* JsonLogic expression */ }
  }
]
```

**Validation rules** _(optional; omit the heading entirely when none)_

A JSON array of record-level invariants. Each rule must evaluate truthy for the write to succeed; failures are returned as `{ "errors": [{ "code", "message" }, ...] }`. Codes are snake_case and unique within the entity. The platform collects all failing rules without short-circuiting. Rules may use `{"set_record": ["<name>", "<entity>", <id>, <body>]}` (analyst v3.2+) to gate on the state of a parent / referenced record, and `{"throw_error": "<message>"}` inside an `if` to raise a SQL exception (SQLSTATE `23514`) whose text the caller sees verbatim — use it when prose names a specific, hand-tailored error message that should override the rule's static `message`.

```json
[
  {
    "code": "<snake_case_unique_within_entity>",
    "message": "<default English message returned to the caller>",
    "description": "<one-line human note explaining why this rule exists>",
    "jsonlogic": { /* JsonLogic expression that must be truthy */ }
  }
]
```

**Input type rules** _(optional; omit the heading entirely when none; analyst v2.2+)_

A field-level UI override block. Lists every field on this entity whose displayed `input_type` should be derived from the current record's state instead of staying fixed. Each entry binds one field name to a single JsonLogic object that returns one of `"default"` / `"required"` / `"readonly"` / `"disabled"` / `"hidden"`. The platform evaluates the rule client-side at form-render time; the result replaces the field's static `input_type` for that record. A malformed result or empty rule falls back to the static `input_type`. Use this for conditional visibility (hide `approved_at` until the record is being approved), conditional lock (`readonly` after a terminal status), conditional require (an extra `comments` field becomes required when `status` is `disputed`). Anything that must be enforced server-side belongs in `validation_rules`, not here — `input_type_rule` is UI control only. Pair an "appears at the right moment" rule with a server-side `validation_rules` entry so the field is actually populated, not just rendered editable.

```json
[
  {
    "field": "<field_name>",
    "description": "<one-line human note; optional>",
    "jsonlogic": { /* JsonLogic expression returning one of "default"/"required"/"readonly"/"disabled"/"hidden" */ }
  }
]
```

(The block is emitted as a **JSON array** — same shape as `Computed fields` and `Validation rules` — so the deployer parses all four read- and write-side sub-blocks with one parser instead of two. Each entry's `field` value must match a real field declared in this entity's §3 field table. The deployer applies each entry by calling `update_field` on `<table_name>.<field>` with the entry's `jsonlogic` value as `data.input_type_rule`.)

**Select rule** _(optional; omit the heading entirely when none; analyst v2.2+)_

An entity-level row-visibility rule. A single JsonLogic *object* (not an array) that the platform compiles into a `FOR SELECT` row-level security policy: the rule must return truthy for a row to be visible to the caller. Reserved variables `$today`, `$now`, `$user_id` are available via `{"var": "$today"}` etc. (`$old` is not meaningful in the select context). The rule is layered on top of `view_permission` — table-level access still gates first; this filters per-row for callers who have access. **The rule applies uniformly to every caller with `view_permission`** — there is no documented mechanism by which holding a specific permission causes the rule to be skipped. Use it for ownership-scoped visibility (a record's submitter / assignee / author sees it) and for confidential / restricted records (rule reads a column the row carries). For tiered visibility where some roles need broader access, the broadening lives **outside** the rule (an architectural decision resolved in §7.1: option B column-encoded, option C separate cube view / entity surface, option D Postgres `BYPASSRLS` role attribute). Never write a rule that promises a `<slug>:view_all_<plural>` permission bypass. Keep the expression simple: direct column comparisons and `$user_id` matches; avoid arithmetic and cross-row joins (the rule runs on every read of every row).

```json
{ /* JsonLogic expression returning a boolean — truthy means row visible */ }
```

---

_(repeat section 3 per entity, numbered 3.1, 3.2, …)_

## 4. Relationship summary

A single table showing every link between entities. An agent uses this to sanity-check that each reference field in §3 has a corresponding row here, and that the §2 diagram matches.

| From | Field | To | Cardinality | Kind | Delete behavior |
|---|---|---|---|---|---|
| `{{table_a}}` | `{{field}}` | `{{table_b}}` | {{N:1 \| 1:1 \| 1:N \| M:N}} | {{reference \| parent \| junction}} | {{restrict \| clear \| cascade}} |
| … | … | … | … | … | … |

## 5. Enumerations

Collect every `enum` field's allowed values here, one sub-section per enum. If two fields share an enum, note it and list once.

### 5.{{N}} `{{table_name}}.{{field_name}}`
- `{{value_1}}`
- `{{value_2}}`
- `{{value_3}}`

## 6. Cross-model link suggestions

Hints for the deployer about FKs that would add value when the named target entity exists in the catalog. The deployer resolves each `To` against the live catalog using its existing name-matching pass, proposes the FK as an additive `create_field` when a single match is found, and asks the user when several candidates plausibly fit (e.g. `vendors`, `suppliers`, `saas_vendors`). Entries whose target is not in the catalog are silently skipped, so erring toward inclusion is cheap.

This section is a hint list, not a contract. It does **not** carry entity-overlap declarations (vendors-vs-suppliers, contracts-vs-saas_contracts). Those are name collisions and the deployer detects them by inspecting the live catalog at deploy time, so the analyst does not need to pre-declare them here.

If this model has no plausible cross-model links, write "No cross-model link suggestions." under §6. The `related_domains` front-matter (described below) is a separate discovery tag and may still be populated even when §6 is empty.

| From | To | Verb | Cardinality | Delete |
|---|---|---|---|---|
| `{{source_table}}` | `{{target_concept}}` | {{verb in parent voice}} | {{N:1 \| 1:1}} | {{clear \| restrict}} |
| ... | ... | ... | ... | ... |

- **From** is the table that hosts the FK column. For *outbound* rows it is a `table_name` declared in this model's §3; for *inbound* rows it is a sibling-owned `table_name` that does not yet exist in the catalog (the FK lands on the sibling's table at a later deploy). The same entity in this model can act as parent in some rows and child in others.
- **To** is the FK target (the parent of the relationship). No module prefix; the deployer resolves against the global catalog. Use the most likely canonical plural snake_case form, the deployer handles fuzzy matches and ambiguity.
- **Verb** follows the same parent-voice rule as `relationship_label` in §3: it fills "a `<To>` ___ many `<From>`". Both **active** parent voice ("owns", "tracks", "hosts", "manages") and **passive** parent voice ("is affected by", "is referenced by", "is the subject of") are valid; pick whichever reads naturally given which side is the natural actor. Avoid **child voice** ("an incident affects a hardware_asset"), which flips the breadcrumb. The deployer copies the verb onto the created FK as `relationship_label`.
- **Cardinality** defaults to `N:1`; state `1:1` only when the FK should be unique. Cross-model `M:N` is out of scope for §6 (it requires a junction table that no model owns).
- **Delete** defaults to `clear`. `restrict` is allowed when the link must block deletion of the target. `cascade` is never valid across modules (no module owns another).

The deployer auto-generates the field name from the resolved target's singular form (e.g. `hardware_assets` becomes `hardware_asset_id`). When the source entity already has a field by that name, the deployer surfaces the collision and asks for an alternative.

## 7. Open questions

Questions the analyst flagged during the session. Every entry must be phrased as a **forward-looking question** that a reviewer can answer — not as a decision log or assumption narrative. Split into two severity buckets and keep both headings even when empty (use "None." under an empty bucket).

**How to phrase entries.** Wrong: *"Contracts folded into subscriptions — if MSAs become needed, split them out."* (This is a decision log, not a question.) Right: *"Should contracts be separated from subscriptions to support master service agreements with multiple sub-products?"* Wrong: *"Actual invoiced spend is out of scope."* Right: *"Is tracking actual invoiced spend (paid vs. due, dispute handling) required, or is the expected-spend calculation from subscription terms sufficient?"*

### 7.1 🔴 Decisions needed (blockers)

Questions where the model is **ambiguous or incomplete** without an answer. Leaving these open means the deployer has to guess at entity shape, cardinality, or required fields. The semantic-model-deployer skill refuses to proceed while any 🔴 question is unresolved.

- {{Blocker question 1 — e.g. "Can a user hold multiple roles concurrently, or exactly one? This changes whether `user_roles` is a junction or a FK on `users`."}}
- {{Blocker question 2}}

### 7.2 🟡 Future considerations (deferred scope)

Questions about extensibility or scope that are **fine to leave open**. These capture trade-offs the analyst deliberately deferred — the model works as-is, but a future business need would trigger a change. Safe to ignore at implementation time.

- {{Deferred-scope question 1 — e.g. "Should the `category` enum on `subscriptions` and `budget_lines` be promoted to a lookup table if the category list starts evolving frequently?"}}
- {{Deferred-scope question 2}}

## 8. Implementation notes for the downstream agent

A short checklist for the agent who will materialise this model in Semantius (or equivalent):

1. Create one module named `{{system_slug}}` (the module name **must** equal the `system_slug` from the front-matter — do not invent a different module slug here). Then create every permission listed in the §2 **Permissions summary** table, in table order: for each row, call `create_permission` with the `Permission` and `Description` column values. After all permissions exist, iterate the table again and call `create_permission_hierarchy` once per row whose `Hierarchy parent` cell is non-`—`, with `including_permission_id = <Hierarchy parent>.id, included_permission_id = <row's Permission>.id` (read: `<Hierarchy parent>` *includes* `<row's Permission>`). The §2 table is the canonical source; do not enumerate permissions here.
2. Create entities in the order given in §2 — entities referenced by others first.
3. For each entity: set `label_column` to the snake_case field marked as label in §3, pass `module_id`, `view_permission: "{{system_slug}}:read"`, and `edit_permission` derived from the entity's §3 `**Edit permission:**` line (`"{{system_slug}}:admin"` for admin-tier entities; `"{{system_slug}}:manage"` for everything else, which is also the default when the line is omitted). Do **not** manually create `id`, `created_at`, `updated_at`, or the auto-label field.
4. For each field in §3: pass `table_name`, `field_name`, `format`, `title` (the Label column), and for `reference`/`parent` fields also `reference_table` and a `reference_delete_mode` consistent with §4. (The §3 `Required` column is analyst intent; the platform manages nullability internally and does not need a per-field flag.)
5. **Fix up each entity's auto-created label-column field title.** `create_entity` auto-creates a field whose `field_name` equals the entity's `label_column`, and its `title` defaults to `singular_label` (e.g. entity `vendors` with `singular_label: "Vendor"` and `label_column: "vendor_name"` yields an auto-field `vendors.vendor_name` with title `"Vendor"`). If the §3 field table specifies a different Label for the label_column row (e.g. `"Vendor Name"` instead of `"Vendor"`), follow up with `update_field` to set the correct title. The `update_field` `id` is the **composite string** `"{table_name}.{field_name}"` (e.g. `"vendors.vendor_name"`) — **pass it as a string, not an integer**, or the update will fail.
6. **Deduplicate against Semantius built-in tables.** This model is self-contained and may declare entities (e.g. `users`, `roles`, `permissions`) that already exist in Semantius as built-ins. For each declared entity, read Semantius first: if a built-in already covers it, **skip the create** and reuse the built-in as the `reference_table` target — do not attempt to recreate. Optionally add missing fields to the built-in only if the model requires them (additive, low-risk changes only).
7. **Apply §6 cross-model link suggestions.** After the model's own creates and the built-in dedup pass, walk the §6 hint table. For each row, look up the `To` concept in the live catalog: when a single entity matches, propose an additive `create_field` on `From` using the auto-generated `<target_singular>_id` field name with the row's `Verb` as `relationship_label` and `Delete` as `reference_delete_mode`; when several candidates match (e.g. `vendors`, `suppliers`, `saas_vendors`), batch a single user confirmation; when no candidate matches, skip silently. All §6 changes are strictly additive (new optional FK columns); §6 never carries renames, type changes, deletions, or entity-overlap declarations.
8. **Apply per-entity read-side rules (analyst v2.2+).** For each entity that declares an `Input type rules` sub-block in §3: walk the JSON array and call `update_field` on each `<table_name>.<field>` with `data.input_type_rule` set to the entry's `jsonlogic`. For each entity that declares a `Select rule` sub-block in §3: call `update_entity` with `data.select_rule` set to that JsonLogic object. Entities with no read-side sub-blocks need no extra calls. The order is independent of write-side rules (apply after `create_entity` / fields exist, before announcing the module link). Warn the user before applying any `select_rule` — read-visibility changes are medium-risk and rows that callers used to see suddenly disappear.
9. After creation, spot-check that `label_column` on each entity resolves to a real field and that all `reference_table` targets exist.
```

## Template ends above this line

---

## Authoring guidance

- Use the fenced `markdown` block so the model is self-contained when copied.
- Table columns are fixed, don't rename or reorder them. Agents parse by header.
- If a field is a reference, always put the arrow + target + cardinality in the "Reference / Notes" column, e.g. `→ accounts (N:1)`. If it's a parent (ownership), use `↳ accounts (N:1, cascade)` so the distinction is visible.
- The §2 Mermaid diagram is **required**, it must list every entity in the summary table and every relationship in §4. Regenerate it whenever entities or relationships change.
- Keep the "Open questions" section and both severity sub-sections (§7.1 Decisions needed, §7.2 Future considerations) even when empty, write "None." under an empty bucket. Every entry is a forward-looking question; decision-log prose ("X was folded into Y") does not belong here. The semantic-model-deployer skill uses §7.1 as a gate, any unresolved 🔴 item blocks deployment.
- **§8 module name must equal `system_slug`.** The frontmatter `system_slug` is the single source of truth for the module identifier. Do not introduce a second name like `{domain}_spend` or `{domain}_tracker` in §8, if the frontmatter says `acme_crm`, §8 step 1 must read "Create one module named `acme_crm` …" and the permissions must be `acme_crm:read` / `acme_crm:manage` / `acme_crm:admin` (in the three-permission default, or `acme_crm:read` / `acme_crm:manage` in the two-permission fallback). A divergence between frontmatter and §8 is a blocker: the downstream deployer sees two authoritative sources and cannot pick silently.
- **§8 step 1 enumerates the three baseline permissions plus the hierarchy chain.** The default is three permissions (`<slug>:read`, `<slug>:manage`, `<slug>:admin`) with two hierarchy rows (`admin` includes `manage`; `manage` includes `read`). Drop to two permissions and one hierarchy row only when **all** entities classify operational AND the model declares no workflow permissions, or when every entity classifies admin (purely reference module). Whichever shape applies, §8 step 1 enumerates it explicitly along with the admin-tier entity list (when present), so the deployer reads §8 and §3 as agreeing sources. Drift between §3 `**Edit permission:** admin` annotations and §8's admin-tier list is a blocker.
- **§8 step 1 also enumerates workflow permissions** (analyst v1.11+) — the codes that family-12 and family-13 `validation_rules` invoke via `{"require_permission": "..."}`. Two or three permissions are the baseline; the analyst evaluates every model for additional gates that workflow / approval / record-ownership rules need (an offer's transition into `approved`, a contract's `signed` step, a personal note's owner-or-manager edit rule). The bar is: only add a workflow permission when the gated transition is genuinely policy-different from the rest of the entity's writes. Typical count per module is 0–4; ten is a smell. Every workflow permission named in §8 must appear as the argument to a `require_permission` call in some entity, and vice versa: every `require_permission` argument must be declared in §8. Workflow permissions roll up under `<slug>:admin` (the rollup default) or stand alone (granted directly); **never** roll up under `<slug>:manage` (it defeats the conditional gate). A model with workflow permissions but no admin-tier entities should still declare `<slug>:admin` as the rollup target.
- **`**Edit permission:** manage | admin`** on the §3 entity sub-section drives the deployer's per-entity `edit_permission` assignment. Default is `manage` (omit the line). Annotate `admin` for entities classified as reference/config in Stage 9 (small, slowly-changing, referenced by operational entities as a lookup/category/stage/type/source, ships seeded values). The line lives next to `**Audit log:**` so the analyst sees both decisions in the same place. The platform-built-in `users` entity, when declared in §3 for self-containment, does not need the line — the deployer dedups against the built-in and the annotation has no effect.
- **§8 must explain the label-column title fixup.** After `create_entity`, Semantius auto-creates a field named `<label_column>` with its `title` defaulting to `singular_label`. If any entity's §3 field table specifies a Label for the label_column row that differs from `singular_label` (e.g. `singular_label: "Vendor"` but §3 Label `"Vendor Name"`), §8 step 5 must explicitly instruct the implementer to call `update_field` with the composite string id (`"{table_name}.{field_name}"`, passed as a **string** not an integer) to set the correct title. Do not silently harmonize labels to avoid the fixup, `singular_label` stays a bare singular for plural/singular symmetry, and field-level titles live on the field.
- **`version`** is the analyst skill's `CURRENT_VERSION` at the time the file was last written, as a quoted string `"MAJOR.MINOR"`. The analyst stamps this on every save (Mode A Stage 11, Mode B fix-up writes, Mode C extend writes); it is never authored by hand. Major changes only on breaking schema/structure shifts (frontmatter keys removed, sections renumbered, table column shapes changed); minor changes on any non-breaking analyst-skill update (new audit checks, clarified rules, additional optional fields). The deployer rejects models whose major differs from its expected major; the analyst treats older-major files as archived knowledge rather than literal models. Files with no `version` key (legacy, pre-versioning) require an explicit review-and-migrate pass before any audit/extend or deploy.
- **`system_description`** is **required**: a compact tagline of ≤40 characters (2-5 words) shown in the UI module-selector chip and on the module landing page beside `system_name`. Its job is to disambiguate similar-looking names at a glance (ITSM vs ITAM, CRM vs CDP). For acronym `system_name`s use the plain English expansion (`CRM` → `Customer Relationship Management`, `ITSM` → `IT Service Management`, `CMDB` → `Configuration Management Database`, `HRIS` → `Human Resources Information System`, `SAM` → `Software Asset Management`, `ATS` → `Applicant Tracking System`, `CDP` → `Customer Data Platform`). For non-acronym names use a 2-4 word disambiguating noun phrase (`Helpdesk` → `IT Support & Ticketing`, `Workforce Planning` → `Headcount & Org Design`). Full-sentence descriptions belong in §1 Overview, not here.
- The front-matter is YAML, every value must be quoted if it contains a colon.
- **`domain`**, the system category in **Title-case / acronym form**. Common values: `CRM`, `ITSM`, `HRIS`, `LMS`, `ERP`, `PIM`, `Project Management`, `Field Service`, `Subscription Billing`, `CMS`. These are seed examples, not a closed set, prefer one when it genuinely fits (keeps the vocabulary tight for discovery), but coin a new Title-case / acronym value when nothing fits (`Talent Acquisition`, `EHR`, `Compliance`, `MES`). **Omit the key entirely** only when you can't categorize the system at all. **Never write `custom`**, it adds no information; absence already means "uncategorized".
- **Discovery tags**, `entities` is **lowercase snake_case** (matches Semantius `table_name` form so it works as an exact-match table tag). `departments` and `industries` use **Title-case / acronym form** (`Sales`, `IT`, `HR`, `Healthcare`, `SaaS`, `Financial Services`) so acronyms read correctly and humans can scan them, snake_case mangles initialisms (`it`, `hr`, `saas`).
  - `entities` is **required** and must be the complete list of `table_name` values from §2 (in §2 order, lowercase snake_case). Regenerate it whenever entities are added, removed, or renamed, a stale list defeats discovery.
  - `departments` is **optional**: list the department(s) where the system will mostly be used (e.g. `Sales`, `Finance`, `IT`, `HR`, `Operations`, `Marketing`, `Engineering`, `Legal`). Most models have 0–1 departments, for cross-departmental models list every relevant one. **Omit the key entirely** when no department is dominant; do not write an empty list.
  - `industries` is **optional**: list the industry/industries the system is specific to (e.g. `SaaS`, `Manufacturing`, `Healthcare`, `Retail`, `Financial Services`, `Education`, `Logistics`). Most models have 0–1 industries. **Omit the key entirely** when the model is industry-agnostic; do not write an empty list.
- `initial_request` is **immutable**. It captures the user's verbatim opening ask from the Create session. Audit and Extend modes must preserve it exactly, never rewrite, summarize, tidy, or "improve" it, even if the wording is rough or the scope has since expanded. It's a historical record of the original intent, not a live scope statement. Use a YAML literal block (`|`) so newlines and punctuation survive round-trips.
- If the system has no enums, §5 can read "No enumerations defined.", don't omit the section; keeping section numbers stable helps humans navigate multiple models.
- **§6 Cross-model link suggestions is a hint table.** The semantic model is atomic by design (it covers one bounded domain), but Semantius is a unified catalog where many such models coexist. §6 lists potential FKs from this model's entities to entities that may be owned by another domain (e.g. `incidents → hardware_assets`, `incidents → configuration_items`). The deployer resolves each `To` against the live catalog at deploy time, proposes an additive FK when the target exists, asks when multiple candidates fit, and silently skips when the target is not deployed. Five columns per row: `From`, `To`, `Verb`, `Cardinality` (default `N:1`), `Delete` (default `clear`).
- **§6 does not carry entity-overlap declarations.** Vendors-vs-suppliers, contracts-vs-saas_contracts, and similar shared-master-data overlaps are name collisions, and the deployer detects them by inspecting the live catalog at deploy time (entity-name match and similarity heuristic, with a user decision on merge / rename incoming / rename existing). The analyst does not need to pre-declare them in §6.
- **`related_domains` front-matter** is a discovery tag for humans browsing the model catalog: the names of business domains/system categories this model sits next to in the enterprise neighborhood. Each entry is **Title-case / acronym form**, the same vocabulary as the `domain` field itself (`ITAM`, `CMDB`, `Change Management`, `Workforce Planning`, `Vendor Management`, `Identity & Access`). It is **not** a list of slugs of other model files, it is descriptive analyst knowledge about which neighborhoods this system touches, drawn from general business-architecture knowledge rather than what other model files happen to exist. No skill consumes `related_domains` for logic; it exists purely to help a human scanning a directory of `*-semantic-model.md` files see how a model fits into the broader catalog. Omit the key entirely when the system genuinely has no adjacent domains (rare); do not write an empty list.
- **When drafting §6 rows,** look at: (a) anything you deferred to "another module" in Stage 3 or 4 that takes the form of a cross-domain link (the §7.2 future considerations are the natural seed list); (b) entities in this model whose lifecycle is closely tied to a concept in a different domain (an incident's affected device, a job opening's planned position, a software install's host CI). Vendors / users / cost-centers / departments and other shared-master-data tables do **not** belong in §6, the deployer's name-collision flow handles them.
- **`Computed fields` and `Validation rules` are optional §3 sub-blocks** that capture entity-level JsonLogic the platform evaluates on every write. Use them when a derived value is documented elsewhere as a computed quantity (RICE score, line subtotal, days-open) or when an invariant is documented as a record-level rule ("only set X once Y reaches state Z"). Omit the heading entirely when an entity needs neither — these are not required scaffolding. The blocks are emitted as fenced ```` ```json ```` arrays so the deployer can pass them byte-for-byte to `create_entity` / `update_entity` and the optimizer can round-trip them out of live state. Keep the JSON valid (real arrays of real objects, no comments), every `computed_fields[].name` resolves to an existing scalar field on the same entity, every `validation_rules[].code` is snake_case and unique within the entity, and reserved variables (`$today`, `$now`, `$user_id`, `$old`) are referenced as `{"var": "$today"}` etc. Cross-row lookups, aggregates, and FK traversal are out of scope for these blocks (that work belongs in cube/views). Two platform-extension operators are available inside `validation_rules` JsonLogic (analyst v1.11+): `{"value_changed": "<field>"}` (true when the field's value differs from `$old`, true on INSERT) and `{"require_permission": "<permission_code>"}` (true when the caller holds the permission, throws otherwise). They compose into conditional-permission rules — Stage 8 families 12 and 13. Every `require_permission` argument must reference a permission declared in §2 Permissions summary; the deployer rejects models that violate this.

- **`Input type rules` and `Select rule` are optional §3 sub-blocks (analyst v2.2+)** that capture *read-side* JsonLogic the platform evaluates at form-render or row-read time. They are independent of `computed_fields` / `validation_rules` (which fire on writes); the same entity may legitimately carry all four sub-blocks. Each `Input type rules` entry binds a single field to a JsonLogic expression returning one of the `input_type` enum values; the deployer applies them with `update_field` and the platform overrides the static `input_type` per-record at form render. The `Select rule` sub-block carries a single JsonLogic *object* that the platform compiles into a `FOR SELECT` row-level security policy; non-empty means "filter rows where the rule returns truthy", empty (or absent heading) means no per-row filter. Stage 11 is the mandatory mechanical scan that produces the `Input type rules` block; Stage 12 is the mandatory mechanical scan that produces the `Select rule` block. Each sub-block's heading is omitted entirely when no fields / no entity rule fired — like `Computed fields` / `Validation rules`, these are not required scaffolding. Cross-row lookups and FK traversals are out of scope for both; they belong in cube/views.
