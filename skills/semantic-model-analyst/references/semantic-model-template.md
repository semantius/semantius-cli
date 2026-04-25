# Semantic Model Template

Use this template verbatim for the final semantic-model output in Stage 5. Each `{{placeholder}}` gets replaced with the value gathered during the workflow. Keep the section order and the table columns identical — downstream agents rely on the structure to parse entities and fields deterministically.

---

## Template starts below this line

```markdown
---
artifact: semantic-model
system_name: {{System display name}}
system_slug: {{system_slug}}
domain: {{CRM | ITSM | HRIS | LMS | ERP | PIM | Project Management | Field Service | Subscription Billing | CMS | custom}}
naming_mode: {{template:<vendor> | agent-optimized}}
created_at: {{YYYY-MM-DD}}
initial_request: |
  {{Verbatim user request that kicked off this model — e.g. "I need a basic lead tracker". Captured once at creation and NEVER modified by later audits or extensions.}}
---

# {{System display name}} — Semantic Model

## 1. Overview

{{Two or three sentences describing the system, its users, and the problem it solves. Written for a human reviewer; keep it concrete and avoid marketing tone.}}

## 2. Entity summary

| # | Table name | Singular label | Purpose |
|---|---|---|---|
| 1 | `{{table_name}}` | {{Singular Label}} | {{one-line purpose}} |
| 2 | … | … | … |

### Entity-relationship diagram

A Mermaid **flowchart** showing every entity in this model and every relationship declared in §3/§4. The diagram must be **complete** (every entity and every relationship appears) and **consistent** (cardinality and direction match §3/§4). The audit cycle verifies this.

```mermaid
flowchart LR
    {{TABLE_A}} -->|{{verb}}| {{TABLE_B}}
    {{TABLE_A}} ---|{{verb}}| {{TABLE_C}}
    {{TABLE_B}} --> {{JUNCTION}}
    {{TABLE_D}} --> {{JUNCTION}}
```

**Mermaid flowchart cardinality conventions** (use these exactly):

The convention: **arrows (`-->`) mean "many"**, **flat connectors (`---`) mean "one"**. The arrow/connector points *from the parent to the related side* and describes how many of the related side the parent has.

| Cardinality | Syntax | Example (reads as…) |
|---|---|---|
| 1:N (one-to-many) | `A --> B` | `accounts --> contacts` — an account has **many** contacts |
| 1:1 (one-to-one) | `A --- B` | `users --- user_profiles` — a user has **one** profile |
| M:N (many-to-many) | two `-->` edges via a junction | `contacts --> campaign_members` **and** `campaigns --> campaign_members` — both sides have many junction rows |
| Labeled edge | `A -->|verb| B` / `A ---|verb| B` | `accounts -->|owns| opportunities` |

Convention: always model junction tables explicitly in the diagram as their own node with two `-->` edges in from the parents, matching how §3 models them. Never draw a direct `-->` edge between two parents of an M:N relationship — route it through the junction.

## 3. Entities

For each entity, repeat the following sub-structure.

### 3.{{N}} `{{table_name}}` — {{Singular Label}}

**Plural label:** {{Plural Label}}
**Label column:** `{{field_name_used_as_label}}`  _(the human-identifying field; auto-wired by Semantius)_
**Audit log:** {{yes | no}}  _(optional; defaults to no. Set yes when INSERT/UPDATE/DELETE history matters — contracts, financial records, policy data, anything subject to compliance or dispute. Leave no for high-volume/ephemeral data where audit noise outweighs the value.)_
**Description:** {{1-2 sentence description of what a record represents and when it's created}}

**Fields**

| Field name | Format | Required | Label | Reference / Notes |
|---|---|---|---|---|
| `{{field_name}}` | `{{format}}` | {{yes \| no}} | {{Human Label}} | {{e.g., → `accounts` (N:1), unique, enum values: [a,b,c], searchable}} |
| … | … | … | … | … |

> Do not include `id`, `created_at`, `updated_at`, or the auto-generated `label` field — Semantius creates these automatically.

**Relationships**

- {{Prose description of each relationship this entity participates in, including cardinality and ownership. Example: "A `{{this}}` belongs to one `{{parent}}` (N:1, required, cascade on delete)." / "A `{{this}}` may have many `{{child}}` records (1:N, via `{{child}}.{{this}}_id`)." / "`{{this}}` ↔ `{{other}}` is many-to-many through the `{{junction}}` junction table."}}

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

## 6. Open questions

Questions the analyst flagged during the session. Every entry must be phrased as a **forward-looking question** that a reviewer can answer — not as a decision log or assumption narrative. Split into two severity buckets and keep both headings even when empty (use "None." under an empty bucket).

**How to phrase entries.** Wrong: *"Contracts folded into subscriptions — if MSAs become needed, split them out."* (This is a decision log, not a question.) Right: *"Should contracts be separated from subscriptions to support master service agreements with multiple sub-products?"* Wrong: *"Actual invoiced spend is out of scope."* Right: *"Is tracking actual invoiced spend (paid vs. due, dispute handling) required, or is the expected-spend calculation from subscription terms sufficient?"*

### 6.1 🔴 Decisions needed (blockers)

Questions where the model is **ambiguous or incomplete** without an answer. Leaving these open means the deployer has to guess at entity shape, cardinality, or required fields. The semantic-model-deployer skill refuses to proceed while any 🔴 question is unresolved.

- {{Blocker question 1 — e.g. "Can a user hold multiple roles concurrently, or exactly one? This changes whether `user_roles` is a junction or a FK on `users`."}}
- {{Blocker question 2}}

### 6.2 🟡 Future considerations (deferred scope)

Questions about extensibility or scope that are **fine to leave open**. These capture trade-offs the analyst deliberately deferred — the model works as-is, but a future business need would trigger a change. Safe to ignore at implementation time.

- {{Deferred-scope question 1 — e.g. "Should the `category` enum on `subscriptions` and `budget_lines` be promoted to a lookup table if the category list starts evolving frequently?"}}
- {{Deferred-scope question 2}}

## 7. Implementation notes for the downstream agent

A short checklist for the agent who will materialise this model in Semantius (or equivalent):

1. Create one module named `{{system_slug}}` (the module name **must** equal the `system_slug` from the front-matter — do not invent a different module slug here) and two baseline permissions (`{{system_slug}}:read`, `{{system_slug}}:manage`) before any entity.
2. Create entities in the order given in §2 — entities referenced by others first.
3. For each entity: set `label_column` to the snake_case field marked as label in §3, pass `module_id`, `view_permission`, `edit_permission`. Do **not** manually create `id`, `created_at`, `updated_at`, or the auto-label field.
4. For each field in §3: pass `table_name`, `field_name`, `format`, `title` (the Label column), and for `reference`/`parent` fields also `reference_table` and a `reference_delete_mode` consistent with §4. (The §3 `Required` column is analyst intent; the platform manages nullability internally and does not need a per-field flag.)
5. **Fix up each entity's auto-created label-column field title.** `create_entity` auto-creates a field whose `field_name` equals the entity's `label_column`, and its `title` defaults to `singular_label` (e.g. entity `vendors` with `singular_label: "Vendor"` and `label_column: "vendor_name"` yields an auto-field `vendors.vendor_name` with title `"Vendor"`). If the §3 field table specifies a different Label for the label_column row (e.g. `"Vendor Name"` instead of `"Vendor"`), follow up with `update_field` to set the correct title. The `update_field` `id` is the **composite string** `"{table_name}.{field_name}"` (e.g. `"vendors.vendor_name"`) — **pass it as a string, not an integer**, or the update will fail.
6. **Deduplicate against Semantius built-in tables.** This model is self-contained and may declare entities (e.g. `users`, `roles`, `permissions`) that already exist in Semantius as built-ins. For each declared entity, read Semantius first: if a built-in already covers it, **skip the create** and reuse the built-in as the `reference_table` target — do not attempt to recreate. Optionally add missing fields to the built-in only if the model requires them (additive, low-risk changes only).
7. After creation, spot-check that `label_column` on each entity resolves to a real field and that all `reference_table` targets exist.
```

## Template ends above this line

---

## Authoring guidance

- Use the fenced `markdown` block so the model is self-contained when copied.
- Table columns are fixed — don't rename or reorder them. Agents parse by header.
- If a field is a reference, always put the arrow + target + cardinality in the "Reference / Notes" column, e.g. `→ accounts (N:1)`. If it's a parent (ownership), use `↳ accounts (N:1, cascade)` so the distinction is visible.
- The §2 Mermaid diagram is **required** — it must list every entity in the summary table and every relationship in §4. Regenerate it whenever entities or relationships change.
- Keep the "Open questions" section and both severity sub-sections (§6.1 Decisions needed, §6.2 Future considerations) even when empty — write "None." under an empty bucket. Every entry is a forward-looking question; decision-log prose ("X was folded into Y") does not belong here. The semantic-model-deployer skill uses §6.1 as a gate — any unresolved 🔴 item blocks deployment.
- **§7 module name must equal `system_slug`.** The frontmatter `system_slug` is the single source of truth for the module identifier. Do not introduce a second name like `{domain}_spend` or `{domain}_tracker` in §7 — if the frontmatter says `acme_crm`, §7 step 1 must read "Create one module named `acme_crm` …" and the permissions must be `acme_crm:read` / `acme_crm:manage`. A divergence between frontmatter and §7 is a blocker: the downstream deployer sees two authoritative sources and cannot pick silently.
- **§7 must explain the label-column title fixup.** After `create_entity`, Semantius auto-creates a field named `<label_column>` with its `title` defaulting to `singular_label`. If any entity's §3 field table specifies a Label for the label_column row that differs from `singular_label` (e.g. `singular_label: "Vendor"` but §3 Label `"Vendor Name"`), §7 step 5 must explicitly instruct the implementer to call `update_field` with the composite string id (`"{table_name}.{field_name}"`, passed as a **string** not an integer) to set the correct title. Do not silently harmonise labels to avoid the fixup — `singular_label` stays a bare singular for plural/singular symmetry, and field-level titles live on the field.
- The front-matter is YAML — every value must be quoted if it contains a colon.
- `initial_request` is **immutable**. It captures the user's verbatim opening ask from the Create session. Audit and Extend modes must preserve it exactly — never rewrite, summarize, tidy, or "improve" it, even if the wording is rough or the scope has since expanded. It's a historical record of the original intent, not a live scope statement. Use a YAML literal block (`|`) so newlines and punctuation survive round-trips.
- If the system has no enums, §5 can read "No enumerations defined." — don't omit the section; keeping section numbers stable helps humans navigate multiple models.
