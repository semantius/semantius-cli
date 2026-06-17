# Semantic Blueprint Template

Use this template verbatim for the final semantic-blueprint output the architect produces. Each `{{placeholder}}` is replaced with the value gathered during the workflow.

The blueprint is **platform-agnostic and entity-level only**. No fields. No JsonLogic. No DDL. The downstream `semantius-analyst` skill takes this blueprint, reconciles it against the live Semantius catalog, and produces a `*-semantic-spec.md` that carries the field-level detail.

Keep the section order and the table columns identical, downstream skills parse by header.

---

## Template starts below this line

````markdown
---
artifact: semantic-blueprint
blueprint_version: "3.0"
license: {{license slug, e.g. MIT}}
system_name: {{System display name — keep acronyms as acronyms (CRM, ITSM, CMDB)}}
system_description: {{Compact tagline ≤40 chars shown beside system_name in the UI module selector. For acronyms use the plain English expansion (CRM → "Customer Relationship Management"). For non-acronym names use a 2-4 word disambiguating phrase.}}
tagline: {{One-line marketing-voice line for catalog / card surfaces. Elevator pitch. Distinct from system_description (display name) — this is the "what's in it for me" line.}}
description: {{Longer marketing-voice prose for the catalog page (1-3 paragraphs). Reads to a buyer, not to the analyst. Multi-line YAML block (|) is fine.}}
system_slug: {{system_slug_snake_case}}
domain_modules:
  - {{system_slug}}
domain_code: {{TLA code, e.g. ATS, HCM, ITSM, CRM}}
related_modules: [{{slug_1, slug_2, ...}}]
persona: [{{PERSONA-1, PERSONA-2, ...}}]
module_kind: {{starter | master | domain — informational label, NOT a behavior switch}}
raci_mode: {{living | documentation — OPTIONAL hint only. The analyst confirms with the user (catalog-aware default) and the deployer is authoritative. Omit to let the analyst decide.}}
created_at: {{YYYY-MM-DD}}
---

# {{System display name}}

## 1. Overview

{{Two or three sentences describing the system, its users, and the problem it solves. Catalog-readable narrative — downstream skills copy this verbatim into human-facing READMEs. Hard bans: no §-number cross-references (no "see §6"); no snake_case identifiers (no `cost_center_id`); no platform plumbing words ("Semantius", "deployer", "deploy time", "self-contained"); no scope-deferral or authoring-decision narration ("deliberately out of scope", "moved to a sibling domain"). Deferrals live in `related_modules` plus §6, never in §1 prose.}}

## 2. Entity summary

| Name | data_object | Description |
| --- | --- | --- |
| {{Plural Label 1}} | `{{table_name_1}}` | {{One-sentence description of what a record represents and when it's created.}} |
| {{Plural Label 2}} | `{{table_name_2}}` | … |

**Column rules:** `Name` is the entity's **plural** display label and MUST equal the §3 `plural` column byte-for-byte. `data_object` is the bare backticked `table_name` (lower snake_case `[a-z][a-z0-9_]*`, no parenthesized label) and MUST equal the §3 `data_object`. The Mermaid node label below also uses the **plural** label.

```mermaid
flowchart LR
  classDef master fill:#d4f4dd,stroke:#27ae60,color:#0b3d20;
  classDef contributor fill:#cfe8ff,stroke:#1976d2,color:#0d3a66;
  classDef consumer fill:#e8def8,stroke:#7b1fa2,color:#3a155d;
  classDef platform_builtin fill:#e0e0e0,stroke:#424242,color:#1a1a1a;
  {{table_name_1}}["{{Plural Label 1}}"]
  {{table_name_2}}["{{Plural Label 2}}"]
  users["Users"]
  {{table_name_1}} -->|"{{verb}}"| {{table_name_2}}
  users -->|"holds"| {{table_name_1}}
  class {{table_name_1}} master;
  class {{table_name_2}} contributor;
  class users platform_builtin;
```

**Role classes used by the diagram:**

- **`master`** (mint green) — entities owned by this module. Mastered here, possibly embedded by other modules.
- **`contributor`** (light blue) — entities that participate in this module's workflows but are *mastered in another module*. They appear here because the module needs them; the analyst may reconcile them against the live catalog.
- **`consumer`** (lavender) — entities this module *reads* but does not own.
- **`platform_builtin`** (grey) — entities the platform ships (`users`, `roles`, `permissions`). Always reused; never created.

**Cardinality conventions:**

| Cardinality | Syntax | Reads as |
| --- | --- | --- |
| one-to-many | `A --> B` | A has many B |
| one-to-one | `A --- B` | A has one B |
| many-to-many | two `-->` edges via junction | both sides hold many junction rows |
| Labeled | `A -->|verb| B` | edge carries the relationship verb |

Junction tables get their own node with two `-->` edges in from the parents. Never draw a direct M:N edge between two parents.

**Edge labels are managed metadata, not free guesses.** Every edge carries a verb drawn from §5 (the verb column). The diagram and §5 must agree byte-for-byte.

## Additional Requirements Specification

_**OPTIONAL, omit this heading entirely when unused** (the normal case). This is the one sanctioned exception to the "no field-level content" rule: a free-prose channel for a requirement the analyst MUST honor to build a correct spec but CANNOT derive from the entity-level structure (a specific field a cost / rollup view depends on, a fixed unit or currency, a cross-module denormalization-and-dedup rule, an externally-mandated value). It is omit-when-empty (like the §3 per-entity sub-blocks), NOT a canonical keep-with-placeholder section, so never write a `_(none: …)_` placeholder here._

_**Placement:** immediately after §2 and before §3, at the seam where the human-readable orientation (Overview, entity summary, diagram) ends and the structured sections begin. Keeping it out of §1 / §2 leaves the human-readable block intact._

_**Audience and register:** the downstream skills, not a human reviewer. The architect preserves it on clone / customize and may author it on greenfield; the analyst consumes it during field elicitation. Write in compact technical register, backticked `table_name` / `field_name` identifiers are expected, and Writing Conventions 6 and 8 (no identifier leakage / plain language) do NOT apply here. Conventions 1 (US English) and 2 (no em-dash) still do._

{{Free prose. Name entities and fields by their `data_object` / field identifiers; for each requirement state what is needed and WHY it cannot be derived (what breaks downstream if ignored). Keep it to genuine non-derivable requirements, do NOT restate fields the analyst would obviously draft, and do NOT turn this into a parallel field table, which re-imports the field-level content the entity-only split exists to remove.}}

## 3. Entities catalog

| # | data_object | canonical code | singular | plural | role | mastered in | mastered label | necessity | pattern flags | entity_type | write tier | notes |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `{{table_name}}` | `{{canonical_code}}` | {{Singular Label}} | {{Plural Label}} | master \| embedded_master \| contributor \| consumer | `-` (this module owns) \| `<other_module_slug>` | `-` (this module owns) \| {{Display name of owner module}} | required \| optional | personal_content \| submit_lock \| single_approver \| - | operational_workflow \| operational_record \| catalog \| junction \| computed | `:manage` \| `:admin` \| `:read` \| `:manage` _(pending)_ | {{optional one-liner}} |
| 2 | … | … | … | … | … | … | … | … | … | … | … | … | … |

**Column rules:**

- **`data_object`** — the backticked snake_case `table_name` and **nothing else** (no parenthesized label). Lower snake_case matching `[a-z][a-z0-9_]*`, always the plural form for the table name (`candidates`, not `candidate`); Semantius requirement. This is the **local / dialect** name the entity deploys under. Must equal this entity's §2 `data_object` byte-for-byte.
- **`canonical code`** (blueprint_version 3.0+) — the entity's **canonical uber-model code**: the stable design-time identity, lower snake_case plural, backticked. This is the lineage carrier the analyst threads through to the spec and the deployer stamps into `entities.catalog_entity_code` (NOT the deployed `table_name`, which lives in `data_object` / `entities.table_name` and may drift). **Agent-optimized self-describing naming: canonical = local** — set `canonical code` equal to `data_object`. When the deployed `data_object` is a **vendor dialect** (`accounts` for canonical `customers`) or a **silo rename** (`erp_vendors` for canonical `vendors`), `canonical code` carries the canonical concept and `data_object` the deployed name. Stamp the canonical code only when the entity maps to a recognized uber-model concept you can name confidently; otherwise default `canonical code = data_object` (never invent a canonical name). Catalog-clones inherit the source slice's canonical code. The deployer treats it as write-once identity, so a later rename touches `table_name` only, never this code.
- **`singular`** — the entity's **singular** display label (e.g. `Candidate`). Must equal the parenthetical in this entity's §7 lifecycle heading byte-for-byte. Maps to the platform's `entities.singular_label`.
- **`plural`** — the entity's **plural** display label (e.g. `Candidates`). Must equal the §2 `Name` column and the §2 Mermaid node label byte-for-byte. Maps to the platform's `entities.plural_label`.
- **`role`** — one of:
  - `master`: this module is the canonical owner of the entity; lifecycle defined in §7. Only the canonical owner module declares `master`.
  - `embedded_master`: this module needs the entity self-contained today, but a different module is the *intended* canonical owner (named in `mastered in`). Until that owner is installed, this module hosts the entity; once the owner installs, the entity migrates automatically without data movement. Use when the blueprint stands alone but expects a future master. Example: `candidates` in `hiring-starter` with `mastered in: ats-candidate-crm`.
  - `contributor`: mastered elsewhere (per `mastered in`) but participates in this module's workflows. The analyst wires reuse-from at deploy time. Example: `skill_profiles` in `ats-candidate-crm` with `mastered in: lms-skills`.
  - `consumer`: read by this module; never written here. Example: `career_aspirations` (read-only reference from another module).
- **`mastered in`** — `-` when this module owns the entity (role = `master`). Otherwise, the snake_case slug of the canonical owner module (`ats-candidate-crm`, `lms-skills`, `talent-succession-career`). For `embedded_master`, this names the *future* owner.
- **`mastered label`** (formerly `label`) — `-` when `mastered in` is `-`. Otherwise, the human-readable display name of the **owning module** (`Candidate CRM`, `Skills and Learning Paths`, `Succession and Career Planning`). It names the owner module, NOT this entity (the entity's own labels are the `singular` / `plural` columns); the analyst uses it in user-facing prompts so users don't see raw slugs. For platform built-ins (`users`, `roles`), use `_(platform built-in)_` in both `mastered in` and `mastered label`.
- **`necessity`** — `required` or `optional`. Optional entities are presented to the user during reconciliation; the user picks which to include. Common candidates for optional: `locations` (some orgs have one), `cost_centers` (some orgs don't track), `tags` (nice-to-have).
- **`pattern flags`** — semicolon-separated flags. Currently defined:
  - `personal_content` — the entity carries per-user content (notes, journal entries, drafts) and needs row-scope read/edit overrides (`view_all_*` / `manage_all_*` permissions in §8.1).
  - `submit_lock` — the entity locks fields against further edits once a submit-state flag fires (interview scorecards, time entries, approvals).
  - `single_approver` — the entity carries one approver field that gates a lifecycle transition (offers, change requests). The §8.2 rule for `has_single_approver` MUST name the actual approve gate via `permission_verb_override` (e.g. `approve_offer`); phantom `approve_<entity>_approval` codes are an error.
  - `multi_approver` — multiple approvers gate the transition.
  - `terminal_lock` — the entity locks fully at a terminal lifecycle state.
  - More flags may be added; unknown flags are passed through verbatim.
- **`entity_type`** (blueprint_version 3.0+) — the entity's **data-class axis**, mirroring the closed upstream `data_objects.entity_type` set: one of `operational_workflow`, `operational_record`, `catalog`, `junction`, `computed` (the sixth value `unclassified` is the platform's empty default and is **not** authored here — emit a concrete class). This is the **primary classification**: `write tier` derives FROM it, never the reverse. Sourced from Stage 9 (carry-forward from the upstream `data_objects` value for catalog-clones when it is classified; otherwise derive via the Stage 9 ladder, reading §5 for junctions and §7 for workflow-vs-record). Maps to the platform's `entities.entity_type`. The set is **closed** — never coin a value outside it.
- **`write tier`** — the entity's edit-permission tier, **DERIVED from `entity_type`** (do not classify the tier independently): `catalog` → `:admin`; `operational_workflow` / `operational_record` → `:manage`; `junction` → neighbor-based (`:manage` by default, following its parents); `computed` → `:read` (read-only). One of `:manage` (operational, default), `:admin` (reference / config), `:read` (computed / read-only), or `:manage` _(pending)_ when the tier depends on what gets installed (`embedded_master` rows whose canonical owner isn't yet present and may shift the tier). Consumed by the analyst verbatim (the analyst no longer re-derives the tier — it validates against the live catalog and emits drift only).

## 4. Aliases and industry synonyms

_(Use this section to record industry-scoped synonyms and aliases the analyst should map during reconciliation. Generic synonyms that any reader would recognize are common knowledge and need not be listed.)_

| table_name | alias | scope | notes |
| --- | --- | --- | --- |
| `{{table_name}}` | `{{alias}}` | industry \| vendor \| domain | {{why this alias matters for reconciliation}} |

If no aliases apply, **keep this heading** and write the canonical empty-section placeholder `_(none: <short reason>)_` in place of the table (bare `_(none)_` is allowed when no reason adds value). **Never omit a canonical section and never leave a bare empty heading.** See "Empty-section convention" in the authoring guidance below for the single rule that governs every canonical section.

## 5. Relationships

### 5.1 Intra-scope edges

Edges where both endpoints are §3 entities owned or co-located in this module. Every row maps 1:1 to a Mermaid edge in §2.

| from | verb | to | cardinality | kind | necessity | owner_side | delete_mode | fk_format | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{{from_table}}` | `{{verb_in_parent_voice}}` | `{{to_table}}` | one_to_many \| one_to_one \| many_to_many | reference \| parent | required \| optional | source \| target | restrict \| clear \| cascade | reference \| parent | {{free-form, see below}} |

**Column rules:**

- **`verb`** — parent-voice (the entity that *points at the other* speaks). Fills the sentence "a `{{from}}` ___ many `{{to}}`". Prefer specific verbs (`owns`, `employs`, `attracts`) over filler (`has`, `references`).
- **`cardinality`** — full words: `one_to_many`, `one_to_one`, `many_to_many`. The analyst translates to Semantius `parent`/`reference` format at spec time.
- **`kind`** — `reference` (independent lifecycle, default) or `parent` (master-detail child; child has no meaning without parent).
- **`necessity`** — `required` means the FK is NOT NULL in the spec; `optional` is nullable. **Presence-conditional**: a `required` edge is a mandatory FK only when the target entity is installed in the same deploy; it NEVER forces the target to install. See §5.3 vocabulary for cross-scope expression.
- **`owner_side`** — `source` means the row's `from` column owns the FK column; `target` means the `to` column does. Useful when `owner_side` is non-obvious from cardinality alone.
- **`delete_mode`** — what happens to this row when the referenced row is deleted. `restrict` (default for `kind=reference`; protects the parent), `clear` (NULL the FK on the child; only valid when `necessity=optional`), `cascade` (default for `kind=parent`; deletes the child). The analyst consumes this verbatim — does not re-derive at deploy time.
- **`fk_format`** — the Semantius FK shape on the field-level spec. `parent` for ownership/composition + junction-table edges (both FK fields in an M:N junction use `parent`); `reference` otherwise. Same value the analyst writes to `fields.format`; emitting it here makes the analyst's FK-shape derivation consume-only.

### 5.2 Built-in edges (`users` and other platform built-ins)

Edges where one endpoint is a Semantius platform built-in (`users`, `roles`, `permissions`). Treated separately because the deployer reuses the built-in; no `create_entity` call.

| from | verb | to | cardinality | necessity | owner_side | delete_mode | fk_format | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `users` | `{{verb}}` | `{{table_name}}` | one_to_many | required \| optional | source \| target | restrict \| clear | reference | {{notes}} |

### 5.3 Cross-scope edges

Edges where one endpoint is in a *different* module (contributor or consumer per §3, or an entity not listed here at all). The analyst resolves each row against the live catalog at reconciliation time: target present → wire up the FK; target absent → emit no column and no constraint. `necessity = required` is **presence-conditional**: a required edge becomes a mandatory FK only when the target entity is installed, and it NEVER forces the target to install.

**Greenfield mode**: **keep this heading.** Populate it only when the user explicitly requested cross-scope edges during the architect conversation; otherwise write the canonical placeholder `_(none: <short reason>)_` (e.g. `_(none: greenfield module, no cross-scope edges requested)_`).

**Catalog-clone mode**: inherit rows from the source blueprint and adjust. If the user trims everything, **keep the heading and write `_(none: <short reason>)_`** in place of the rows — do not delete the section.

**Empty representation:** when §5.3 (or either of its §5.3a / §5.3b sub-blocks) has no rows, write the canonical placeholder `_(none: <short reason>)_` under the relevant heading. **Never omit a canonical section and never write a free-text stub** like *"no cross-scope edges declared..."* — the single empty-section rule is defined in the authoring guidance below.

#### 5.3a Outbound from this scope's masters and contributors

_Edges this scope drives: the in-scope endpoint has `role` of `master` or `contributor`._

| from | verb | to | cardinality | kind | necessity | owner_side | delete_mode | fk_format | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{{from_table}}` | `{{verb}}` | `{{to_table_possibly_in_other_module}}` | one_to_many \| … | reference \| parent | required \| optional | source \| target | restrict \| clear \| cascade | reference \| parent | {{module / cluster / domain hints}} |

#### 5.3b Context edges on embedded shells and consumed entities

_Edges the canonical owner drives, shown for context: the in-scope endpoint has `role` of `embedded_master`, `consumer`, or `derived`._

| from | verb | to | cardinality | necessity | delete_mode | fk_format | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{{from_table}}` | `{{verb}}` | `{{to_table}}` | one_to_many \| … | required \| optional | none \| `none (required-if-present)` \| `⚠ audit: <reason>` | n/a | {{notes}} |

**§5.3b `delete_mode` vocabulary** (distinct from §5.1 / §5.2 / §5.3a):

- `none` — the edge is fully optional from this scope's perspective. No FK column emitted unless the user opts in.
- `none (required-if-present)` — the canonical owner marks the edge as required, but it's presence-conditional from this scope's perspective: if the target entity is installed, the FK becomes mandatory; if absent, the edge is dormant (no column, no constraint). This is the row-10 framing.
- `⚠ audit: <reason>` — a soft data-quality flag: the canonical owner declares a required edge whose target sits outside the installable closure (e.g. *"required composed child out of scope"*). The architect surfaces the flag verbatim; the analyst expects the source data fixed upstream, not modeled around. Common reason text: `required composed child out of scope`, `required parent missing`.

**§5.3b `fk_format` is `n/a`** — these edges are context-only; the analyst doesn't emit a field for them in this scope's spec. The owning module's spec carries the field.

## 6. Cross-domain context

Catalog-clone blueprints inherit this section from the source. Greenfield blueprints are typically sparse here; the analyst may fill in details during reconciliation. **Keep §6 and all four sub-blocks (§6.1–§6.4) present in every blueprint.** Any sub-block with no rows carries the canonical placeholder `_(none: <short reason>)_` in place of its table — never omit a sub-block and never leave a bare empty heading. See "Empty-section convention" in the authoring guidance below.

### 6.1 Master consumers (other modules / domains that embed this scope's masters)

| data_object | other module / domain | role | necessity | notes |
| --- | --- | --- | --- | --- |
| `{{table_name}}` | {{OTHER_MODULE_SLUG_UPPER}} ({{Display Name}}) - {{DOMAIN_CODE}} | embedded_master \| consumer | required \| optional | {{notes}} |

### 6.2 Outbound handoffs (events this scope publishes)

| source module | target domain | target module | trigger_event | transition | payload | integration | friction | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| {{THIS_MODULE_UPPER}} | {{TARGET_DOMAIN_CODE}} | {{TARGET_MODULE_UPPER}} | `{{event_name_snake_case}}` | `{{to_state}}` _({{event_category}})_ | `{{payload_entity}}` | event_stream \| api_call \| batch_sync \| lifecycle_progression | low \| medium \| high | {{one-liner about what the receiver does with the event}} |

**`transition` column** — for a `lifecycle` event, the entity's `to_state` on the source's §7 lifecycle table (e.g. `hired` _(lifecycle)_); for a `state_change` event, the named transition (e.g. `accepted` _(state_change)_); for an `entity_event` (insert / update / delete on the payload entity), `_(entity_event)_` alone. The analyst validates that `to_state` exists in the source entity's §7 before emitting the handoff. `event_category` parenthetical: one of `lifecycle`, `state_change`, `entity_event`.

**`integration` values:**

- `event_stream` — fire-and-forget pub/sub.
- `api_call` — synchronous call to the target module.
- `batch_sync` — periodic ETL or scheduled sync.
- `lifecycle_progression` — a lifecycle state transition on the source automatically advances a related record on the target (e.g. a candidate becoming `hired` triggers an employee record).

**`friction` values:** `low` (well-defined contract), `medium` (some mapping ambiguity), `high` (identity reconciliation or schema-translation work needed).

### 6.3 Inbound handoffs (events this scope reacts to)

| target module | source domain | source module | trigger_event | transition | payload | integration | friction | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| {{THIS_MODULE_UPPER}} | {{SOURCE_DOMAIN_CODE}} | {{SOURCE_MODULE_UPPER}} | `{{event_name}}` | `{{to_state}}` _({{event_category}})_ | `{{payload_entity}}` | … | … | … |

### 6.4 Master providers (modules / domains that own masters this scope embeds)

| data_object | role here | necessity | canonical owner(s) | slice notes |
| --- | --- | --- | --- | --- |
| `{{table_name}}` | contributor \| consumer | required \| optional | {{OWNER_MODULE_UPPER}} ({{DOMAIN_CODE}}) | {{e.g. "only the active_skills slice is read"}} |

## 7. Lifecycle states (per master)

For every entity with `role = master` in §3, emit one sub-section. Entities without lifecycle states (pure reference data) are skipped.

### `{{master_table_name}}` ({{Singular Label}})

| order | state_name | initial? | terminal? | requires_permission? | derived gate | description |
| ---: | --- | :---: | :---: | :---: | --- | --- |
| 1 | `{{state_1}}` | ✓ | - | - | - | {{one-line description}} |
| 2 | `{{state_2}}` | - | - | ✓ | `{{system_slug}}:{{permission_suffix}}` | {{description of the gated transition}} |
| 3 | `{{state_3}}` | - | ✓ | - | - | {{terminal state description}} |

**Column rules:**

- **`order`** — lifecycle progression order, 1-based; not an enum_value index.
- **`state_name`** — backticked snake_case enum value.
- **`initial?`** — ✓ on exactly one row per entity (the first state new records land in).
- **`terminal?`** — ✓ on every terminal state (no transitions out of this state).
- **`requires_permission?`** — ✓ when transitioning *into* this state requires a specific permission beyond `baseline-manage`. Architect Stage 10 (W1/W2/W6 only) marks these; the corresponding permission row appears in §8.1 as a `workflow-gate (lifecycle)` row.
- **`derived gate`** — when `requires_permission? = ✓`, this column carries the permission code (`<system_slug>:<suffix>`) that gates the transition. Otherwise `-`. When the gate cannot be resolved (e.g. the named verb is missing from §8.1), emit `⚠ unresolved gate: <reason>` instead of fabricating a code.

**State field (fixed name `workflow_state`).** The field that stores this lifecycle is materialized downstream (by the analyst) as a single required `enum` named **exactly `workflow_state`**: its `enum_values` are the `state_name`s above in `order`, its default is the `initial?` state. This name is fixed platform-wide — never `status` / `state` / `lifecycle_state`. The deployer rejects any module that stores lifecycle state under another field name.

**Data-quality annotations (soft):** §7 cells may carry `⚠ <reason>` annotations when the emitter detects a malformed shape. These are surface flags meant to be FIXED upstream, not modeled around:

- `⚠ state-machine shape` (in the `description` cell of an offending row) — the state has no incoming transition, or there's no path from `initial` to this state, or a terminal state has outgoing transitions. The architect surfaces; the analyst skips that row's downstream emission and asks the user to fix the source data.
- `⚠ unresolved gate: <reason>` (in the `derived gate` cell) — `requires_permission? = ✓` but the canonical gate verb is missing from §8.1 or §8.2.

Example row with annotations:

| 4 | `{{state_4}}` | - | - | ✓ | ⚠ unresolved gate: verb missing from §8.1 | ⚠ state-machine shape: no incoming transition |

## 8. Permissions and business rules (derived)

The full permission catalog and rule list. The analyst expands this to spec-format §8 implementation notes at reconciliation time.

### 8.1 Permissions

| permission | tier | description | included in `:admin`? |
| --- | --- | --- | --- |
| `{{system_slug}}:read` | baseline-read | Read access to every entity in the module | ✓ |
| `{{system_slug}}:manage` | baseline-manage | Edit operational records | ✓ |
| `{{system_slug}}:admin` | baseline-admin | Edit reference data and inherit every workflow gate below | - |
| `{{system_slug}}:{{workflow_suffix}}` | workflow-gate (lifecycle) | Transition `{{table}}` into state `{{state}}` | ✓ |
| `{{system_slug}}:view_all_{{plural}}` | override (personal_content) | View all `{{table}}` rows beyond row-scope | ✓ |
| `{{system_slug}}:manage_all_{{plural}}` | override (personal_content) | Manage all `{{table}}` rows beyond row-scope | ✓ |

**Tier vocabulary:**

- **`baseline-read`** — module-wide read; usually held by every module user.
- **`baseline-manage`** — module-wide edit on operational records.
- **`baseline-admin`** — module-wide edit on reference/config records and inherits every workflow-gate below.
- **`workflow-gate (lifecycle)`** — gates a specific lifecycle transition (per §7 `requires_permission?` rows).
- **`workflow-gate (rule)`** — gates a specific business rule (per §8.2 rules with `require_permission`).
- **`override (personal_content)`** — broadens default row-scope visibility/edit for `personal_content`-flagged entities (per §3 pattern flags).
- **`narrow`** — sub-tier of `baseline-manage` granted to external participants (e.g. panel interviewers); declared explicitly when the workflow involves outsiders who write specific tables without broader operational access.

**Two-permission fallback:** if every entity is operational and the module declares no workflow gates and no overrides, omit `baseline-admin` and end the table at `<slug>:manage`.

### 8.2 Business rules

| rule_name | data_object | source flag | intent |
| --- | --- | --- | --- |
| `{{rule_name}}` | `{{table_name}}` | has_personal_content \| has_submit_lock \| has_single_approver \| lifecycle \| owner_edit \| narrow_write | {{one-sentence intent — analyst converts to JsonLogic at spec time. For `has_single_approver`, this prose must name the actual approve gate (e.g. `approve_offer`), not a phantom `approve_<entity>_approval`.}} |

**Keep this heading.** When the module declares no flag-derived business rules, write the canonical placeholder `_(none: <short reason>)_` in place of the table — do not omit §8.2.

**`source flag` vocabulary:**

- `has_personal_content` — the entity carries `personal_content` flag in §3; the rule encodes row-scope with overrides (`view_all_<plural>`, `manage_all_<plural>`).
- `has_submit_lock` — the entity carries `submit_lock` flag; the rule encodes the submit-then-locked posture and the `submit_<singular>` override.
- `has_single_approver` — the entity carries `single_approver` flag; the rule REQUIRES a `permission_verb_override` naming the actual approve gate (e.g. `approve_offer`). The named gate MUST appear in §8.1 as a `workflow-gate (lifecycle)` row. Phantom `approve_<entity>_approval` codes are an authoring error caught by pre-save verification.
- `lifecycle` — the rule gates a state transition declared in §7.
- `owner_edit` — the rule restricts writes to the row's submitter / assignee / author.
- `narrow_write` — the rule allows a narrow-tier role to write a specific subset of fields.

## 9. Roles, RACI, and responsibilities (derived)

_Baseline roles, the permission hierarchy, and RACI realization are DERIVED from this scope's entity-type write tiers + `process_raci`. In `documentation` mode the deployer provisions them as RBAC grants (none of it stored in the catalog); in `living` mode the RACI matrix is stored in the catalog (`processes` / `raci_assignments` / `process_gates`) and enforced live (`is_raci_actor` / `has_consultation`). The architect stays **mode-agnostic** — it names processes (with a stable `process_key`), actors, letters, and per-consulted mode; the analyst picks the mode and the concrete realization._

### 9.1 `{{SYSTEM_SLUG_UPPER}}`

**Baseline roles:**

| role | baseline grant |
| --- | --- |
| `{{system_slug}}_viewer` | `{{system_slug}}:read` |
| `{{system_slug}}_manager` | `{{system_slug}}:manage` |
| `{{system_slug}}_admin` | `{{system_slug}}:admin` _(omit when the module has no `:admin` tier)_ |

**Permission hierarchy:**

_The hierarchy is roll-up: `:admin` includes `:manage`, `:manage` includes `:read`, `:admin` rolls up every workflow gate and pattern-flag override in §8.1, and `:manage` includes every `narrow`-tier permission in §8.1 (so full-tier holders pass the narrow check external participants hold in isolation)._

| permission | includes |
| --- | --- |
| `{{system_slug}}:admin` | `{{system_slug}}:manage` |
| `{{system_slug}}:manage` | `{{system_slug}}:read` |
| `{{system_slug}}:admin` | `{{system_slug}}:{{workflow_gate_1}}` |
| `{{system_slug}}:admin` | `{{system_slug}}:{{override_1}}` |
| `{{system_slug}}:manage` | `{{system_slug}}:{{narrow_1}}` |
| _(repeat one row per gate / override under `:admin`, and one row per `narrow` tier under `:manage`; emitter MUST list every §8.1 gate, override, and narrow permission)_ | |

**Processes wired:**

_The process catalog — one row per process, referenced by `process_key` from the RACI table below. Identity and metadata are authored **once** here, never repeated per RACI row._

| process_key | process_name | pcf_code | pcf_id | level | description |
| --- | --- | --- | --- | --- | --- |
| {{process_key_snake}} | {{Verb-first display name, e.g. "Hire candidate"}} | {{APQC PCF code e.g. 7.2.4.3, or —}} | {{PCF id e.g. 10465, or —}} | {{PCF level e.g. 4, or —}} | {{One paragraph; from the PCF element when mapped, else authored.}} |

**Column rules:**

- **`process_key`** — stable `snake_case` identifier (`hire_candidate`), matching `^[a-z_][a-z0-9_]*$`, unique within the module. **Authored, never derived** — the durable identity the RACI rows reference and the analyst reconciles against the live `processes` catalog. The display name may change; the key does not.
- **`process_name`** — human display label (`Hire candidate`). Not unique; cosmetic.
- **`pcf_code` / `pcf_id` / `level`** — OPTIONAL APQC Process Classification Framework anchor, supplied by the upstream uber model when the process maps to a standard PCF element (`level` = the code's hierarchy depth). Leave `—` for custom processes. **Provenance only** — these stay in the blueprint; they are NOT deployed to the live `processes` table (which has no PCF columns). `process_key` is the join-back key if PCF lineage is ever needed downstream.
- **`description`** — one paragraph. From the PCF element when mapped, otherwise authored. Deployed to `processes.description`.

**RACI realization:**

| actor | kind | raci | process_key | consult_mode | realization |
| --- | --- | --- | --- | --- | --- |
| `{{ACTOR-NAME-UPPER}}` | persona \| skill | responsible | {{process_key}} | — | grant gates [{{slug:verb_1, slug:verb_2}}] + the gated entities' write tier |
| `{{ACTOR-NAME-UPPER}}` | persona \| skill | accountable | {{process_key}} | — | approval gate |
| `{{ACTOR-NAME-UPPER}}` | persona \| skill | consulted | {{process_key}} | read \| notify \| block | advisory read grant |
| `{{ACTOR-NAME-UPPER}}` | persona \| skill | informed | {{process_key}} | — | notification side effect (trigger_event / webhook_receiver) |

**Column rules:**

- **`actor`** — UPPER-CASE, hyphen-separated. Persona examples: `HIRING-MANAGER`, `RECRUITING-RECRUITER`, `LEGAL-COMPLIANCE-SPECIALIST`. Skill examples: `OFFER-DRAFTING-BOT`, `RESUME-PARSER`. Same actor may appear on multiple rows (one per process × raci combination).
- **`kind`** — `persona` for human roles, `skill` for agentic actors (the polymorphic R/A piece — Responsible or Accountable may be filled by an agent). Consulted / Informed are persona-only by convention.
- **`raci`** — `responsible` / `accountable` / `consulted` / `informed`. Multiple Rs per process are allowed; A SHOULD be singular per process.
- **`process_key`** — references a row in the **Processes wired** catalog above; every `process_key` used here MUST be defined there. This is the *only* process identifier on the RACI row — the display name lives in the catalog, not here (so renaming a process is a one-row edit).
- **`consult_mode`** — only for `consulted` rows: `read` (default — passive advisory read), `notify` (push a notification when the process reaches the gated transition), or `block` (the transition is gated until the consulted party has acted, e.g. "Legal must be consulted before an offer goes out" → `block`). Leave `—` on R / A / I rows. The whole column may be omitted when every consultation is `read`.
- **`realization`** — human-facing *intent* only. How the row is actually realized depends on the module's RACI mode (the analyst decides): in `documentation` mode it compiles to the RBAC grants below; in `living` mode it becomes live RACI rows + rules (`is_raci_actor` for A, `has_consultation` for C-block, the emit trigger for C-notify / I). Author the intent; do not encode enforcement mechanics. The mapping below is the documentation-mode default:
  - R → `grant gates [<list>] + the gated entities' write tier`. The gate list is the permission codes the actor needs to perform the process.
  - A → `approval gate` (when the process has a `single_approver` / `multi_approver` flag in §3, the named gate from §8.2 `permission_verb_override`; otherwise `the gated entities' write tier`).
  - C → `advisory read grant` (a row-scoped read added during deploy; or `consultation lifecycle state` when the process has an explicit consultation step in §7).
  - I → `notification side effect (trigger_event / webhook_receiver)` — wired as a notify action at deploy time, not a permission.

### 9.2 Functional ownership and default grants

_Market-level RACI: which business function OWNS / CONTRIBUTES-TO / CONSUMES this module's domain. Distinct from §9.1 operational RACI: this is the budget-and-strategic-control layer; §9.1 is the day-to-day-execution layer._

| responsibility | business function | default role | default tier |
| --- | --- | --- | --- |
| owner | {{Business function name, e.g. Recruiting, Sales, IT}} | `admin` | `:admin` |
| contributor | {{Adjacent business function}} | `manage` | `:manage` |
| consumer | {{Reading-only business function}} | `viewer` | `:read` |

**Column rules:**

- **`responsibility`** — `owner` (owns the budget and the data; receives admin grant by default); `contributor` (participates in workflows; manage grant); `consumer` (reads only; viewer grant). At least `owner` is required.
- **`business function`** — capitalized display name of the function (`Recruiting`, `Sales Operations`, `IT Service Management`). Maps to a real organizational unit / function at deploy time, not a persona.
- **`default role`** — one of `viewer` / `manager` / `admin` (matching §9.1 baseline-roles structure).
- **`default tier`** — `:read` / `:manage` / `:admin` (matching §8.1 baseline-tiers).

**Empty representation:** §9.2 is part of the optional §9 trio (RACI realization + Processes wired + §9.2 functional ownership) — that trio is present-together or absent-together. When the trio **is** present but no functional-ownership rows surfaced, keep this heading and write the canonical placeholder `_(none: <short reason>)_` in place of the table rather than leaving a bare empty heading.
````

## Template ends above this line

---

## Authoring guidance

- **Use the fenced ```` ```markdown ```` block** so the blueprint is self-contained when copied.
- **Table columns are fixed** — don't rename or reorder. The analyst parses by header.
- **§2 Mermaid diagram is required.** Every §3 entity must appear; every §5 edge must appear. Regenerate when entities or relationships change.
- **§7 lifecycle states**: one sub-section per `role = master` entity that has lifecycle. Reference-data masters without lifecycle (e.g. `recruitment_sources`) are skipped from §7 but still appear in §3.
- **§7 `requires_permission?` ✓ rows must have a matching §8.1 `workflow-gate (lifecycle)` row.** The architect's pre-save verification enforces this.
- **§8.1 `personal_content` overrides**: for every §3 entity flagged `personal_content`, emit a `view_all_<plural>` row and a `manage_all_<plural>` row.
- **§8.1 `submit_lock` overrides**: for every §3 entity flagged `submit_lock`, emit a `submit_<singular>` override row.
- **§9 emission — two layers.** The §9.1 **baseline roles** and **permission hierarchy** are always emitted (derived from §8.1; the hierarchy MUST list every §8.1 gate / override under the `<slug>:admin → ...` roll-up). The §9.1 **RACI realization** + **Processes wired** catalog and **§9.2 functional ownership** are OPTIONAL — catalog-clone slices of an uber-model carry them (preserve on customize); a greenfield blueprint emits them only when the conversation surfaced real processes / personas / owning functions, otherwise omits them. When RACI realization is present, its rows MUST mention every persona in the frontmatter `persona` list (and vice versa); when it is absent, omit the `persona` key.
- **No fields. No JsonLogic. No DDL.** The blueprint is platform-agnostic and entity-level only. Field-level work happens in the analyst's spec.
- **The one field-level exception, `## Additional Requirements Specification`.** An OPTIONAL, omit-when-unused free-prose section between §2 and §3 for a requirement the analyst must honor but cannot derive from the entity-level structure (a field a cost / rollup view depends on, a fixed unit or currency, a cross-module dedup rule). Compact technical register, backticked identifiers expected; Conventions 6 / 8 do not apply, Conventions 1 / 2 do. Author on greenfield only when genuinely needed; preserve and adjust on clone / customize / extend. Keep it narrow, it is not a backdoor for field tables.
- **Greenfield vs catalog-clone.** Greenfield: §5.3 and §6 are **kept (heading present) and carry the canonical `_(none: <short reason>)_` placeholder** when the conversation surfaced no cross-scope edges / cross-domain context; the §9 optional layer (RACI realization / Processes wired / functional ownership) is emitted only when the conversation surfaced it (an all-or-nothing trio inside §9, not a top-level-section omission — §9 and §9.1 stay present). Catalog-clone: §5.3, §6, the §9 optional layer, and `related_modules` are inherited from the source and preserved — trimmed/extended only as the customize conversation requires; any §5.3/§6 sub-block trimmed empty keeps its heading with the `_(none: …)_` placeholder.
- **Self-containment.** The blueprint must be readable without any external context. Embed concepts the module needs even when they overlap with another module, mark as `embedded_master` in §3 with `mastered in` pointing at the intended canonical-owner module (and `label` carrying the owner's display name). The analyst resolves these at reconciliation time: when the canonical owner installs, the entity migrates automatically; until then, this module hosts it. A blueprint that fails self-containment (an entity needs another module to function) is a defect the architect FLAGS — never something to assemble around.
- **Embedded-entity governance follows the entity, not the role.** An installing unit carrying an entity as `embedded_master` whose canonical owner is absent at deploy time emits that entity's FULL derived governance under the installing unit's slug: workflow gates (§8.1) re-prefixed, pattern-flag overrides (`view_all_<plural>` / `manage_all_<plural>` / `submit_<singular>`) + matching §8.2 rules re-prefixed, AND boundary-crossing handoffs in §6.2 / §6.3 (events the embedded entity publishes to / reacts from modules the unit doesn't "play"). Intra-set handoffs are hidden (when both source and target embedded entities live in the same installing unit, the handoff is internal). When the canonical owner later installs, the deployer reconciles every re-prefixed code onto the canonical prefix (sibling permissions + sibling role_permissions; no deletes). This convention is what lets bundles like `hiring-starter` round-trip cleanly.

### Front-matter rules

- **`artifact: semantic-blueprint`** — fixed; identifies the file type.
- **`blueprint_version: "3.0"`** — the blueprint format version (the schema of *this* file). Architect writes `"3.0"` for every blueprint at architect skill v5.0+ (major `3`; the `2.x → 3.0` major bump added the §3 `canonical code` and `entity_type` columns, so downstream parsers must read §3 **by header name, not column position**). Bump only when the blueprint shape changes (sections renumbered, columns added, etc.). Distinct from architect skill version.
- **`license`** — catalog metadata (e.g. `MIT`). Passes through to the spec; not provisioned to the module record today (follow-up when the platform exposes a `modules.license` column).
- **`system_name`** — display name; acronyms stay as acronyms (ATS, CRM, ITSM).
- **`system_description`** — ≤40-char tagline used by the deployer as the module record's `description` column. Spell out acronyms (`CRM` → "Customer Relationship Management"). Distinct from `tagline` (marketing voice) and §1 Overview (analyst-voice narrative).
- **`tagline`** — one-line marketing-voice line for catalog / card surfaces. The elevator pitch. Distinct from `system_description` (which is a short display name); not provisioned today (follow-up when the platform exposes a `modules.tagline` column).
- **`description`** — longer marketing-voice prose for the catalog page. Multi-line YAML block (`|`) is fine. Reads to a buyer, not to the analyst. Distinct from §1 Overview which is analyst-voice; not provisioned today (follow-up when the platform exposes a `modules.long_description` column).
- **`system_slug`** — lowercase snake_case identifier. Equals the module slug the deployer creates. **Never** appears as another name in §8.
- **`domain_modules`** — typically a single entry equal to `system_slug`. Multi-module blueprints (master modules hosting multiple shared masters) list each.
- **`domain_code`** — uppercase TLA / short code (ATS, HCM, ITSM, CRM, LMS, PA, BEN-ADMIN). Used in §6 handoff tables for the domain column.
- **`related_modules`** — **advisory integration hint**, not a deployment prerequisite. Every module deploys standalone (the `embedded_master` mechanism is the self-sufficiency lever, not a dependency). The list is a discovery tag for humans browsing the catalog: which modules sit nearby in data-coupling, handoff, or persona-reach terms. The analyst and deployer treat this list as informational and never auto-pull / auto-require any of the listed modules.
- **`persona`** — flat list of every persona name referenced in §9.1 RACI. Redundant with §9.1 but cheap to scan; the analyst uses it in pre-flight and the deployer uses it to drive Stage 4k persona provisioning without re-parsing §9. Auto-populated during Stage 11 emission from §9.1 — not elicited.
- **`module_kind`** — informational label (`starter` / `master` / `domain` / etc.). NOT a behavior switch — the deployer's logic is `module_kind`-agnostic. A `starter` is just a module that passes the self-containment audit (every entity carries its full inherited lifecycle; required FKs are presence-conditional). The label is for human catalog browsing.

### Mode handling

- **Greenfield**: §5.3 and §6 (all four sub-sections) are **kept (headings present) with the canonical `_(none: <short reason>)_` placeholder** unless the user explicitly requested cross-scope edges or cross-domain handoffs. No bare empty headings, no free-text stubs — every canonical heading is present and either populated or placeholdered.
- **Catalog-clone**: inherit §5.3 and §6 from the source blueprint. Let the user trim or extend during the customize conversation. After trim: any sub-section that ends up empty **keeps its heading and carries the `_(none: <short reason>)_` placeholder** — never omit the heading.
- **Customize**: load the source blueprint, present its §1 + §3 table to the user, ask what to change; the rest of the file is preserved unless the change requires it. Apply the same keep-with-placeholder rule after any trim.
- **`## Additional Requirements Specification` (all modes)**: OPTIONAL and omit-when-unused. Greenfield authors it only when a non-derivable requirement exists; catalog-clone and customize **preserve and adjust** it like any inherited section, never silently drop it. It is not a canonical section, so its absence is never a placeholder case and is never flagged.

**Empty-section convention (the single rule).** Every canonical top-level / numbered section (and the §5.3 / §6 sub-blocks) is **always present**. When a section is intentionally empty, keep its heading and write the canonical placeholder **`_(none: <short reason>)_`** (lowercase `none`, a **colon** not an em-dash; bare `_(none)_` is allowed when a reason adds nothing) in place of its table or rows. **Omitting a canonical section is forbidden**, **bare empty headings are forbidden**, and **free-text stubs** like *"no cross-scope edges declared"*, *"no cross-domain context"*, or *"no industry-scoped aliases"* are forbidden. The architect's pre-save verification rejects a **missing** canonical section (and a non-canonical free-text stub), and **accepts** the `_(none: …)_` placeholder. The only omit-when-empty exception is the §3 per-entity sub-blocks (Computed fields / Validation rules / Input-type rules / Select rule), which are field-level and not authored at blueprint stage.

**Mode detection by `naming_mode`:** Greenfield blueprints carry `naming_mode: template:<vendor>` or `naming_mode: agent-optimized` in the frontmatter. Catalog-clone blueprints don't carry `naming_mode` at all. This is the canonical signal — also drives the frontmatter rule that greenfield files don't carry `related_modules` / `departments` / `industries`, and catalog-clone files don't carry `naming_mode`.
