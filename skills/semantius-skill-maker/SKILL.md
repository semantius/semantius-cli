---
name: semantius-skill-maker
description: >-
  Generate ONE consolidated, domain-specific Agent Skill (agentskills.io
  format, usable by Claude Code and any other agent harness that loads
  Agent Skills) from a Semantius semantic-model file
  (`*-semantic-model.md`). The output packages the model's domain
  glossary, jobs-to-be-done, enum lifecycles, FK shapes, label
  composition rules, and guardrails into a single SKILL.md so a calling
  agent can use that specific Semantius model efficiently, without
  re-deriving the schema or loading the source model file at runtime.
  Use when the user wants "a skill for the CRM model", "wrap the
  workforce model in a skill", "generate a domain skill from this
  semantic model", or any phrasing that asks for a model-specific skill
  on top of an existing `*-semantic-model.md` file. Also trigger when
  the user wants to rebuild, reanalyze, re-author, or holistically
  regenerate an existing generated skill against the current model
  (e.g. "rebuild the `<slug>` skill from scratch", "the model has
  drifted, regenerate everything", "throw out the existing skill folder
  and start over"). The generated SKILL.md delegates platform mechanics
  (CLI install, PostgREST encoding, cube DSL) to `use-semantius`, which
  is expected to load alongside.
---

# semantius-skill-maker

Turn a semantic-model markdown file (the artifact produced by
`semantic-model-analyst`) into **one** task-aware Agent Skill that
captures the domain knowledge needed to act on that model efficiently.
The generated skill does not duplicate `use-semantius`, it sits on top
of it, focusing exclusively on the domain (entities, lifecycles, label
rules, cross-FK invariants) that a generic platform skill cannot know.

The generated skill is plain Agent Skills format, a `SKILL.md` with
YAML frontmatter under a folder named after the model, and works in
any agent harness that loads Agent Skills, including Claude Code.

## Writing conventions (apply to every file and message this skill produces)

These rules apply to chat output, the generated SKILL.md, the generated README.mdx, every reference file, and every script this skill writes.

**1. US English spellings, always.** Never British English. Examples (left = correct US form, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), uncategorized (not `uncategorised`), normalize (not `normalise`), harmonize (not `harmonise`), analyze (not `analyse`). When in doubt between two spellings, pick the `-ize` / `-or` / `-er` form.

**2. No em-dashes (`—`, U+2014).** Banned everywhere this skill writes: SKILL.md, README.mdx, semantic-model citations, references, scripts, and chat output. **This propagates.** LLMs mirror the style of their context, so an em-dash inside generator prose causes generated skills to emit em-dashes too. Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.` or `X; Y`; `A — B — C` triplet → split into two sentences. The en-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is on `—` used as punctuation. Before writing any file, literal-search for `—` and convert each instance.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?". Use the form that agrees with the singular implicit subject.

**4. README.mdx catalog-description rules.** The README.mdx this skill generates is rendered side-by-side with other skills in a catalog gallery. These are hard constraints for catalog readability:

- **Front-matter `description`**: one sentence, ≤140 characters, unique value-prop for *this* skill. **Never** starts with "This skill" and **never** contains the substring "this skill". Do not just restate the domain. **Shape: verb-led, names actual capabilities** (e.g. "Manages the recruiting funnel from requisition through application, interview, offer, and hire."). Do **not** use the "[verb] [object] so [outcome]" shape; the "so..." clause reads as trigger-fodder, not a capability list.
- **Front-matter `title` and the `#` heading**: must always contain the word "Skill", and must read as natural English. If the source `system_name` ends in "System" (e.g. "Applicant Tracking System"), drop "System" and append "Skill" → "Applicant Tracking Skill". Otherwise append "Skill" directly: "Workforce Planning Skill", "Product Roadmap Skill", "Customer Relations Skill".
- **Body, immediately after heading**: repeat the *model's* domain description verbatim (or near-verbatim), pulled from the model file's `domain` front-matter or §1 narrative. The body describes the SYSTEM, not the skill. The skill's unique angle lives only in the front-matter `description`.
- **No `generated_from` key** in README front-matter.
- Validate before declaring done: literal-search for "this skill" (must be zero hits) and `—` (must be zero hits), and check the heading contains "Skill".

**5. Semantius entity-label symmetry (when the generated SKILL.md cites entity labels).** `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products`. The skill-maker reads these from the source model file; if the source has an asymmetric pair, treat the source as buggy and ask the user to fix the model via the analyst before re-running the skill-maker (do not paper over it in generated output).

---

## Schema compatibility: `EXPECTED_MAJOR = 3`

This skill expects model files written by `semantic-model-analyst` major `3`. The model file's front-matter `version: "MAJOR.MINOR"` is checked at the start of Step 2. **Major must equal `EXPECTED_MAJOR`**, minor is informational and not compared. Files with a different major are rejected; the resulting per-domain skill would bake in stale recipes. Three cases:

- **Older major**, the file was written using a structure this skill no longer understands (different section numbering, different table shapes, missing fields). Tell the user to run `semantic-model-analyst`; its archived-knowledge mode reads the older file and re-authors a current-major file from the same semantic content. Re-run skill-maker against the new file.
- **Newer major**, the file was written by a newer analyst than this skill knows. Tell the user to update `semantius-skill-maker` before retrying.
- **Missing `version` key** (legacy, pre-versioning), treat as major `0`; same response as older-major.

When the analyst's major bumps, this skill's `EXPECTED_MAJOR` must be bumped in lock-step (same commit when feasible). The trio of analyst, deployer, and skill-maker share the major.

The history of the skill-maker's contract changes lives in [`CHANGELOG.md`](./CHANGELOG.md) — what each analyst-lockstep bump changed in the parser, indices, generated-skill preambles, and self-review principles. That file is not loaded at runtime; the body of this SKILL.md is the **current contract**, the CHANGELOG is the **history**.

---

## Inputs

- `MODEL_PATH`: absolute path to a `*-semantic-model.md` file with valid
  frontmatter (`system_slug`, `system_name`, `entities`, etc.) and §3
  entity definitions.

## Output

A single folder under the user's Claude skills root. Two top-level
files are always written; `references/` and `scripts/` subfolders are
written only when the JTBD classifier in Step 3 (Pass 3) puts work
there.

```
<skills-root>/<modelslug>/
├── SKILL.md          # for the calling agent: glossary, JTBD outlines, guardrails
├── README.mdx        # for humans browsing a catalog: narrative + diagram
├── references/       # optional, per-JTBD detail, loaded on demand
│   └── <jtbd-slug>.md
└── scripts/          # optional, deterministic ops, invoked not loaded
    └── <op-slug>.sh
```

`SKILL.md` is what an agent harness loads at runtime. `README.mdx` is a
human-facing catalog entry: a downstream system renders these into a
gallery so a person can browse available skills, understand each one's
purpose at a glance, and decide whether to install it. The two files
share a folder, but their audiences and formats are different, do not
collapse them, and do not skip the README.

The `references/` and `scripts/` subfolders exist to keep SKILL.md
small. SKILL.md is loaded into context *every* time the skill triggers;
a reference file is loaded only when the agent enters that specific
JTBD; a script is never loaded, the agent invokes it. A 400-line
SKILL.md plus a handful of focused 80-line reference files costs less
per trigger than a 900-line monolith, because the agent typically
engages one JTBD at a time. The classifier in Step 3 (Pass 3) decides
which JTBD belongs in which file.

`<modelslug>` is the model's `system_slug` converted to kebab-case ,
**underscores become dashes** (e.g. `customer_relations` →
`customer-relations`, `product_roadmap` → `product-roadmap`). Every
multi-word skill in Claude Code uses kebab-case (`use-semantius`,
`semantic-model-analyst`, `skill-creator`); mashing words together
(`customerrelations`) breaks the convention and makes the description
text harder to read. The folder name and the SKILL.md `name`
frontmatter match exactly.

`<skills-root>` resolution order:

1. **Project skills root**, the nearest `.claude/skills/` directory walking
   up from the model file's location, or from the current working directory.
   Prefer this if found.
2. **User skills root**, `~/.claude/skills/` (on Windows:
   `%USERPROFILE%\.claude\skills\`).

If both exist, ask the user which to use; default to the project root. If
neither exists, ask before creating one.

### Source-of-truth and the model reference

The generated SKILL.md is **self-contained at runtime** for the
cross-cutting facts (glossary, enums, recipes resolve every value
at generation time so the calling agent never needs to open the
model file to act). FK shape and audit-logging detail live with the
JTBD that uses them, not in SKILL.md, see "Where FK detail lives"
below.

The model file is still referenced, but only as **provenance metadata in
frontmatter** (`semantic_model:` key, see the template below), not as a
clickable link in the body. Two reasons:

- A body link invites the agent to fetch a 400+ line file the SKILL.md
  has already condensed. That defeats the point of generating the skill.
- Provenance still needs to live somewhere, for re-generation, audit, and
  drift detection, and frontmatter is the right place because it's
  machine-readable and the agent doesn't render it as a follow-up action.

Set `semantic_model` to the model's `system_slug` value (e.g.
`product_roadmap`), not a path. The slug is stable across machines
and re-locations of the model file; an absolute path bakes in the
generator's working directory and breaks the moment the file moves
or the skill is shared with another user. The downstream tools that
consume this provenance (re-generation, drift detection) resolve the
slug against the current `*-semantic-model.md` files in the working
directory, so the slug is sufficient.

---

## Workflow

### Step 1, Load the Semantius reference

Before writing recipes, read the `use-semantius` skill so the JTBD recipes
use the right CLI patterns:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
Read: <skills-root>/use-semantius/references/crud-tools.md
Read: <skills-root>/use-semantius/references/cube-queries.md
```

You will not run `semantius` yourself in this skill, but the recipes you
bake in must be valid CLI invocations. If `use-semantius` cannot be located,
stop and ask the user.

### Step 2, Parse the model

Read `MODEL_PATH` and **gate on the version first** before extracting anything else. Compare the file's front-matter `version` major against this skill's `EXPECTED_MAJOR` (see "Schema compatibility" near the top). Major equal → continue. Major older or missing → stop with a message naming the file's version, this skill's expected major, and the recommended fix (run the analyst's audit to migrate). Major newer → stop and ask the user to update this skill. Do not parse anything else when the gate fails; the file's structure may not match what the rest of Step 2 assumes.

Once the version gate passes, extract:

- `system_slug`, `system_name`, `domain`, and **`module_type`** (`"domain"` or `"master"`; absent → treat as `"domain"`) from frontmatter. `module_type` controls two things downstream: the generated SKILL.md's "Module type" preamble line (Step 5), and the JSON-array merge note (master-module entities' `computed_fields` / `validation_rules` entries carry an extra `source_module` reconciliation tag — see the per-entity extraction note below).
- Entity list with `singular_label`, `label_column`, fields (name, format,
  required), enum values (§5), FK relationships (§4), parent/cascade-child
  flags, `audit_log`, **`computed_fields`** array, **`validation_rules`**
  array, and (analyst v3.0+) any **`**Shared master cluster:** <name>`** annotation under the §3 entity heading. The two latter JSON blocks are platform-enforced JsonLogic — they change what the calling agent must do and what the calling agent must NOT do. See "Pass 2" merit-test adjustments below.

  When the entity belongs to a master module (`module_type: master` in frontmatter), its `computed_fields` and `validation_rules` entries may each carry a `source_module` key naming the consuming module that contributed the entry. Treat `source_module` as opaque reconciliation metadata: surface its existence in the preamble note but never use it to filter entries (every entry applies regardless of which module contributed it). Domain-module entities never carry `source_module`.

  Record the cluster annotation per-entity into a `master_cluster_by_entity` index. The annotation is informational for skill-maker: it signals that the entity is a classic master concept (vendors → `parties`, cost_centers → `finance`, etc.) and that writes to it may have cross-domain visibility. Use it to surface a "shared across domains" callout in the generated skill's preamble (Step 5) and as a guardrail on every write recipe touching the entity (Step 6).

  Treat each entry's **JsonLogic body as opaque** and read only the
  human-readable metadata (`name` and `description` for `computed_fields`;
  `code`, `message`, and `description` for `validation_rules`). All
  matching downstream, Pass 2 suppression, gap-tracking, SKILL.md
  preamble copy, JTBD failure-mode wiring, uses that metadata. The
  analyst's job is to write `description` / `message` text precise
  enough that a candidate transition or derivation can be matched
  against it by reading. If the analyst's text is too vague to match,
  that is a model defect to send back; do not try to evaluate the
  JsonLogic to recover.

  **One exception: scan each rule's JsonLogic body literally (string-match only) for the two platform-extension operators.** Both are first-class JTBD signals:

  - **`require_permission`**, i.e. `{"require_permission": "<code>"}` somewhere inside the rule body. Extract `(entity, rule_code, rule_description, permission_code)` for every match into a `conditional_permissions` index. This index drives the new "Conditional-permission gate" merit signal in Pass 2 and the `Platform-enforced permissions` SKILL.md preamble (Step 5). The match is purely literal; *which* condition gates the permission still comes from the rule's `description` text, not from interpreting the JsonLogic.
  - **`value_changed`**, i.e. `{"value_changed": "<field>"}` somewhere inside the rule body. Note `(entity, field)` pairs into a `transition_gated_fields` index. This is informational, not a merit signal on its own; it helps Pass 2 confirm that a `require_permission` rule actually fires on transition rather than on every write (a quality check that the analyst's audit also runs).

  In analyst v2.0+ files, the **§2 Permissions summary table is the canonical source** for the module's full permission catalog (not §8 step 1). Parse the table verbatim — five columns: `Permission | Type | Description | Used by | Hierarchy parent`. Build a `permissions_catalog` index from the rows. Use this index for everything: the SKILL.md "Platform-enforced permissions" preamble (one row per workflow permission), the role-hint lookup for each `conditional_permissions` entry (the `Description` and `Used by` cells give the role-hint richer than v1.11's §8 prose), and the cross-check that every `conditional_permissions[].permission_code` appears in the table. A mismatch is a model defect; refuse to generate and route back to the analyst. §8 step 1 in a v2 file is a procedural pointer to the table and no longer enumerates permissions itself; do not parse §8 for the permission list.

  **v3.0 cross-module hierarchy rows.** The `Hierarchy parent` cell may reference a permission in a *different* module (e.g. an ITSM module's `itsm:read` row carrying `Hierarchy parent: parties:read`); this is a cross-module bridge to a master module that the deployer materializes via `permission_hierarchy` rows tagged `origin = "model_master"`. Recognize these by the presence of a `<other_slug>:<suffix>` value in the cell where `<other_slug>` is not this module's `system_slug`. Record cross-module parents into a `master_inclusions` index keyed by `(this_permission, master_permission)`. The index drives a one-line note in the SKILL.md "Platform-enforced permissions" preamble: every permission with at least one cross-module parent gets a *"includes <master>:<suffix> from the `<master>` master module"* sub-note so the calling agent knows that holding it grants visibility into shared data. Same-module hierarchy rows still surface as the regular rollup chain; the index split only matters for the preamble note.

- **Inbound-FK delete-mode index).** Walk the §4 relationship table once more and build a `restrict_inbound` index per entity: for every row whose `Kind` is `reference` and `Delete` is `restrict`, record `(child_entity, fk_field)` against the *target* (the entity on the right side of the relationship). This index drives the new "Restrict-chained cleanup" merit signal in Pass 2 and is consumed by Pattern J (delete / archive of a parent entity that has restrict-children). The pattern matters because the platform refuses to delete a row that has live `reference + restrict` children; the calling agent must clean them up first, in dependency order, and a generic `use-semantius` `DELETE` will surface only a single per-row constraint failure rather than the full chain. Also note inbound `reference + cascade` and `reference + clear` rows separately; they don't trigger Pattern J but the SKILL.md preamble should still call out the cascade-delete / orphan-clear behavior for downstream awareness.

- **Read-side rule indices).** Two new optional §3 sub-blocks per entity. Build one index for each; both stay opaque on the JsonLogic body and read only the human-readable metadata.
  - **`row_visibility_rules`** — for every entity that declares a non-empty `Select rule` sub-block, record `(entity, jsonlogic_object, description?)`. `description` is the entity-level prose that explains "what the rule restricts" — if the analyst didn't write one, walk §3 prose for a sentence that names the per-row predicate (e.g. *"a note is visible to its author, or to anyone when its `visibility` field is `public`"*). Surface a defect to the user if neither the sub-block carries a `description` nor §3 prose names the scope; the SKILL.md preamble and per-JTBD guardrails need readable scope text. **Critical (v2.2): the rule applies uniformly to every caller with `view_permission`.** The platform evaluates the JsonLogic body per row with `$today` / `$now` / `$user_id` as reserved variables; there is no documented mechanism by which holding a specific permission causes the rule to be skipped for that caller. If the analyst's model contains a §7 architectural decision naming a documented broadening mechanism (Stage 12 option C separate-entity surface, option D Postgres `BYPASSRLS` role attribute), record it under `row_visibility_broadening` keyed by entity so the SKILL.md preamble can name the actual mechanism the user resolved. **Never invent a "view_all bypass" the model file does not explicitly resolve in §7.** This index drives the **Row-level read scope** SKILL.md preamble (Step 5), the **Row-level read scope** cross-cutting guardrail attached to every read recipe against a scoped entity (Step 6 / Step 7), and a new severity row in Step 9 self-review.
  - **`dynamic_input_types`** — for every `Input type rules` entry across every entity, record `(entity, field, jsonlogic_object, description?)`. The `description` field describes *when* the rule changes the field's UI mode — `"hidden until status=approved, then readonly"` is the canonical shape. Walk the JsonLogic body literally (string-match only, same posture as `require_permission` / `value_changed`) for one pattern that bears on JTBD shaping: a return value of `"required"` triggered by a sibling-field comparison (e.g. `status=approved → "required"`) flags the field as a **conditional-required side-effect** on the same transition, which co-fires with Pattern A's side-effect-fields-on-transition merit signal. Record those into a sub-index `conditional_required_fields` keyed by `(entity, trigger_field, trigger_value, dependent_field)`. This index drives the **Conditional field UI states** SKILL.md preamble (Step 5), additional side-effect-fields-on-transition coverage in Pattern A recipes (Step 6 / Step 7), and a new severity row in Step 9 self-review.

  Skip both indices entirely when the model declares no entity-level `Select rule` and no field-level `Input type rules`. v2.1 and earlier files have neither.

Compute `modelslug = system_slug.replace(/_/g, "-")`.

Refuse if §7.1 lists open blockers, the model is not finished and the
skill would bake in wrong recipes.

### Step 3, Plan jobs to be done

JTBD discovery is a two-pass process: **nominate** broadly with the
pattern catalog below, then **filter** with the merit test. The merit
test matters because every section sits in one file, slack adds noise
to every load.

#### Pass 1, Nominate with the JTBD pattern catalog

The catalog below is generic across domains, not just transactional
business models. Walk **all nine patterns** every time, regardless of
what the model "looks like" at first glance.

**Pattern A, Lifecycle transitions on status enums.**
Shape test: entity has a `*_status` enum + side-effect fields like
`approved_at`, `committed_at`, `rejected_at`, `closed_at`. Each
non-trivial transition (more than a status flip) is a candidate. Pure
status flips with no side effects collapse into the entity's primary
lifecycle JTBD.

**Sub-shape: approval / sign-off / workflow gate), broadened in v1.12).** Any
transition whose `validation_rules` entry invokes `{"require_permission":
"..."}` (look up the entity's `conditional_permissions` index from Step
2) is automatically a strong JTBD candidate. The agent calling this
skill is the one that will trip the permission check, so it needs an
explicit recipe: name the permission, name the role(s) that typically
hold it (read from §8 step 1 description), and tell the agent how to
recover from the platform's throw (surface the rule's `message`,
propose escalation paths like "ask an offer-approver to confirm" or
"defer to the user who is signed in as the approver"). This sub-shape
**does not get suppressed by the merit-test "platform-enforced" rule**,
because the platform enforces *the check* but the calling agent still
owns the *workflow* around it (the read of who-approves-what, the
confirmation prompt, the failure-message phrasing). Treat every entry
in `conditional_permissions` as one JTBD candidate (or a branch inside
the entity's primary lifecycle JTBD), even if Pattern A would otherwise
collapse the transition.

The sub-shape covers three distinct trigger fields, all flagged the
same way once `value_changed` + `require_permission` co-occur in the
rule body:

1. **Status-transition gates**: `value_changed: "status"` →
   one of `approved` / `signed` / `released` / etc. Recipe: confirm with
   the user, then PATCH `status`.
2. **Submit-then-lock gates**: `value_changed:
   "is_submitted"` (or `is_locked` / `is_final` / `is_complete`) → `true`.
   Recipe: confirm the user is the row's owner (or holds the override
   permission); compose the PATCH that flips the lock; after the flip,
   treat the row as immutable except via the override.
3. **Closure / cancellation gates**: `value_changed: "status"` →
   one of `closed` / `cancelled` / `void` / `hired` (when §3 prose names
   weight). Same recipe shape as (1).

**Sub-shape: housekeeping field appears on transition).** For each entry in the `conditional_required_fields` sub-index (built in Step 2 from `Input type rules`), the transition JTBD that fires the trigger condition must include the dependent field as a same-PATCH side-effect. Concretely: when `dynamic_input_types` says *"`offers.approved_at` hidden until status=`approved`, then readonly"*, the "approve offer" JTBD's PATCH body MUST set `approved_at = $now` in the same call as `status = "approved"` — the UI rule controls when the form renders the field, but a recipe that drives the transition through the API has no form to render and would silently leave `approved_at` empty. This is the same merit signal as the existing "Side-effect fields on transition" row (the `*_at` field that must be set in the same PATCH as the status flip), but the `input_type_rule` makes the pairing **mechanical and detectable** instead of relying on the analyst remembering to mention it in prose. Cross-reference with the entity's `validation_rules`: a paired family-5 conditional-required rule (server-side `must be non-null when status='approved'`) confirms the intent and gives the JTBD's Failure modes block the platform `code` to surface on bad writes. When the UI rule fires but no server-side family-5 rule exists, surface as a `platform_enforceable_gaps` entry of kind `validation_rule` (the UI says the field must be set; the server doesn't enforce it; the recipe enforces it client-side as a stopgap).

**Pattern B, Polymorphic action / event staging.**
Shape test: entity named `*_actions`, `*_events`, `*_transactions`,
`*_movements`, with a polymorphic `*_type` enum that fans out
behavior. Nominate **one** JTBD with branches per type value, do not
split per enum value (that produces overlapping recipes).

**Pattern C, Materialization / handoff.**
Shape test: entity exists so another entity can be created from it;
look for `originated_from_*_id` back-pointers, or "approved → real"
flows where a staging row spawns rows in a different table. These are
the highest-value candidates because they touch multiple tables and
are the most error-prone for a calling agent to derive from the schema
alone.

**Pattern D, Hierarchy operations.**
Shape test: self-referencing FK like `parent_*_id`, `manager_*_id`,
`backfill_for_*_id`; tree-shaped data. Candidates: reparent without
orphaning, roll-up, cycle prevention. Skip if the self-FK is purely
informational ("previous version of this row") with no operation that
restructures the tree.

**Pattern E, Ownership / sharing.**
Shape test: `owner_*_id` field, sharing tables. Candidates: transfer
ownership of X, share X with, revoke access to X. (Multi-tenant
scoping is not a Semantius concern: each customer organization runs
its own Semantius deployment against its own database, so a single
instance never holds rows for two different tenants.)

**Sub-shape: owner-or-manager edit gate).** Entity
carries a `created_by` / `author_id` / `owner_id` / `assignee_id`
field AND its `conditional_permissions` index includes a rule that
references the owner field against `$user_id` plus an elevated
`<slug>:manage_all_<plural>` permission. The agent calling this skill
is often *not* the original owner (it acts on behalf of users who may
be different from the record's creator), so the recipe must surface:
"editing this record requires that the caller is the original
`<owner_field>` OR holds `<slug>:manage_all_<plural>`; if neither
holds, the platform will reject with `<rule.code>: <rule.message>`,
propose handing off to the original owner or to a user who holds the
override permission." Treat as a JTBD candidate even when no other
Pattern-E shape fires.

**Pattern F, Publication / versioning.**
Shape test: `draft`/`published` states distinct from approval; version
chains (`*_version`, `previous_version_id`); `published_at` separate
from `created_at`. Candidates: publish X, unpublish X, create new
version of X. Distinct from Pattern A approval, publication is about
distribution, not sign-off, and the side effects differ (cache
invalidation, notification, visibility scope).

**Pattern G, External-system handoff.**
Shape test: fields like `external_*_url`, `*_external_id`,
`webhook_*` entities, or a status value such as `synced` / `failed`.
Candidates: sync X to external, replay failed X, reconcile X.

**Pattern H, Bulk ingest.**
Shape test: model declares webhook receivers explicitly, or has an
entity whose typical population unit is a batch (a CSV-shaped table
with no parent beyond the batch). See "pattern-level adjustments"
below, in this skill, bulk ingest usually becomes a one-line pointer
rather than a JTBD.

**Pattern I, Cross-entity reporting.**
Shape test: 3+ entities joined by FKs and at least one numeric measure
(cost, count, duration, FTE, amount). See "pattern-level adjustments"
below, in this skill, reporting becomes a `## Common queries`
appendix, not a JTBD section.

**Pattern J, Restrict-chained cleanup).**
Shape test: an entity that appears as the *target* of at least one
inbound `reference + restrict` FK from another entity in the model
(read the `restrict_inbound` index from Step 2). The platform refuses
to delete a row that has live restrict-children; the calling agent
needs an explicit cleanup recipe naming each restrict-child entity
in dependency order, with a per-child query shape ("find all
`<child>` where `<fk_field> = <parent_id>`") and a delete loop
before the parent delete itself. This pattern is the v1.13
parent-vs-reference rule's direct downstream consequence: when the
analyst flips a `parent (cascade)` FK to `reference (restrict)`
because the child has divergent permission scope, the analyst is
*deliberately* moving the cleanup decision into the application
layer rather than letting the platform silently cascade-delete
permission-scoped rows. The skill-maker materialises that decision
as a recipe. Candidates: "delete `<parent>`", "archive
`<parent>`", "merge two `<parent>` records" (where merge ends with
a delete of one). Skip when the entity has zero inbound
restrict-FKs (the platform's own `DELETE` is enough) or when the
restrict-children themselves carry no permission-scope divergence
(then the analyst's choice of `restrict` was overly cautious; flag
to the user but still emit the recipe).

##### Skip rules

Do **not** nominate any of the following, they fall outside the
"job to be done" frame:

- **Single-row CRUD on master-data tables** with no lifecycle (insert
  one department, edit a job code). The calling agent uses
  `use-semantius` directly; an extra section is just noise.
- **Seed / sample / test-data population.** One-off developer work,
  not a recurring job. If the user wants a seed script, ask separately.
- **Entities listed in §7.2 "Future considerations"**, they don't
  exist yet.
- **Pure read-by-id lookups**, the calling agent uses
  `postgrestRequest` directly.

##### When none of the patterns fire

If a model has shapes none of the patterns recognize (rare, but
possible for unusual domains), name the unmatched shape explicitly in
the Pass-2 confirmation step and ask the user whether it warrants a
custom JTBD. Do not invent a job to fill space.

##### Pattern-level adjustments specific to this skill

- **Pattern I (cross-entity reporting) does not become a JTBD section
  here.** Promote it instead to a `## Common queries` appendix at the
  end of the SKILL.md, 3–5 pre-shaped cube queries the calling agent
  can adapt. Reporting is largely `use-semantius` territory once the
  schema is known; baking in *example queries* is useful, but framing
  it as a "job" misleads the calling agent into routing every analytic
  question through this skill.
- **Pattern H (bulk ingest) becomes a one-line pointer**, not a recipe,
  unless the model declares webhook receivers explicitly. If it does,
  write a JTBD; otherwise the SKILL.md just notes "for CSV import, see
  `use-semantius` `references/webhook-import.md`".

#### Pass 2, Apply the merit test (earn-its-place filter)

For each candidate from Pass 1, ask: *would the calling agent get this
right with `use-semantius` alone?* If yes, drop the candidate, an extra
section is just noise, the calling agent should call `use-semantius`
directly. A candidate **earns** a section only if it answers YES to ≥1
of the following:

| Merit signal | What to check in the model |
|---|---|
| **Caller-populated label** | Junction or sub-entity has a required `*_label` column distinct from any `label_column`, with no DB-level default. The recipe must compose the label client-side, not obvious from the schema alone. |
| **Computed field** | A stored derived field (e.g. `rice_score`, `total_amount`, `days_open`) whose value depends on sibling fields. Match by exact `name` against the entity's `computed_fields[].name` array, then resolve to one of three cases. **(a) Field is in `computed_fields`** → signal is **suppressed; does NOT earn a section on its own**. The platform overwrites caller payloads on every write, so the calling agent must not include the derived field in any POST/PATCH body and must not recompute it client-side. That rule is documented globally in the SKILL.md `Platform-derived fields` preamble (resolved at generation time); no per-JTBD recipe is needed. A candidate whose only merit signal is this row, in case (a), is dropped and listed under skipped. **(b) §3 prose names a derivation but no matching `computed_fields[].name` entry exists** → gap-tracked (record under `platform_enforceable_gaps`; see below). The signal earns a section ONLY when the candidate also passes one of the other merit signals (cascade, side-effect, junction without uniqueness, etc.); the recipe enforces the derivation client-side as a stopgap until the analyst adds the rule to the model. **(c) Neither field-name match nor §3 prose names a derivation** → signal does not fire. |
| **DB-unguarded lifecycle gate** | Status enum where some transitions are valid and others aren't, but the DB accepts any value. Suppression here is **per-transition, matched by `description` / `message` text**, not per-block: walk the entity's `validation_rules[]` and ask "does any entry's `description` or `message` text name *this specific transition*, or the invariant it gates?" Then resolve. **(a) A `validation_rules[]` entry covers the transition** → signal is **suppressed for that transition; does NOT earn a section on its own**. The platform rejects the bad write with `{ "errors": [{ "code", "message" }, ...] }`; the recipe just surfaces that. The `code` is documented globally in the SKILL.md `Platform-enforced invariants` preamble; no per-JTBD recipe is needed for the gate. A candidate whose only merit is this row, in case (a), is dropped and listed under skipped. (Scripts that exist for *other* merit reasons may name the platform `code` in their stderr diagnostics so the agent surfaces a clean recovery hint; they must not duplicate the JsonLogic check.) **(b) §3 prose names the invariant but no matching `validation_rules[]` description does** → gap-tracked. The signal earns a section ONLY when the candidate also passes another merit signal (cascade, side-effect, etc.); the recipe enforces the gate client-side as a stopgap. **(c) Neither prose nor `validation_rules` names the invariant** → signal does not fire. |
| **DB-unguarded invariant across FKs** | E.g. `features.release_id` and `features.product_id` must agree on product. The recipe must read both rows and check before patching. Cross-row constraints are out of scope for `validation_rules` (entity-level only), so this signal is **not** suppressed by the platform. |
| **Cascade flow** | Flipping one parent row should flip a filtered set of children in the same logical operation (e.g. release-shipped → its planned/in-progress features → shipped). |
| **Junction without uniqueness** | M:N junction without a DB-level unique constraint on the natural key. The recipe must dedupe-before-insert. |
| **Materialization / handoff** | One entity row spawns rows in a different table (Pattern C). The order, FK back-pointers, and source-status flip are easy to get wrong. |
| **Side-effect fields on transition** | `approved_at`, `committed_at`, `actual_release_date`, etc. that must be set in the same PATCH as the status flip, easy to forget. |
| **Audit-trail read** | Audit-logged entity (`audit_log: true`) where "who/when changed X" is a likely user question. Worth a short recipe even though writes need no special handling. |
| **Conditional-permission gate** | The entity's `conditional_permissions` index from Step 2 carries one or more entries (i.e. at least one `validation_rules` rule invokes `{"require_permission": "<code>"}`). Unlike the basic "DB-unguarded lifecycle gate" row, this signal is **never suppressed** by the platform-enforces-it rule, the platform enforces the *check* but the calling agent still owns the *workflow*: detecting that the caller lacks the permission before the write attempt (cheap UX win), surfacing the rule's `message` cleanly on the throw, and proposing the right escalation path (which role typically holds the permission, who to hand off to). One JTBD per `(entity, permission_code)` pair, or one combined JTBD per entity when several conditional gates share the same approver role. Cross-reference the §8 step 1 description for the permission to know what role typically holds it. |
| **Restrict-chained cleanup** | The entity appears in at least one other entity's `restrict_inbound` index (i.e. is the target of at least one `reference + restrict` inbound FK). Pattern J fires. The recipe walks the dependency tree of restrict-children, naming each one and providing the find-and-delete query shape, then performs the parent delete. The merit signal is the chain itself: a generic `use-semantius` `DELETE` against the parent will surface only one row's constraint failure per attempt, never the full chain; the recipe makes the order explicit. |
| **Row-scoped read** | The entity appears in the `row_visibility_rules` index from Step 2 (i.e. carries a non-empty `Select rule`). Like the conditional-permission gate above, this signal is **never suppressed** — the platform filters rows from the result set, but the calling agent still owns the workflow of surfacing the limit to the user. **Critical (v2.2): the rule applies uniformly to every caller with `view_permission`.** A read recipe against a scoped entity must surface that as a uniform limit ("every caller sees only `<predicate>`"), not as a tiered limit. If the analyst's model has resolved an architectural-decision §7 entry that names a documented broadening mechanism (option C separate-entity surface, option D Postgres `BYPASSRLS` role), the recipe can name it as the path to broader access; otherwise the broader-access path is "talk to a user with that role" and the recipe says so. **Never invent a `view_all_<plural>` permission bypass.** The signal earns a section when the entity is a target of meaningful read recipes (list, search, look up by non-id) — those recipes need a preamble noting the scope. Pure write recipes on the entity (insert, update with the id already known) are not affected and don't need a separate JTBD; the cross-cutting **Row-level read scope** preamble in the SKILL.md body covers them. Entities whose only operations against them are writes-by-known-id get the preamble entry but no per-JTBD section. |
| **Conditional field UI state** | The entity has at least one field in the `dynamic_input_types` index. By itself, this is **not** a merit signal that earns a section: an `input_type_rule` is UI control only, the platform doesn't gate writes on it, and recipes that POST/PATCH bypass the UI entirely. The exception is the `conditional_required_fields` sub-index (UI rules that go `default → required` on a transition): those compose with Pattern A's existing "Side-effect fields on transition" signal and the housekeeping-field-appears-on-transition sub-shape above, and earn coverage *inside* the transition JTBD that fires the trigger. Cross-cutting documentation of every `input_type_rule` lives in the **Conditional field UI states** SKILL.md preamble (Step 5), not in per-JTBD sections — same posture as **Platform-derived fields**. |

> **Trap, the most common defect:** when a candidate's only merit
> signal is **Computed field** and the field is in `computed_fields`,
> OR only **DB-unguarded lifecycle gate** and a `validation_rules[]`
> entry covers the transition (matched by description), the candidate
> is **dropped**, not earned. The platform owns the rule end-to-end;
> a JTBD section would just restate what the SKILL.md preamble already
> documents globally. List under skipped with a reason like
> `pure CRUD; <field> is platform-derived` or
> `pure CRUD; transition is platform-enforced via <code>`. The "Score
> with RICE" anti-pattern is the canonical example: every input has a
> `validation_rules` range check and `rice_score` is in
> `computed_fields`, so the recipe is one PATCH and the platform
> handles the rest, no JTBD section earns a place.

If the only thing a candidate does is single-table CRUD with the platform
defaults (no merit signals), drop it. List dropped candidates in the Step
4 summary as `skipped: pure CRUD against <table>, calling agent uses
use-semantius directly`. This is not a failure; it is the design.

##### Track platform-enforceable gaps

While walking the merit table, maintain a side list `platform_enforceable_gaps`
keyed by entity. Append an entry whenever the **Computed field** or
**DB-unguarded lifecycle gate** signal fires **and** the entity's model
block does not already capture the rule:

- **Computed-field gap.** A field's §3 prose names a derivation
  (`(reach × impact × confidence) / effort`, "subtotal of line amounts",
  "days between open_date and close_date") and the entity's
  `computed_fields` array carries no entry whose `name` matches that
  field. Record `{entity, field, kind: "computed_field", evidence:
  "<the §3 prose snippet>"}`.
- **Lifecycle-gate gap.** The §3 prose for a status enum (or any
  field-level invariant) names a constraint ("only set X once Y is
  committed", "X cannot decrease", "X required when Y is `paid`")
  and no `validation_rules` entry on the entity encodes it. Record
  `{entity, field, kind: "validation_rule", evidence: "<the §3 prose
  snippet>"}`.

The detection is **conservative**: only fire when the §3 prose names the
derivation or constraint explicitly. Do not infer rules the analyst did
not write down — that is the analyst's job, not the skill-maker's.

A gap by itself does **not** earn a JTBD section. A candidate still has
to pass the merit test on at least one *other* signal (cascade,
side-effect on transition, junction without uniqueness, materialization
handoff, caller-populated label, etc.). When it does, the gap-tracked
rule earns a stopgap recipe inside that JTBD until the analyst adds the
matching `computed_fields` / `validation_rules` entry to the model. The
gaps list itself is purely the Step 3 confirmation checkpoint, so the
human can decide whether to pause and add the rule via the analyst
skill, or accept the stopgap recipe.

#### Pass 3, Classify each surviving JTBD into a file

For each JTBD that passed the merit test, decide where its body lives.
The default is **reference**. Inline and script are exceptions earned
by specific shape.

**Inline (kept in SKILL.md body).** Reserve for JTBDs whose entire
recipe is one POST or PATCH with no read-first, no client-side
composition, no branching. Rare; most JTBDs that earned a merit signal
have at least one of these. If the inline body would exceed ~5 lines
of recipe, promote to reference.

**Script (`scripts/<op-slug>.sh`).** The decision rule for "script vs
reference" is **one** test, not a checklist:

> Does any branch in this recipe require the **agent** to ask the
> **user** something before continuing?

If no, it's a script. The script reads its parents, composes any
labels internally, recomputes any stored values internally, validates
preconditions, and either succeeds (exit 0) or refuses with a
diagnostic message and non-zero exit. The agent invokes it with a
small set of arguments (titles, emails, codes, dates) and checks the
exit code; the script body never loads into context.

What is *not* a judgment branch (these all stay in scripts):

- Label composition. `feature_vote_label = "{user_full_name} -> {feature_title}"`
  is mechanical: read the parents, format the string, no agent
  involvement. The script reads the rows it composes from.
- Computed values. `rice_score = (reach * impact * confidence) / effort`
  is mechanical: read current values, overlay caller's deltas,
  arithmetic, PATCH the result. Round to the column scale; if the
  inputs make the result undefined (effort null/zero), set the
  computed field to null and exit 0 with a diagnostic, do not exit
  non-zero.
- Mechanical preconditions ("refuse if release_status is `released`
  or `cancelled`", "refuse if effort_score is null"). The script
  checks, exits 1 with a clear message, and the agent surfaces the
  message to the user. That is *not* the agent asking the user
  something; that is the script telling the agent it cannot proceed.
- Dedupe-on-junction. "PATCH if the row exists, POST if not" is a
  fixed branch on what the read returned; the agent does not
  intervene.

What *is* a judgment branch (these belong in references):

- "Ask the user before rewriting a committed row's history."
- "Ask the user before charging this work to an inactive cost
  center."
- "Ask the user whether to abort or recreate when the parent was
  deleted."

Anything that needs a yes/no from the user **mid-operation** is a
reference. Everything else is a script.

The script must also satisfy two structural requirements that follow
from being callable by the agent:

- Idempotent: re-running with the same inputs is safe. Filter writes
  to "rows that still need the change", not "all rows in the parent
  set"; running twice is then a deterministic no-op on the second
  run.
- Failure messages are diagnostic: name the step that failed and
  what the agent should tell the user (e.g. "step 1: feature
  '<title>' not found, ask the user for the correct title"), so the
  agent can recover or escalate without re-reading the script body.

**Reference (`references/<jtbd-slug>.md`).** Use this when the recipe
has a judgment branch that needs the agent to mediate a user
confirmation (the test above). The reference file owns the
read-first calls, the branching prose, the user-prompt phrasing, and
the long failure-mode discussion. The agent loads the reference only
when it enters the JTBD; reading it is part of the operation.

A JTBD's classification controls the SKILL.md template body for that
section: inline carries the full recipe; reference and script carry
only Triggers, Inputs, a one-line Recipe pointer, Validation, and a
terse Failure-modes summary, with the long body living in the linked
file. The classification belongs in the Step 10 summary so the user
can sanity-check it.

**Pass 3 is mandatory. "Inline" is a rare exception, not a default.**
Every merit signal that earned a JTBD a section in Pass 2
(caller-populated label, computed field, DB-unguarded lifecycle gate,
cascade flow, junction without uniqueness, materialization handoff,
side-effect fields on transition) is *also* a reason the JTBD belongs
in `references/` rather than inline. If you find yourself classifying
every surviving JTBD as inline, you have not classified, you have
skipped Pass 3. Re-read the merit table: each signal's recipe needs
read-first, branch, compose, recompute, or cascade logic that runs to
~30+ lines including comments. None of that fits the inline criterion
(≤5 lines, no branching, no composition).

Concrete shape of a healthy classification, derived from prior
generations applied with the sharpened "user-prompt branch" rule:

- A skill with 5–10 JTBDs typically produces 3–5 reference files,
  3–5 script files, and 0–2 inline JTBDs. A run that produces zero
  reference files is suspicious (most domains have at least one
  user-confirmation branch); a run that produces zero script files
  is almost always a misclassification (most domains have at least
  one cascade or pure-mechanical operation).
- The ratio of reference + script to inline should be at least 3:1.
  If your classification gives you 7 inline + 1 reference, walk back
  through the merit table and force yourself to name, for each inline
  JTBD, why it has *zero* of: read-first, label composition, computed
  recompute, cascade, branching. If you cannot, the JTBD is at least
  a reference, possibly a script.
- Cascade-shaped JTBDs (Pattern A side effects + Pattern C
  materialization, e.g. "ship the release" with a feature-status
  sweep) are scripts, unless they carry a user-confirmation branch.
- Dedupe-on-junction JTBDs (Pattern junction-without-uniqueness, e.g.
  "vote on a feature", "tag a feature") are scripts. The label
  composition is mechanical and the script reads the parents to
  compose; do not promote to reference just because the label is
  caller-populated.
- Computed-field recompute JTBDs (e.g. "score with RICE",
  "recalculate total amount") are scripts. The arithmetic is
  mechanical; the script reads current values and writes the new
  ones in one PATCH.
- Lifecycle-gate JTBDs (Pattern A, e.g. "triage", "schedule",
  "approve") are references when at least one transition needs a
  user confirmation, scripts otherwise.

#### Sizing

After filtering, aim for **5–10 sections** plus the optional `Common
queries` appendix.

- Fewer than 5 sections after filtering: the model may be too thin to
  justify a domain skill. Tell the user; ask whether to ship it anyway
  or extend `use-semantius` with a glossary file instead.
- More than ~10 sections after filtering: a single skill that long
  under-triggers, the description gets diluted and the matcher loses
  signal. Run Step 3.5 (Cluster check) below; it inspects the entity
  graph for natural cut points and proposes a split when one exists.
  If no clean split surfaces, push back to the user: drop the
  lower-merit candidates, or split the model file itself. Proceed
  with one oversized skill only if the user confirms.

### Step 3.5, Cluster check

After Pass 3 classifies every JTBD, before presenting the
confirmation checkpoint, inspect the model for natural sub-domain
cuts. Most models generate cleanly as one skill; a minority
(typically ITIL-shaped or multi-process domains) read as two or
three loosely coupled sub-domains stitched into one model file.
A skill that spans loose sub-domains under-triggers for the same
reason an oversized skill does, the description has to cover too
many vocabularies and the matcher loses signal.

Run this step on **every** generation, regardless of JTBD count.
The size-based threshold in Sizing is one trigger for splitting,
not the only one; a 7-JTBD model split into two clear clusters
of 4 and 3 still benefits from being two skills.

#### Compute the cluster signal

1. **Build an undirected graph.** Nodes are the model's entities
   (§3). Edges are FK relationships from §4, weighted by count
   (multi-FK pairs get higher weight). Skip edges to ubiquitous
   hub entities, `users`, `departments`, and any §6 cross-model
   targets, they connect to almost everything and obscure the
   real clustering.
2. **Find candidate clusters.** A simple greedy modularity walk
   is enough; you do not need a full community-detection library
   here. Start with each entity in its own cluster and merge the
   pair whose merger most improves the within/cross edge ratio
   until further merges stop improving it. Aim for 2–4 clusters;
   stop merging when only one cluster remains or when the next
   merge would drop the ratio.
3. **Assign each JTBD to a cluster.** A JTBD lives in the cluster
   that owns the majority of its touched entities (parents,
   children, joined targets in lookups). JTBDs that span clusters
   (e.g. one that joins entities from both) count as cross-cluster
   and are flagged separately.
4. **Compute the cut score.** `cross_edges / (within_edges +
   cross_edges)`. Lower is better, a model with two genuine
   sub-domains scores < 0.20; a tightly interlocked single-domain
   model scores > 0.40.

#### Surface a split proposal only when all of these hold

- ≥ 2 clusters with ≥ 3 JTBDs each. (Smaller clusters are not
  skill-shaped; fold them into the larger neighbor.)
- Cut score < 0.25.
- ≤ 2 cross-cluster JTBDs. More than that means the recipes
  routinely span both halves and splitting forces the calling
  agent to load both skills anyway, defeating the point.
- Each cluster has its own distinct trigger vocabulary (the
  cluster's JTBD verb-phrases would not naturally appear in the
  other cluster's description). If the same verbs (`approve`,
  `assign`, `close`) dominate both clusters, the matcher will
  thrash even with a split.

If any condition fails, the model generates as one skill and
Step 3.5 produces no extra prompt.

#### When all conditions hold, propose the split

Add this to the Step 3 confirmation checkpoint as a fourth list,
**before** writing files. Example shape:

> The entity graph splits cleanly into two clusters:
>
> **Cluster A: `<slug>-incidents`** (entities: incidents,
> incident_comments, incident_categories; JTBDs: log incident,
> resolve incident, link to problem, post comment).
>
> **Cluster B: `<slug>-changes`** (entities: changes, change_tasks,
> change_approvals; JTBDs: submit change, approve change, schedule
> change, execute change).
>
> Cross-cluster: 1 JTBD (problem-resolved-by-change) would need
> both skills loaded.
>
> Cut score: 0.12. Each half has its own trigger vocabulary
> ("incident / ticket / outage" vs "change / deployment /
> maintenance window").
>
> **Generate as one skill `<slug>` (default), or split into
> `<slug>-incidents` and `<slug>-changes`?**

The default is **one skill** even when the proposal fires.
Splitting fragments shared cross-cutting rules, doubles the
README/glossary maintenance burden, and surprises users who
installed "the X skill" and find half their work routes
elsewhere. Only split when the user explicitly confirms.

#### What changes when the user accepts a split

- Each cluster becomes its own folder under `<skills-root>/`,
  with its own SKILL.md, README.mdx, references/, and scripts/.
- Each SKILL.md's description mentions the sibling skill ("loads
  alongside `<sibling-slug>` for cross-process work like X")
  so the matcher knows the pair composes.
- Cross-cluster JTBDs go in **whichever cluster owns the action's
  primary verb**, not duplicated. If "resolve a problem with a
  change" lives in `<slug>-problems` (because the verb is
  "resolve"), `<slug>-changes` only needs a one-line note that
  problem-resolution writes to changes; the recipe lives in the
  problems skill.
- The `semantic_model:` provenance key on every generated SKILL.md
  still points to the same source slug (e.g. `itsm`); the model
  file is shared, the skills are split.

#### Confirmation checkpoint

Present three lists to the user (four when Step 3.5 fired a split
proposal; five when `platform_enforceable_gaps` is non-empty):

1. **Sections**, the JTBDs that earned a place (one bullet each, with
   the merit signals that justified them).
2. **Common queries**, the cube queries that go in the appendix.
3. **Skipped**, Pass-1 candidates that failed the merit test, with the
   reason. The user may disagree and ask to add some back.
4. **Split proposal** (only when Step 3.5's conditions all held),
   the cluster breakdown and the one-skill-vs-split question. Default
   to one skill; only split when the user explicitly confirms.
5. **⚠️ Platform-enforceable gaps detected** (only when
   `platform_enforceable_gaps` is non-empty), one bullet per gap
   listing the entity, the field, the kind (`computed_field` or
   `validation_rule`), and a short quote of the §3 prose evidence.
   Frame as a question, not a command:

   > The model documents these rules in §3 prose, but the entity's
   > `computed_fields` / `validation_rules` blocks do not encode them.
   > A recipe-level stopgap will be baked into the generated skill,
   > but the platform will not enforce the rule on writes that bypass
   > the skill (direct CLI calls, other skills, future migrations).
   >
   > - **`features.rice_score`** (computed_field): §3 says
   >   *"(reach × impact × confidence) / effort"*. No
   >   `computed_fields` entry derives `rice_score`.
   > - **`features.release_id`** (validation_rule): §3 says
   >   *"null until scheduled, …commitment is derived (status ∈
   >   {planned, in_progress, shipped} ⇒ committed)"*. No
   >   `validation_rules` entry gates `release_id` against status.
   >
   > **Recommended:** pause this skill-maker run, route to the
   > `semantic-model-analyst` skill (Audit / Extend mode) to add the
   > matching `computed_fields` / `validation_rules` blocks, redeploy
   > via `semantic-model-deployer`, then re-run skill-maker. The
   > regenerated skill will surface the platform-derived fields and
   > error codes instead of baking client-side recipes for them.
   >
   > **Or:** proceed and accept the stopgap recipes. Pick a route.

   Default is to surface the gap and let the user decide; do not
   silently proceed past the checkpoint when this list is non-empty.
   If the user picks "proceed", the run continues to Step 4 with
   the JTBDs intact; if they pick "pause", stop the run and tell
   them which skill to invoke next.

Wait for confirmation before writing files. This is the only human
checkpoint.

### Step 4, Audit existing artifacts

If `<skills-root>/<modelslug>/` already exists from a prior generation,
read every file under it and check for **drift** against (1) the
current source model, (2) the current generation's plan, and (3) the
current platform conventions. The audit is **read-only**; nothing is
rewritten in this step. Findings go into the Step 10 summary, and the
user decides whether to regenerate flagged files in Step 5–7.

Skip this step entirely on a fresh generation (target folder does not
exist or contains only a stale `SKILL.md` with no `references/` or
`scripts/`). On a fresh run, there is nothing to audit; everything
gets written in Steps 5–8.

#### Model drift is the first thing to check

The generated skill is a frozen snapshot of the source model at
generation time. The model can move between generations, an analyst
can rename a `singular_label`, swap an enum value, add a
`computed_field`, simplify the §1 narrative, redraw the mermaid
diagram, or close out a §7.2 future-consideration. Any of those
changes leaves baked content stale. Detect drift **before** running
the artifact-shape checks below; a stale glossary or recipe is
worse than a non-canonical script.

The audit re-parses the source model file at `MODEL_PATH` (same
parse Step 2 does) and diffs the resulting facts against what is
baked into the generated files:

- **README `## Semantic model` mermaid block**: byte-diff against
  the model's §2 mermaid block. Any difference is a defect.
- **README body §1 paragraph(s)**: byte-diff against the model's
  §1 narrative. The README copies §1 verbatim; a mismatch means
  the analyst rewrote §1 (or the generator paraphrased instead of
  copying). Defect.
- **SKILL.md domain glossary**: every entity in §2 / §3 should
  appear in the glossary table with its current `singular_label`,
  and no extra entities should appear. Add / remove / rename =
  defect.
- **SKILL.md "Key enums"**: every enum the model declares
  (§5 plus per-entity `enum` fields) and every value within each
  enum should appear; no extras. Defect on any add / remove /
  rename / reordering of values that recipes branch on.
- **SKILL.md "Platform-derived fields" preamble block**: must
  match the union of `computed_fields[].name` across every
  entity, with the model's `description` text intact. Defect on
  any add / remove / rename.
- **SKILL.md "Platform-enforced invariants" preamble block**:
  must match the union of `validation_rules[].code` across every
  entity, with the model's `message` and `description` intact.
  Defect on any add / remove / rename.
- **SKILL.md "Platform-enforced permissions" preamble block**
 ): must match the `conditional_permissions`
  index built in Step 2 (i.e. every `validation_rules` rule whose
  JsonLogic invokes `{"require_permission": "<code>"}`). Every
  `(entity, rule_code, permission_code)` tuple in the index must
  appear in the preamble with the rule's `message` and the §8
  step 1 description of the permission. Defect on any add / remove
  / rename. Skip the section entirely when the index is empty.
- **SKILL.md "Restrict-cleanup chains" preamble block**
 ): must match the `restrict_inbound` index built
  in Step 2. Every entity that is the target of at least one
  `reference + restrict` inbound FK must appear with its
  cleanup-children listed in dependency order. Drift signals: an
  entity that the model now declares with a flipped `parent ↔
  reference` FK (per the v1.13 permission-scope override rule)
  but whose preamble entry hasn't been regenerated; or a
  restrict-inbound row in the model that the preamble fails to
  list. Skip the section entirely when no entity has
  restrict-inbound edges.
- **SKILL.md "Row-level read scope" preamble block**:
  must match the `row_visibility_rules` index built in Step 2. Every
  entity that declares a non-empty `Select rule` must appear with the
  scope's plain-English gist (from the rule's `description`, the
  entity's §3 prose, or a fallback paraphrase of the JsonLogic intent).
  The gist must describe the **uniform per-row predicate** that the
  platform applies to every caller with `view_permission`; it must NOT
  promise a `view_all_<plural>` permission bypass unless the model
  file's §7 architectural-decision entry explicitly resolves the
  broadening mechanism (option C separate-entity surface, option D
  Postgres `BYPASSRLS` role attribute) and the preamble names that
  mechanism. **Drift signals (defects):** (a) an entity that the model
  now declares with a new / removed / modified `Select rule` whose
  preamble entry hasn't been regenerated; (b) **a preamble entry that
  names a permission bypass the model file does not resolve in §7**
  (the canonical v2.2 defect — the prose claims a bypass the platform
  cannot honor); (c) a preamble entry whose gist describes a *tiered*
  read pattern but whose underlying `Select rule` JsonLogic encodes a
  uniform filter (drift between intent and rule). Skip the section
  entirely when `row_visibility_rules` is empty.
- **SKILL.md "Conditional field UI states" preamble block** (analyst
  v2.2+): must match the `dynamic_input_types` index built in Step 2.
  Every field that declares a non-empty `input_type_rule` must appear
  with the rule's `description` (or the JsonLogic's plain-English
  gist), grouped by entity. Drift signals: an `Input type rules` entry
  that the model adds, removes, or whose trigger condition the model
  rewrites without a matching preamble change; a preamble entry whose
  field no longer exists in §3 (the analyst dropped the field but the
  preamble lingers). Skip the section entirely when
  `dynamic_input_types` is empty.
- **Per-JTBD coverage of `conditional_required_fields`**:
  for every entry in the `conditional_required_fields` sub-index built
  in Step 2 (a field whose `input_type_rule` flips `default → required`
  on a transition), the transition JTBD that fires the trigger
  condition must include the dependent field in its PATCH body as a
  side-effect of the trigger. A transition recipe that sets the trigger
  field without the paired side-effect field is a drift defect — the
  rule was added to the model after the recipe was written, or the
  generator missed it. Severity: defect (regenerate the JTBD's
  reference / script).
- **SKILL.md "What this skill does NOT do" inlined §7.2 list**:
  must match the model's current §7.2 bullets. Defect on any add
  / remove / rename. (Bullets the user has paraphrased for
  readability are non-canonical, not defect; flag separately.)
- **JTBD recipe field references**: every column a recipe writes
  (in inline bodies, references' Recipe blocks, or scripts) must
  exist on the entity in the current §3. A recipe writing a
  removed or renamed column is a defect.
- **Audit-log mentions**: every entity SKILL.md / a reference
  claims is `audit_log: yes` (or `: no`) must agree with the
  current §3 entity declaration. Defect on mismatch.
- **§6 cross-model hints**: every cross-model hint named in
  generated content (Guardrails, "What this skill does NOT do")
  should still be present in the model's §6. Defect on stale
  references.

The drift check has its own severity row in "What to report"
below. It runs **regardless** of whether the user invoked the
skill-maker for a regeneration or a review, the model is the
contract, and a review that does not re-resolve to the contract
is incomplete. (The "review skill" call is exactly Step 4.)

#### Artifact-shape checks (post-drift)

After the drift check, walk every file in the skill folder
(`SKILL.md`, `README.mdx`, `references/*.md`, `scripts/*.sh`) and
apply the same checks the self-review (Step 9, Principle 0)
applies to freshly written files. The point is symmetry: if
Principle 0 would reject a file the generator just wrote, it
should also flag the same file sitting on disk from a prior run.
Concretely:

- **Read patterns.** Every `semantius call ... GET ...` is either
  `--single` (one row required) or array-default (zero or many rows
  acceptable). The flag must be present iff the lookup is by `id`,
  unique column, or composite-unique key. A unique-key read missing
  `--single` is non-canonical (still works, but uses the legacy
  two-guard pattern).
- **Guard patterns** (scripts only). `--single` reads need only the
  exit-code guard; array reads need exit-code AND body inspection.
  A `--single` read with a redundant `grep -q '"id"'` follow-up is
  non-canonical. An array read with no body inspection is a defect.
- **Response parsing** (scripts only). `--single` responses are bare
  objects (`grep -oE '"id":"..."'`, no `head -n1`, no `[0]`); array
  responses need `head -n1` or `[0]` indexing. A mismatch silently
  produces empty strings; flag it.
- **`# expect:` annotations** (references only). Every GET, POST,
  PATCH, DELETE in the recipe carries an `# expect:` line naming
  the pattern (`--single` or array) and the action on failure.
  Missing annotations are defects.
- **Cross-reference integrity.** Every
  `references/<slug>.md` linked from SKILL.md must exist on disk;
  every `scripts/<slug>.sh` mentioned in a SKILL.md `Recipe:` line
  must exist. Files on disk that aren't linked from SKILL.md are
  orphans (left over from a JTBD that no longer exists or was
  reclassified).
- **Pass 3 alignment.** For each JTBD in the current generation's
  plan, the file on disk should match the new classification. A
  JTBD now classified `script` whose existing artifact is
  `references/<slug>.md` (or vice versa) needs migration; the audit
  flags the pair, the user picks the direction.
- **Hardcoded literals.** Search every file for ISO timestamps,
  ISO dates, baked-in ids, and the generation year. These rot and
  should be placeholders. Same scan the self-review's Principle 1
  runs on a fresh write.

#### What to report (handed to Step 10)

For each file with findings, produce one bullet:

- `README.mdx: drift, body §1 paragraph mismatches the model's
  current §1 narrative. The analyst rewrote §1 to drop backticked
  identifiers; the README still has the old verbatim copy.`
- `SKILL.md: drift, "Platform-derived fields" preamble lists 1
  field; model's computed_fields union now has 2 (added
  features.days_open). Recipes will not warn against writing the
  new field.`
- `SKILL.md: drift, "Key enums" lists feature_status values
  including 'parked'; model's §5 no longer declares 'parked'.
  Triage's Inputs table accepts a value that no longer exists.`
- `cast-vote.sh: 4 reads use legacy two-guard pattern; --single
  would collapse each to one guard. Working but non-canonical.`
- `triage-feature.md: 2 GETs missing # expect: annotations.`
- `score-rice.md: classified `script` in current plan but exists
  as reference; needs migration.`
- `tag-feature.md: orphan; no JTBD with this slug in current plan.`
- `ship-release.sh: contains hardcoded date "2026-05-04"; should be
  a placeholder.`

Group findings by file and by severity:
- **"drift"** = the file no longer matches the source model; baked
  content is stale. Always recommend regenerating.
- **"defect"** = the file is broken on its own terms (missing link
  target, structural shape failure, recipe writes a removed column).
  Recommend regenerating.
- **"non-canonical"** = the file works but uses an outdated
  pattern; user decides whether to take the upgrade.
- **"orphan"** = the file is no longer referenced from SKILL.md
  (its JTBD was reclassified or removed). User decides whether to
  delete or restore.

The Step 10 summary surfaces these and asks the user how to
proceed; **do not auto-rewrite in Step 4**.

#### What the user can choose in Step 10

Three options the summary should offer:

1. *Regenerate flagged files* (Steps 5–7 rewrite them). Default for
   defects.
2. *Leave as-is*. Default for non-canonical findings on a file the
   user may have hand-edited.
3. *Per-file decision*. The user accepts some, rejects others.

If the user opts to regenerate, the affected files are rewritten in
Steps 6 (references) and 7 (scripts). Files not flagged for
regeneration stay untouched even if their JTBD is in the current
plan; the audit is what gates the rewrite, not the plan alone.

#### Hand-edits

The audit is conservative about hand-edited prose. References in
particular get hand-edited (failure-mode wording, user-prompt
phrasing). The audit flags non-canonical patterns but does NOT mark
the file for forced rewrite; the user keeps custody. The defect
categories that DO warrant a forced rewrite recommendation
(prefixed "defect" in the summary) are:

- A reference linked from SKILL.md that doesn't exist on disk
- A script file that fails the structural shape check (empty,
  wrong shebang, missing `set -euo pipefail`)
- Cross-FK invariants that contradict the current model (e.g. a
  reference recipe writes a column that no longer exists)

Everything else is "non-canonical" and the user decides.

### Step 5, Write the consolidated SKILL.md

The folder gets two files written in sequence: the agent-facing
`SKILL.md` (this step) and the human-facing `README.mdx` (Step 8).
Both are required output. Write the SKILL.md first because the README
pulls its trigger phrases and JTBD titles from it.


Use the template below. Resolve every reference at generation time
(enum values, FK target tables, required-on-create field sets), the
calling agent must not need to consult the semantic-model file to fill
in fields.

#### SKILL.md template

````markdown
---
name: <modelslug>
description: >-
  <One paragraph. Lead with the domain ("Use this skill for anything
  involving <system_name>, <one-line domain summary>"). List 4–6
  realistic trigger phrases users might say, mixing entity names and
  task verbs (e.g. "create a lead", "convert opportunity to account",
  "report pipeline by stage"). Be slightly pushy, skills under-trigger
  by default.>
semantic_model: <system_slug, e.g. product_roadmap (no path, no .md extension)>
---

# <system_name>

The H1 here is **`system_name` verbatim**. No "Skill" suffix, no
"domain" prefix, no rewording. The file is named `SKILL.md`, so the
agent loading it already knows it is a skill, repeating "Skill" in
the heading is noise. Examples: `# Applicant Tracking System`,
`# Workforce Planning`, `# Customer Relations`.

(The README.mdx H1 follows a different rule, the Title grammar in
Step 8, because the catalog needs the "Skill" suffix to
disambiguate cards. Do not confuse the two.)

This skill carries the domain map and the jobs-to-be-done for
<system_name>. Platform mechanics, CLI install, env vars, PostgREST
URL-encoding, `sqlToRest`, cube `discover`/`validate`/`load`, and
schema-management tools, live in `use-semantius`. Assume it loads
alongside; do not re-explain CLI basics here.

If a task is purely about defining schema, managing permissions, or
running ad-hoc queries against tables you already know, call
`use-semantius` directly, going through this skill adds nothing.

**Module type**: <`domain` or `master`, copied from frontmatter
`module_type` (default `domain` when absent)>. A `master` module is a
neutral host for shared / master data (e.g. vendors, currencies,
departments) consumed by multiple domain modules via cross-module
`permission_hierarchy` rows tagged `origin = "model_master"`. Writes to
entities in a master module have cross-domain visibility: every
consuming domain module sees the write through the bridge. The recipes
in this skill treat master entities the same as domain entities at the
CLI level; the only practical difference is the "shared across domains"
guardrail surfaced on each write recipe touching one. Skip this line
entirely when the model is a plain domain module.

**Shared master entities** (entities authored under this domain module
that the analyst flagged as classic master concepts via the
`**Shared master cluster:** <cluster>` annotation; writes to these
entities are likely candidates for promotion to a master module on
re-deploy, and the live module may already have routed them through a
master via the deployer's Stage 2d Branch B path. Recipes that touch
them include a one-line note that the data is shared across the named
cluster):
<list each entity in the `master_cluster_by_entity` index from Step 2.
Skip the section entirely when no entity in the model carries the
annotation AND the module itself is not `module_type: master`.>

- `<table>` is part of the `<cluster>` shared master cluster.

**Auto-managed fields** (set by Semantius on every table; never include
in POST/PATCH bodies): `id`, `created_at`, `updated_at`. The
`label_column` field is **required on insert and caller-populated** on
every entity unless the model explicitly says it is auto-derived ,
this includes junction tables like `<junction>` and sub-entities like
`<sub-entity>`, where the recipe must compose the value (see each
JTBD for the composition rule). Do not omit `*_label` from POST bodies.

**Platform-derived fields** (set by the platform's per-entity
`computed_fields` triggers on every INSERT/UPDATE; **never include in
POST/PATCH bodies, the platform overwrites caller payloads**:
<list each `computed_fields[].name` from the model, grouped by table
and one-line description copied from `computed_fields[].description`.
Skip the section entirely when no entity in the model declares
`computed_fields`.>

- `<table>.<field>`: <description from the model's `computed_fields[].description`>

**Platform-enforced invariants** (entity-level `validation_rules`
triggered on every INSERT/UPDATE; the platform rejects writes that
violate them with `{ "errors": [{ "code", "message" }, ...] }`. The
recipes here do NOT pre-validate these; they surface the platform's
error to the user verbatim if the write fails):
<list each `validation_rules[].code` from the model, grouped by table,
with the `message` and (if present) `description`. Skip the section
entirely when no entity in the model declares `validation_rules`.>

- `<table>` rule `<code>`: <message>. Why: <description, when present>.

**Platform-enforced permissions** (rules whose JsonLogic invokes
`{"require_permission": "<code>"}`; the platform throws when the caller
lacks the named permission, surfacing the rule's `code` and `message`
as a validation failure. The recipes that hit these gates name the
permission up-front so the calling agent can either (a) confirm the
caller holds it before attempting the write, or (b) propose handing
off to a user who holds it instead of hitting the throw blind):
<list each `(entity, rule_code, permission_code, role-hint)` tuple
from the `conditional_permissions` index built in Step 2. Pull the
`role-hint` from §8 step 1's description of the permission. Skip the
section entirely when `conditional_permissions` is empty.>

- `<table>` rule `<code>` requires `<permission_code>` (`<role-hint
  from §8>`): <message>. Why: <description, when present>.

**Restrict-cleanup chains**; inbound `reference + restrict`
FKs that block deletion of the target entity until children are
explicitly cleaned up first. The calling agent attempting to delete a
listed entity must walk the named children first, in the order given,
or the platform will reject the DELETE with a foreign-key constraint
error. Every listed chain corresponds to a Pattern J "delete /
archive" JTBD in this skill):
<list each entity that has at least one inbound `reference + restrict`
edge per the `restrict_inbound` index from Step 2. For each entity,
list the restrict-children in dependency order (children of children
first if any chain deeper). Skip the section entirely when no entity
in the model has restrict-inbound FKs.>

- Deleting `<table>` requires cleaning up first: `<child_table>` (via
  `<fk_field>`), `<child_table>` (via `<fk_field>`), … See the
  `delete-<table>` JTBD for the recipe.

**Row-level read scope**; per-row visibility filters set on the
entity via `select_rule`. The platform applies an RLS policy on every read.
**Critical: the rule applies uniformly to every caller with `view_permission`** —
the platform evaluates the JsonLogic body per row with `$today` / `$now` /
`$user_id` as reserved variables; there is no documented mechanism by which
holding a specific permission causes the rule to be skipped for that caller.
Recipes against a scoped entity must surface the per-row predicate as a
**uniform** limit, not a tiered one. If the model file's §7 carries an
explicit architectural-decision entry naming a documented broadening
mechanism (a separate cube view / entity surface admins read, or a
Postgres role with `BYPASSRLS` provisioned outside Semantius), name that
mechanism here so the recipe can route to it; otherwise the broader-access
path is human escalation, not a magic permission grant.):
<list each entity in the `row_visibility_rules` index from Step 2. For
each entity, give the scope in plain English (from the rule's
`description`, the entity's §3 prose, or a paraphrase). Name the
documented broadening mechanism ONLY when the model file's §7 explicitly
resolves it; otherwise omit the broadening line. Skip the section
entirely when `row_visibility_rules` is empty.>

- `<table>`: every caller with `view_permission` sees only rows where
  <plain-English uniform predicate>. <Optional: "Broader read access for
  `<role>` is provisioned via `<mechanism named in model §7>`" — include
  only when the model's §7 names the mechanism.>

> **Never write a line like "callers holding `<slug>:view_all_X` bypass the
> filter".** That mechanism is not documented in the current Semantius
> platform spec. A preamble that promises it generates recipes that look
> right but silently leak access OR silently deny access (depending on
> how the calling agent reasons). The audit catches this as the canonical
> v2.2 defect.

**Conditional field UI states**; per-field UI mode overrides
set via `input_type_rule`. The platform evaluates the rule client-side at
form-render time and overrides the field's static `input_type` for the
current record. The rule does NOT gate writes — recipes that POST/PATCH
the entity bypass the form entirely and can set any field at any
time — but two patterns matter for recipe shape: (a) when a rule flips
a field's effective mode to `required` on a sibling-field transition,
the transition's recipe must set that field in the same PATCH (else the
form would have rendered it `required` but the API call leaves it null);
(b) when a rule flips a field's effective mode to `readonly` after a
terminal state, recipes that update the entity after that state should
not write the field. Cross-reference with `validation_rules` — when the
server-side rule enforces the same invariant, the platform rejects the
bad write with a structured `code` / `message`; surface that in the
JTBD's Failure modes block):
<list each field in the `dynamic_input_types` index from Step 2,
grouped by entity. For each, name the field, the trigger gist (from the
rule's `description` or the JsonLogic's plain-English summary), and the
resulting effective `input_type`. Skip the section entirely when
`dynamic_input_types` is empty.>

- `<table>.<field>`: <trigger gist, e.g. "hidden until status=approved,
  then readonly"> (paired server-side rule: `<validation_rules.code>` —
  or *"no paired server-side rule; UI-only behavior"*).

---

## Domain glossary

<One short table. Pull `singular_label`s, table names, and a one-line
"what it represents" for each entity. Group related entities together
(e.g. "Pipeline: leads, opportunities, accounts"). Skip junction tables
unless a job touches them directly. Do not duplicate FK targets here ,
each JTBD's reference file owns its own FK assumptions.>

| Concept | Table | Notes |
|---|---|---|
| Lead | `leads` | Inbound or sourced contact, not yet qualified |
| Opportunity | `opportunities` | Qualified deal in the pipeline |
| Account | `accounts` | Closed-won opportunity or imported customer |

## Key enums

<Only enums that gate JTBDs. Skip purely informational ones. Format:
table.column → values, with the typical lifecycle path marked.>

- `leads.lead_status`: `new` → `contacted` → `qualified` | `disqualified`
- `opportunities.stage`: `prospecting` → `proposal` → `negotiation` →
  `closed_won` | `closed_lost`

## Cross-cutting data rules

<Only facts that span 2+ JTBDs in load-bearing ways belong here.
Per-FK shape, per-junction uniqueness, and audit-logging notes go
in the JTBD's reference file, not here. This section is often empty
or just 1–2 lines; that is correct, not a sign of incompleteness.

Examples of facts that *do* belong here:
- A naming convention several recipes rely on (e.g. "all `*_at`
  fields are server-set on insert; never include them in POST bodies").
- A platform-wide constraint that constrains every recipe's write
  pattern (e.g. "rows soft-deleted via `is_active=false` are still
  visible to `read_*`; recipes filter on `is_active=eq.true` unless
  the JTBD explicitly wants the full history").

If you have nothing to put here, omit the section.>

## When the runtime disagrees with the recipe

The FK shape and audit-logging facts in each JTBD's reference file
are baked in at skill-generation time. The live schema can drift,
admins can add a unique index, drop an FK, or toggle audit-logging
on a table without regenerating this skill. The recipes are not
self-correcting on their own, but the agent has an escape hatch.

When a recipe gets a `409 Conflict`, `422 Unprocessable Entity`, or
any other write failure the JTBD's reference file did not predict,
the recovery move is **read the live schema, then decide**:

```bash
# What FKs does this entity actually have right now?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>"}'

# Or, more targeted, what does field <name> reference today?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>,name=eq.<field_name>"}'
```

If the live shape contradicts the recipe's assumption (e.g. a unique
constraint exists where the recipe expected a free-form junction),
abort with a clear stderr message naming the drift, do not silently
"fix it up" with extra writes. Then surface to the user that the
skill is out of date and recommend regenerating via
`semantius-skill-maker`. Drift recovery is the user's call, not
the agent's.

## Lookup convention

<This block lives at the SKILL.md top level, not per-JTBD, so the
agent reads it once per trigger and applies it everywhere. The recipe
files under `references/` may name the column they resolve, but they
do not re-explain `wfts` vs `eq`.>

Semantius adds a `search_vector` column to searchable entities for
full-text search across all text fields. Use it whenever the user
passes a name, title, email, or description, not a UUID:

```bash
semantius call crud postgrestRequest '{"method":"GET","path":"/<table>?search_vector=wfts(simple).<term>&select=id,<label_column>"}'
```

Use `wfts(simple).<term>` for fuzzy text searches; never `ilike` and
never `fts`, they bypass the search index and mismatch the platform
convention.

Field-equality (`<column>=eq.<value>`) is the right tool for a
*different* job: filtering on a known-exact value. Use it for UUIDs,
FK ids, status enums, and unique columns whose values the caller
already knows verbatim (e.g. `tag_name`, `user_email`, `release_name`,
`cost_center_code`). The two patterns are not in competition:
`wfts(simple)` resolves a fuzzy human input to a row; `eq` selects
rows whose column exactly equals a known value.

If a lookup returns more than one row, present the candidates and
ask. If zero, ask the user to clarify rather than guessing.

## Timestamps in recipe bodies

<Top-level rule, named once here, never restated per JTBD.>

Every `*_at` field, `*_date` field, or other moment-of-action value in
a recipe body is a placeholder the calling agent fills at call time,
not a literal copied from the example. The Recipe templates use
`<current ISO timestamp>` and `<today's date, YYYY-MM-DD>`; do not
copy those strings into a real call. This applies in SKILL.md, in
every reference file, in the Common queries appendix, and in any
script the calling agent invokes.

---

## Jobs to be done

<One H2 per JTBD. Each section follows the structure below. Order
sections by typical lifecycle (create → progress → close → report),
not alphabetically.>

### <Job title, verb phrase>

**Triggers:** `<phrase 1>`, `<phrase 2>`, `<phrase 3>`

**Inputs:**

| Name | Required | Notes |
|---|---|---|
| `<input>` | yes/no | <where it comes from; resolved by `<column>=eq.<value>` if exact, `search_vector=wfts(simple).<term>` if fuzzy> |

The Inputs table must be **internally consistent with the routing
rules below**: do not list a status value as an accepted input here
and then say "for that value, route to JTBD Y". If a value belongs
elsewhere, drop it from this table.

**Recipe:** see [`references/<jtbd-slug>.md`](references/<jtbd-slug>.md).

*(Reference shape, used when the JTBD was classified `reference` in
Step 3 Pass 3. The full recipe body, lookup-then-compose-then-write,
including any branching, label composition, and computed-value
recompute, lives in the linked file. Do not paste it here.)*

*(Script shape, used when the JTBD was classified `script`:)*
**Recipe:** run `scripts/<op-slug>.sh <arg1> <arg2>`. The agent
invokes; do not paste the script body here. Exit `0` on success,
non-zero with the failed step on error.

*(Inline shape, only when classified `inline` in Pass 3, ≤5 lines of
recipe, no branching:)*
**Recipe:**

```bash
semantius call crud postgrestRequest '{"method":"POST","path":"/<table>","body":{...}}'
```

**Validation:** <2–3 short post-conditions, only the ones that have
actually been broken in practice. The reference file may carry deeper
validation; this list is what an agent skimming the SKILL.md needs to
sanity-check the call.>

**Failure modes:** <1–2 most-likely failures, each paired with a
*recovery action*. Long lists belong in the reference file's extended
failure-modes section; here, surface only what an agent needs to bail
out cleanly. Examples:

- `409 on <table>.<column>` (uniqueness) → row already exists; PATCH
  the existing row instead.
- FK violation on `<column>` → the parent was deleted; ask the user
  whether to recreate or abort.>

---

### <next job…>

…

---

## Common queries

<Optional appendix from Pattern I, pre-shaped cube queries for
reporting tasks. These are *not* JTBDs; they're examples the calling
agent can adapt. Open with one note, then 3–5 query blocks.>

Always run `cube discover '{}'` first to refresh the schema. Match the
dimension and measure names below against what `discover` returns ,
field names drift when the model is regenerated, and `discover` is the
source of truth at query time.

```bash
# Pipeline by stage (count + total amount)
semantius call cube load '{"query":{
  "measures":["opportunities.count","opportunities.sum_amount"],
  "dimensions":["opportunities.stage"],
  "order":{"opportunities.sum_amount":"desc"}
}}'
```

<…2–4 more representative queries, each with a one-line title comment.>

---

## Guardrails

<Domain-specific rules the calling model should never violate. Each rule
should appear here *or* in the relevant JTBD's failure-modes, not both.
Pull from §7.1 of the model (resolved blockers / explicit constraints)
and from the merit signals that triggered each JTBD. Examples:

- Never PATCH `opportunities.stage` directly to `closed_won` without
  setting `closed_date` and `won_amount` in the same call.
- `accounts` rows are only created via the close-won flow, never
  insert directly.
- `*_status` flips in this domain are not DB-guarded; always read
  current status before writing.
- Junction labels are caller-populated, see each junction JTBD for the
  composition convention.>

## What this skill does NOT do

- Schema changes, use `use-semantius` directly.
- RBAC / permissions, use `use-semantius` directly.
- One-off seed data, write a script, don't bake it into a JTBD.
- <Inline the bullet list of unbuilt features here. Pull each item from
  §7.2 "Future considerations" of the model at generation time and
  write it as a plain bullet, do *not* cite "§7.2" in the SKILL.md,
  the calling agent has no way to look it up. If §7.2 is empty or
  missing, drop this bullet entirely.>
````

#### What goes into each recipe, concretely

When you bake a recipe, **resolve every reference**:

- **Enum values**, copy verbatim from §5. Write `"stage":"closed_won"`,
  not `"stage":"<terminal value>"`.
- **FK fields**, list by name with target table; if the agent passes a
  human-friendly value (an email, a code), the first recipe step is the
  lookup that resolves it to an id, using the `wfts(simple)` pattern
  above for searchable entities.
- **Timestamps and dates**, never hardcode a date or timestamp literal
  in a recipe. The model file is read once at generation time but the
  recipes run weeks or years later; a baked-in `"2026-05-01T10:30:00Z"`
  silently corrupts every future call. For fields like `voted_at`,
  `posted_at`, `submitted_at`, `actual_release_date`, `closed_date`,
  always render the value as a placeholder the calling agent fills at
  call time, `"<current ISO timestamp>"` or `"<today's date, YYYY-MM-DD>"`
 , and add a one-line note in the recipe: *"`posted_at`: set to the
  current timestamp at call time; do not copy the example value."*
  This applies to every example body in the SKILL.md, including the
  Common queries appendix.
- **Caller-populated label fields**, when a `label_column` is required
  but not auto-derived (the model marks the field as required with no
  default; common on junction tables and sub-entities like `comments`),
  call this out *both* in the glossary's "auto-managed fields" note
  *and* in each affected JTBD. The default Semantius behavior is that
  `id`, `created_at`, `updated_at` are auto-managed, but `label_column`
  is **not** auto-managed when the entity declares it as a required
  caller-populated field, the recipe must compose and POST a value.
  Word the auto-managed-fields note carefully so an agent skimming the
  glossary doesn't conclude it can omit `*_label` from POST bodies.
- **Required-on-create field sets**, the model's `Required` column is
  intent, not platform-enforced. Spell out the business-required fields
  per JTBD; they often differ from create vs update.
- **Audit-logged entities**, Semantius handles audit rows automatically
  on writes; recipes don't manage them. The non-obvious case is *reading*
  the audit trail. If the merit test surfaced an audit-read JTBD, the
  recipe is a single GET against the audit endpoint with the entity id ,
  see `use-semantius` `references/crud-tools.md` for the path shape.
- **Platform-derived fields (`computed_fields`)**, the platform writes
  these on every INSERT/UPDATE and overwrites whatever the caller sent.
  Recipes must **never include them in POST/PATCH bodies**, and must
  not re-derive them client-side. After a write that touches the inputs
  (`reach_score`, `impact_score`, `confidence_score`, `effort_score` for
  a RICE-derived `rice_score`), the recipe's "Validation" block should
  **read back** the row and assert the derived field has the expected
  value, that's the only place the formula is restated, and only to
  spot-check that the trigger fired.
- **Platform-enforced invariants (`validation_rules`)**, the platform
  rejects bad writes with a structured `{ "errors": [...] }` body and a
  4xx status. Recipes must **not pre-validate** these, duplicating the
  rule client-side is brittle (the rule can change in the platform without
  a recipe regen) and surfaces the same error twice on bad input. Instead,
  the JTBD's `Failure modes` block names each platform `code` the user
  is likely to hit and the recovery action: *"`code: release_only_when_committed`,
  the user tried to attach a release before the feature is committed; tell
  them to triage the feature to `planned` first, then retry."* The
  `code` is the i18n binding key, never paraphrase it.
- **Platform-enforced permissions (`require_permission` rules)**, the
  platform throws when the caller lacks the named permission, and the
  throw lands as a regular `validation_rules` failure (same `code` /
  `message` shape, same 4xx response). Recipes here differ from the
  generic "don't pre-validate" rule above: it is **cheap and high-value**
  for the recipe to **pre-flight the permission check** by reading the
  caller's role-permissions before attempting the write. The point is
  not to duplicate the platform's enforcement (the platform is the
  source of truth, and the recipe still surfaces the throw verbatim if
  the pre-flight is wrong) but to give the calling agent a chance to
  *avoid the failure entirely* by handing off to a user who holds the
  permission, or by escalating to confirm. The recipe shape is:
  (1) read the conditional-permission row from `Platform-enforced
  permissions` preamble, naming the gate, the permission code, and the
  role-hint; (2) if the caller is the current user and they lack the
  permission, **stop and ask** ("this transition requires the
  `<permission_code>` permission, typically held by <role-hint>; do you
  want to hand off, or proceed as the user who is signed in?"); (3) if
  the caller is acting on behalf of a specific user, surface who that
  user is and confirm they hold the permission before proceeding;
  (4) the JTBD's `Failure modes` block names the platform `code` and
  the recovery action just like a regular invariant. Family-13 owner /
  manager edit gates use the same shape: pre-flight by reading the
  record's owner field against the caller's `$user_id`, fall back to
  `require_permission` of the override role only when ownership doesn't
  match.
- **1:1 / unique constraints**, flag in **Failure modes** with the
  exact 409 condition *and* the recovery action (PATCH the existing row,
  pick a different parent, etc.).
- **Row-scoped reads (`select_rule`)**, the platform
  filters rows from every read of a scoped entity via an RLS policy.
  **The rule applies uniformly to every caller with `view_permission`.**
  Three recipe shapes apply:
  - *Read recipes against a scoped entity* lead with a one-sentence
    visibility callout pulled from the **Row-level read scope** preamble
    ("every caller with `view_permission` sees only rows where `<plain-
    English predicate>`; rows outside the predicate are filtered out at
    the RLS layer regardless of the caller's role"). Recipes that
    *enumerate* the entity to make a decision ("are there any open
    tickets?") need this callout most loudly — a missing row is
    indistinguishable from no-such-row, and a recipe that concludes
    "no open tickets exist" from an empty result is wrong when the
    caller is scoped.
  - *Broader-access path (when the model's §7 resolves a mechanism).*
    If the **Row-level read scope** preamble named a documented
    broadening mechanism (separate cube view / entity surface, or a
    Postgres `BYPASSRLS` role attribute), the recipe's "you might want
    more" block names that mechanism and how the caller routes to it.
    The recipe does not auto-elevate; it proposes the route and lets
    the caller decide. **If the preamble did NOT name a mechanism, the
    recipe says so plainly: "broader read access for this entity is
    not provisioned in this catalog; escalate to a user who holds the
    role with broader access" — and never invents a "grant yourself
    `<slug>:view_all_X`" hand-off.**
  - *No client-side re-encoding of the rule.* Recipes must not duplicate
    the `select_rule` JsonLogic in their own filter (e.g. wiring
    `submitter_user_id=eq.$user_id` into the GET path "to be safe"). The
    platform applies the rule; client-side duplication is redundant and
    breaks if the model's rule changes between regenerations. The
    correct posture is: read with the natural query; the platform
    filters; surface the visibility limit to the user via the preamble
    callout.
- **Conditional UI states (`input_type_rule`)**, the
  platform overrides a field's effective `input_type` at form render
  per-record. Recipes that POST/PATCH bypass the form and are not gated
  by the rule, but two patterns matter:
  - *Conditional-required side-effect.* For every entry in the
    `conditional_required_fields` sub-index (a rule that flips
    `default → required` on a transition), the JTBD that performs the
    triggering transition must set the dependent field in the same
    PATCH. The `dynamic_input_types` index gives the trigger and the
    dependent; the JTBD's Recipe block makes the PATCH explicit ("set
    `status=approved` AND `approved_at=$now` in one call"). When a
    paired `validation_rules` family-5 entry exists, name its `code` in
    the Failure modes block as the platform's enforcement-side counterpart.
  - *Post-terminal lock.* For every rule that flips a field to
    `readonly` after a terminal state, recipes that *update* the entity
    after that state should drop the locked field from their PATCH body.
    The platform doesn't enforce this server-side via `input_type_rule`,
    so the recipe is what keeps it consistent with the UI; if a paired
    server-side rule exists (a Stage 8 family-10 state-transition rule
    typically), surface its `code` in Failure modes.
  - *No re-derivation of the rule's effective value.* Recipes must not
    attempt to compute the field's UI mode client-side and branch on
    it — the rule is for the form, not for the recipe. A recipe that
    reads `status` and decides whether to include `approved_at` in the
    body should do so based on the **JTBD's own transition semantics**
    (which it owns), not by interpreting the `input_type_rule` JsonLogic.
- **Cube queries in the appendix**, always lead with
  `cube discover '{}'` and tell the calling agent to *map* the
  appendix's measure/dimension names against discover's output. Cube
  schema names drift on regeneration; the appendix is a starting point,
  not a contract.

#### Trigger phrasing

The trigger language lives on **two distinct surfaces** that serve
different audiences and take different shapes. They are NOT copies
of each other; they overlap only in what they describe (the
domain), not in their wording.

**Surface 1: SKILL.md frontmatter `description`.** Matcher fuel,
read by Claude Code's skill router to decide whether to load this
skill for a given user prompt. The matcher works on semantic
similarity between the description and the user's prompt, so the
description should describe the **intent classes** the skill
handles, not list literal user phrasings. Concrete user-voice
sentences over-fit to specific wordings; abstract intent
enumeration generalizes across the thousands of phrasings real
users actually produce.

This pattern matches how Anthropic's own skills are authored
(`pdf`, `docx`, `xlsx`, `pptx`): their descriptions are intent
enumerations, not lists of quoted user sentences. Follow that
convention.

**Surface 2: README.mdx `## Sample prompts`.** Catalog display,
read by humans browsing a skill list. Its job is to show the
**breadth** of what users can ask of this domain in literal
phrasings the reader recognizes ("yes, I'd say something like
that"). Concrete user-voice sentences belong here, in volume.

##### How to author the SKILL.md description

Two parts, in this order:

1. **Domain noun + scope** (1 sentence). Lead with the domain
   ("CRM", "ITAM", "workforce planning") and the entities or
   capabilities it covers in plain words. Example: "Use this
   skill for anything involving ITAM (IT Asset Management), the
   in-house domain that tracks hardware assets, software products
   and licenses, installations, asset assignments, contracts, and
   purchase orders, plus the cost-center and chargeback rollup
   that links them."

2. **Action intent enumeration** (one sentence, verb-phrase list).
   List the JTBDs as abstract verb-phrase intents, comma-separated
   inside a single sentence introduced by "Trigger when the user
   wants to ...". Each intent corresponds to one JTBD section in
   the body; the matcher generalizes from these phrasings to
   varied user wording. Example: "Trigger when the user wants to
   deploy a hardware asset to a user, return or unassign an asset,
   retire or decommission equipment, install software on an asset
   with optional license seat tracking, uninstall software, mark a
   purchase order received, or renew a contract."

   - Aim for 6–10 intent phrases (one per JTBD; bundle close
     siblings if needed). Each phrase 4–10 words.
   - Lead each with an active verb. Cover the primary verb plus
     one common informal synonym where natural ("retire or
     decommission"), so the matcher hears both vocabularies.
   - **Do not** quote literal user sentences ("Bob is leaving,
     return his laptop"). The matcher generalizes better from
     intent phrases.
   - **Do not** include discovery intents (lookups, reports).
     Those are handled by `use-semantius` alone in most cases;
     loading the full domain skill for "who has asset X" wastes
     context. Discovery triggers belong in the README only.

**Do not** add a "Loads alongside `use-semantius`..." compose
hint to the description. The description is matcher fuel, and a
sentence about which sibling skill owns CLI install / PostgREST
encoding / cube mechanics does not help the router map a user
prompt to this skill (users do not type "I need PostgREST
encoding"). Compose-metadata is the harness's concern, not the
matcher's. The compose-hint already lives in the SKILL.md body's
opening paragraph ("Platform mechanics ... live in
`use-semantius`. Assume it loads alongside"), where the calling
agent reads it after the skill has loaded; that is the right
place for it.

##### How to author the README sample prompts

A bulleted list of **concrete user-voice sentences**, the kind of
thing a real person types into chat. Volume matters here; the
reader is browsing.

- 12–17 prompts total.
- **8–11 action prompts**: concrete sentences for the JTBDs.
  Multiple synonymous phrasings for high-traffic JTBDs are
  welcome and useful, "Bob is leaving, return his laptop" and
  "I need to take back Sarah's MacBook" both map to Return and
  both belong in the catalog because real users say both.
- **4–6 discovery prompts**: concrete lookup or report questions.
  "Who has asset SN-12345 right now", "which contracts expire next
  quarter", "show license utilization for Microsoft 365". These
  are NOT in the description (per surface-1 rules) but ARE in the
  README, because the catalog reader benefits from seeing them.

##### The relationship between the two surfaces

The description and the sample-prompts list overlap only in what
they describe (the same domain, the same JTBDs). They do **not**
share wording: the description has abstract verb-phrase intents,
the README has concrete user-voice sentences. Each README sample
prompt should map cleanly to either an intent in the description
(action prompts) or a Common-queries example or lookup-convention
pattern (discovery prompts). Principle 6 (Step 9) gates that
mapping.

### Step 6, Write the reference files (one per JTBD classified `reference`)

For every JTBD that Pass 3 classified as `reference`, write a sibling
file at `<skills-root>/<modelslug>/references/<jtbd-slug>.md`. The
slug matches the SKILL.md `<jtbd-slug>` link target byte-for-byte, the
agent will fail to load the file if the link drifts. Use a short
verb-phrase slug (`schedule-feature.md`, `cast-vote.md`,
`ship-release.md`), not a full sentence.

The reference file is loaded by the calling agent **only** when it
enters that specific JTBD. SKILL.md has already been read by then, so
the agent knows the glossary, enums, lookup convention, timestamp
rule, and guardrails. Do not restate any of those. The reference
file owns the recipe body, the FK / shape assumptions the recipe
relies on, and any rules that only matter inside this JTBD.

#### Reference file template

```markdown
# <Job title (matches SKILL.md ### heading verbatim)>

<One opening sentence: what this recipe does and the most
load-bearing invariant. No marketing, no value-prop, the agent has
already chosen this recipe. Example: "Cast or update a vote on a
feature. The `(feature_id, user_id)` junction has no DB-level
uniqueness, so the recipe must read first.">

## FK & shape assumptions

<List only the FK / uniqueness / audit-logging facts THIS recipe
relies on. One line per fact, in the form
`<child>.<col> -> <parent>.id` plus a short note on uniqueness or
junction shape. Skip anything the recipe doesn't actually depend on,
this is an assumption ledger, not a schema dump.

If any of these turn out to be wrong at runtime (a 409 / 422 the
recipe didn't predict), the agent follows the SKILL.md "When the
runtime disagrees with the recipe" escape hatch: query
`read_field`, surface the drift, abort cleanly. Do not silently
adapt.

Audit-logging notes belong here only if the recipe's correctness
depends on whether audit rows are written; otherwise omit, audit
rows are Semantius's concern, not the recipe's.>

- `feature_votes.feature_id -> features.id`
- `feature_votes.user_id -> users.id`
- `(feature_id, user_id)` junction has **no DB-level unique
  constraint**, recipe MUST read-first before insert to avoid
  duplicate vote rows.

## Composition rules

<Required only when this JTBD composes a caller-populated label or
recomputes a stored field. Spell out the algorithm so two callers
given the same inputs produce byte-identical output. "If possible",
"approximately", and "around N characters" are banned, replace with
deterministic rules: where to cut, what separator, whether to
append an ellipsis, how to round.>

- `<feature_vote_label>`: composed as
  `"{user.user_full_name} -> {feature.feature_title}"`. ASCII arrow
  ` -> ` (space-hyphen-greater-space). The values come from the
  read-first calls in step 1; do not invent.
- `<rice_score>`: computed as
  `(reach * impact * confidence) / effort`. Round to <N> decimals
  to match the `numeric(<precision>, <scale>)` column scale, no
  truncation, no implicit float drift. If `effort` is null or zero
  after the patch, write `rice_score: null` rather than a
  placeholder.

## Recipe

```bash
# Step 1: parallel-fetch (no dependency between these reads)
semantius call crud postgrestRequest '{"method":"GET","path":"/<table>?<filter>&select=<cols>"}'
semantius call crud postgrestRequest '{"method":"GET","path":"/<other>?<filter>&select=<cols>"}'

# Step 2: <branch / compute / refuse logic with explicit conditions,
#         e.g. "if release_status in (released, cancelled), refuse">

# Step 3: <write> (paired fields go in one call, never split)
semantius call crud postgrestRequest '{
  "method":"<POST|PATCH>",
  "path":"/<table>[?<filter>]",
  "body":{<resolved body>}
}'

# Step 4: <verify the post-condition the validation block claims>
```

Annotate each recipe step's leading comment with **what the step
depends on**: independent reads carry the leading comment
"parallel-fetch (no dependency)" so the agent runs them in one round
trip; dependent steps name what they consume from earlier steps.
Without the explicit hint, the agent treats numbered lists as
sequential.

## Validation

<Three or four post-conditions, including any deeper invariants the
SKILL.md outline only summarised. Each one must be checkable from a
single GET; if you cannot, fix the recipe so it can.>

## Failure modes (extended)

<Long-form discussion of every failure that matters: triggering
condition, why it happens, the exact recovery procedure (often a
follow-up call), how to detect after-the-fact that this failure
happened, and whether the recovery is safe to run blindly or needs a
user confirmation. Pair every failure with a recovery, not just a
description.>
```

#### Where FK detail lives, and why

The split exists so SKILL.md stays small *and* tolerates live-schema
drift. Apply the test for each piece of content:

- *Every JTBD touches it* (lookup convention, timestamp rule,
  glossary, enums, guardrails) → SKILL.md only.
- *Only this JTBD touches it* (recipe body, JTBD-specific
  composition rules, FK / uniqueness assumptions, audit-logging
  facts the recipe depends on, extended failure modes,
  computed-field rounding) → reference file's "FK & shape
  assumptions" section.
- *Genuinely cross-cutting fact 2+ JTBDs depend on in load-bearing
  ways* (rare, often empty in practice) → SKILL.md "Cross-cutting
  data rules" section. Default is "doesn't qualify"; promote
  reluctantly.

Per-FK shape used to live in a SKILL.md cheatsheet. It moved to the
reference files because (1) most FKs are touched by only the one
JTBD that mutates them, so the SKILL.md slot was paid by every
trigger but consumed by one, and (2) live schema can drift between
generation and call (admins toggling unique indexes, audit-logging,
FKs); colocating the assumption with the recipe that depends on it
makes regeneration and drift-recovery localised. The runtime escape
hatch in SKILL.md ("When the runtime disagrees with the recipe")
covers the drift case.

A reference file aimed at fewer than ~40 lines means the JTBD
probably belongs inline in SKILL.md after all, the file split has
overhead (an extra read). A reference file growing past ~120 lines
means either the JTBD is doing two jobs (split it) or the reference
is restating SKILL.md material (delete the duplicates).

### Step 7, Write the script files (one per JTBD classified `script`)

For every JTBD that Pass 3 classified as `script`, write a sibling
file at `<skills-root>/<modelslug>/scripts/<op-slug>.sh`. Mark it
executable in the comment header; the calling agent invokes the
script through the shell rather than reading it into context.

The script's contract is its **inputs**, **exit codes**, and **stdout
on success**. The agent never reads the body, so the body must be
self-defending: validate args, refuse on bad preconditions, never
silently leave half-state.

#### Script file template

```bash
#!/usr/bin/env bash
# <op-slug>.sh: <one-line purpose, e.g. "Ship a release: PATCH the
# release row, sweep its planned/in_progress features to shipped,
# verify the sweep is complete.">
#
# Usage: <op-slug>.sh <arg1> <arg2> [optional]
#
# <Optional per-mode / per-subcommand detail block goes HERE, AFTER
# Usage, never before. For a single-mode script omit this block
# entirely. Example for a two-mode script:
#   Add:    read-first dedupe; if row exists active, no-op; ...
#   Remove: soft-deactivate (is_active=false) so history survives.>
#
# Exit:  0 on success
#        1 on usage/validation failure (bad args, precondition not met)
#        2 on platform error (semantius call failed)
#
# Idempotent: re-running with the same inputs is safe. Partial-state
# recovery: on failure, print the failed step and exit non-zero; the
# next run resumes from where it left off.
set -euo pipefail

if [ "$#" -lt <N> ]; then
  echo "Usage: $(basename "$0") <arg1> <arg2> [optional]" >&2
  exit 1
fi
arg1="$1"
arg2="$2"

# Step 1: read; refuse if precondition fails.
result=$(semantius call crud postgrestRequest "{\"method\":\"GET\",\"path\":\"/<table>?<filter>&select=<cols>\"}") \
  || { echo "step 1 (read <table>) failed" >&2; exit 2; }
# parse result, check precondition; bail with a clear message if not met.

# Step 2..N: write, then verify.
semantius call crud postgrestRequest "{...}" \
  || { echo "step 2 (write <table>) failed" >&2; exit 2; }

semantius call crud postgrestRequest "{...}" \
  || { echo "step 3 (sweep <child>) failed; release row already updated, retry will be a no-op for already-shipped rows" >&2; exit 2; }

echo "<op-slug>: ok"
```

#### Conventions every script follows

- **First-line shebang `#!/usr/bin/env bash`**, `set -euo pipefail`
  immediately after, no exceptions. Silent failures in shell are how
  cascade scripts leave half-state.
- **Header section order is fixed**: purpose one-liner, Usage, optional
  per-mode detail, Exit, Idempotent. Usage comes immediately after the
  purpose line so a human auditor sees "how do I call this" before any
  prose. Per-mode behavior detail (e.g. `Add:` / `Remove:`) goes *after*
  Usage, never between purpose and Usage; the synopsis introduces the
  modes, then the detail explains them.
- **Validate args before any platform call.** Print usage to stderr,
  exit 1. The agent reads stderr to recover.
- **Exit codes are part of the contract.** The recipe script's own
  exit codes are: 0 = ok, 1 = bad inputs or unresolved/ambiguous
  lookup, 2 = platform error. The agent only branches on these
  three; do not invent more for the script layer.
  The underlying `semantius` CLI carries finer-grained signal —
  `1` (bad args / `--single` zero rows), `2` (`--single` ≥2 rows),
  `3` (network / transport, transient and retryable), `4` (tool
  execution failed: RLS, dup key, schema, validation rule), `5`
  (auth failure, permanent) — but the script collapses platform
  failures into its own `2` and lets stderr carry the specifics.
  The diagnostic string must name *which step* failed (e.g.
  `step 3 (sweep <child>) failed`) and surface any platform
  `validation_rules` error verbatim so the agent can recover.
- **Failure messages name the failed step.** `step 3 (sweep
  <child>) failed` is recoverable; `error` is not.
- **Surface platform `validation_rules` errors verbatim, never
  duplicate them.** When a `semantius call ... POST/PATCH` fails because
  the platform rejected the write, the response body carries
  `{ "errors": [{ "code", "message" }, ...] }`. Pass the `code` and
  `message` through to stderr unchanged so the agent can surface a
  clean recovery hint to the user. The script may *name* known codes
  in its diagnostic prose (e.g. "step 3 failed; if code is
  `release_only_when_committed`, the user should triage the feature
  to `planned` first"), but it must NOT pre-check the JsonLogic
  client-side; that duplicates a rule the platform owns and rots the
  moment the rule changes.
- **Idempotent.** A repeat run on partially-applied state must
  either complete or be a deterministic no-op. For cascade scripts,
  filter writes to "rows still in the source state", not "all rows
  in the parent set"; running twice then becomes safe.
- **No interactive prompts.** The agent invokes non-interactively.
  If the operation needs a user confirmation, the JTBD is a
  `reference`, not a `script`.
- **URL-encode every caller-provided value interpolated into a GET
  path, PATCH filter, or DELETE filter.** Raw bash interpolation of
  `$var` into `/<table>?search_vector=wfts(simple).$var` or
  `?<col>=eq.$var` breaks the moment the value contains a space, an
  ampersand, a parenthesis, a `+`, a `%`, a `#`, a `?`, a quote, or any
  other character outside the URL unreserved set. Real catalog data is
  full of these (`Customer Management`, `Investment Banking`,
  `Sales & Marketing`, `Account (Salesforce)`). The canonical
  encode-then-interpolate pattern is one line via `jq`:

  ```bash
  enc_term=$(printf '%s' "$user_input" | jq -sRr @uri)
  semantius call crud postgrestRequest \
    "{\"method\":\"GET\",\"path\":\"/${table}?search_vector=wfts(simple).${enc_term}&select=id\"}"
  ```

  This applies to **every** caller value: search terms going into
  `wfts(simple).<term>`, exact-match values going into `<col>=eq.<value>`
  or `<col>=in.(<values>)`, label-equality dedupe filters, and any other
  position where a caller string ends up in the URL. UUIDs already
  resolved from a `--single` read are URL-safe and do not need
  encoding. Recipe lines that interpolate raw `$var` into a path are
  a defect; Principle 7 in Step 9 catches them on self-review.
- **Build JSON bodies with `jq -nc --arg`, never string concatenation.**
  A naïve `body="{\"notes\":\"$caller_notes\"}"` breaks the moment
  `$caller_notes` contains a `"`, a `\`, a literal newline, or a
  control character. Research-agent prose contains all four. The
  failure mode is opaque, the platform sees mangled JSON and returns
  a parse error rather than a clean validation message. The canonical
  build-then-pass pattern is:

  ```bash
  body=$(jq -nc \
    --arg status "$new_status" \
    --arg notes "$caller_notes" \
    '{record_status: $status, notes: $notes}')
  semantius call crud postgrestRequest \
    "{\"method\":\"PATCH\",\"path\":\"/${table}?id=eq.${row_id}\",\"body\":${body}}"
  ```

  Use `--arg` for strings, `--argjson` for booleans / numbers / nested
  objects, and `--rawfile` for multiline content read from a file.
  Conditional fields (only include `industry_id` when
  `alias_type=industry_term`) compose by building the base object then
  layering with `+ {field: $val}` inside the same `jq` call, never by
  concatenating fragments. Recipe lines that build JSON via string
  concatenation are a defect; Principle 7 catches them.
- **Refuse writes to columns the entity does not declare.** The model
  parse in Step 2 already produces a per-entity field list. For any
  optional column a script writes conditionally (`notes`, `description`,
  `condition_notes`, `is_preferred`), the script must either (a) bake
  in the list of entities that carry the column and refuse the arg
  with a clear stderr message when the caller targets one that does
  not, or (b) be specialized to a single entity that has the column.
  A polymorphic script that accepts an `entity` arg and unconditionally
  writes `notes` will 4xx on every entity that lacks a `notes`
  column, and the platform's response (`column "notes" does not exist`)
  is opaque to the agent, surface a precise error early instead. The
  canonical pattern:

  ```bash
  case "$entity" in
    data_object_aliases|data_object_relationships|solutions|vendors|industry_business_functions|business_function_domains|business_function_capabilities|domain_data_objects|capability_domains|solution_domains|solution_data_objects|solution_capabilities|domain_regulations)
      supports_notes=1 ;;
    *) supports_notes=0 ;;
  esac
  if [ "$supports_notes" = "0" ] && [ -n "${caller_notes:-}" ]; then
    echo "step 0: entity '$entity' has no notes column; supported entities are: ..." >&2
    exit 1
  fi
  ```

  The list is computed from the model at generation time, not at
  script-run time. The same rule applies to every optional column the
  recipe ever writes.

### Step 8, Write the README.mdx (human-facing catalog entry)

After the SKILL.md is written, generate a sibling `README.mdx` in the
same folder. This file is **not** loaded by any agent harness; it
exists so a person browsing a skill catalog can understand at a glance
what the skill is for and whether they want it. Optimize for human
skim, not agent triggering.

This step is **not optional**. A run that produces only `SKILL.md` is
incomplete; the catalog system depends on the README being there. If
you find yourself about to print the Step 10 summary without having
written `README.mdx`, stop and write it now.

#### Audience and tone

The reader is a human evaluating skills, not an LLM deciding whether
to invoke one. Two consequences shape every rule that follows:

- Drop the pushy trigger language and the "delegates platform mechanics
  to `use-semantius`" plumbing. Those belong in the SKILL.md, where the
  matcher reads them. A human browsing the catalog does not need to
  know about the `use-semantius` composition to decide whether the
  domain matches their problem.
- Drop the agent-harness jargon (Agent Skills, frontmatter matching,
  trigger phrases as keyword strings). The catalog is read by people
  picking which skills to install, not by the harness picking which
  skill to load.

Lead with the domain narrative the model file already authored. The
catalog reader needs to understand the SYSTEM here. The unique
"why install this specific skill" angle lives only in the front-matter
`description`.

#### Hard banned characters and phrases

These are non-negotiable. The README is read by humans browsing a
skill catalog, and prior generations have repeatedly violated them.

- **Never** emit the em-dash character (Unicode U+2014, the long
  dash often used as a parenthetical break) anywhere in the
  README. Use commas, colons, parentheses, or split sentences.
  Hyphens (`-`) and en-dashes (`–`, used only in number ranges) are
  fine.
- **Never** use the substring "this skill" anywhere in the README.
  The catalog renders many skill cards side by side and "This skill
  helps with…" openings make the list unreadable.
- **Never** include `generated_from`, `semantic_model`, or any other
  provenance key in the README front matter. The catalog only reads
  `title` and `description`. Provenance lives in the SKILL.md.

If you find yourself reaching for an em-dash because the sentence
"feels right" with one, rewrite the sentence. The user has flagged
this multiple times.

#### Front-matter `description` rules

The `description` is the **single line a non-technical person reads
on the catalog card** before deciding whether to open the skill.
It must follow the same audience and verb logic as the body's
skill-explanation paragraph (Step 8 §3), compressed to one
sentence.

**Required shape (one sentence, ≤140 characters):**

> `<Extracted verb><s>` `<the domain object in user words>` `<list of lifecycle stages, operations, or capabilities in plain words>`.

The description names what the skill actually does, by listing the
real nouns of the domain (workflow stages, operations, artefacts).
It does **not** include a "so [benefit]" clause. The benefit /
value-prop lives in the body paragraph's failure-modes sentence,
not on the catalog card. A reader of the catalog card wants to know
what the skill *does*, not why it exists.

- **Extracted verb** comes from the same three-tier verb-extraction
  rule used in the body paragraph (Step 8 § "Verb-extraction
  rule"). The description must use the **same verb** as paragraph 2,
  resolved in this order:
  - **Tier 1, suffix match.** `Tracking|Tracker → tracks`,
    `Planning|Planner → plans`, `Management|Manager → manages`,
    `Budgeting → budgets`, `Scheduling|Scheduler → schedules`,
    `Forecasting → forecasts`, `Reporting → reports`,
    `Monitoring → monitors`, `Routing → routes`, `Booking → books`,
    `Provisioning → provisions`.
  - **Tier 2, implied-domain-verb lookup.** If Tier 1 misses, check
    the noun table: `Roadmap → plans`, `Inventory → tracks`,
    `Ledger → records`, `Directory → lists`, `Registry → registers`,
    `Pipeline → moves`, `Catalog → lists`, `Calendar → schedules`,
    `Knowledge Base|KB → answers`, `Dashboard → surfaces`,
    `CRM → tracks`, `Helpdesk|Service Desk → resolves`. Example:
    `Product Roadmap` → "Plans how every idea moves from intake
    to a shipped feature...".
  - **Tier 3, fallback palette.** Only when neither tier fires:
    `Captures`, `Holds`, `Describes`, `Maps`, `Organises`, or
    `Helps an agent <verb-from-domain> ...`. Should be rare.
- **Domain object** uses the model's user-facing labels, never
  table names or schema-cased identifiers. "candidates", not
  `candidates`; "headcount plans", not `headcount_plans`.
- **Capability list** names the actual lifecycle stages, operations,
  or artefacts the skill works with, in plain domain words from the
  model. Examples: "from requisition through application, interview,
  offer, and hire"; "subscriptions, license assignments, renewals,
  and planned spend by cost center"; "with decision packages,
  funding levels, ranking, and approval workflow"; "from intake
  through RICE scoring, objective alignment, and release scheduling".
  Pull these nouns from the model's entities, enums, and lifecycle
  fields, they should be recognisable to an operator of the system.

**Hard bans (zero tolerance):**

- **"Bakes in", "baked in", "bakes the rules", "bakes the
  invariants".** These read as internal implementation talk; the
  catalog reader does not know or care that anything is being
  baked. Use the extracted verb instead.
- "Multi-step rules", "paired status fields", "paired writes",
  "cascade", "invariants", "knock-on changes baked in", "the
  multi-table cascade that fires when". All mechanics jargon.
- Any snake_case or identifier-shaped token (regex
  `\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b`).
- "This skill", "A skill for", "Domain skill for", "Skill that",
  any self-referential opener.
- Em-dashes (U+2014).
- Engineer-coded LLM language ("non-deterministic", "stochastic",
  "deterministic output").
- Restating the system name itself ("The Applicant Tracking
  System..."). The title already says it.

**Coherence check:** the description's verb must match the body
paragraph's verb (same verb-extraction tier). The description
itself names *capabilities*, not benefits, the body paragraph's
sentence 3 (failure modes) is where the value-prop lives. Do not
paraphrase the body's "so X" clause into the description; that
shape belongs in the body, not on the catalog card.

**Examples (illustrative, regenerate from the actual model):**

| `system_name` | Verb | GOOD description |
|---|---|---|
| Applicant Tracking System | tracks | `Tracks candidates through requisitions, applications, interviews, offers, and hires.` |
| Workforce Planning | plans | `Plans headcount across scenarios, commits approved scenarios into positions, and opens requisitions for new seats.` |
| Equipment Lease Management | manages | `Manages equipment leases through schedules, payments, renewals, and end-of-term disposition.` |
| Zero-Based Budgeting | budgets | `Runs ZBB cycles with decision packages, funding levels, ranking, and approval workflow.` |
| SaaS Expense Tracker & Budget | tracks | `Tracks SaaS subscriptions, license assignments, renewals, and planned spend by cost center.` |
| Product Roadmap | plans (Tier 2: `Roadmap` → plans) | `Plans features through intake, RICE scoring, objective alignment, release scheduling, and ship.` |
| Inventory Tracker | tracks (Tier 1) | `Tracks items, locations, movements, counts, and reorder points across warehouses.` |
| General Ledger | records (Tier 2: `Ledger` → records) | `Records transactions across accounts, journals, and periods, and runs balanced period closes.` |
| Service Desk | resolves (Tier 2: `Service Desk` → resolves) | `Resolves tickets through intake, triage, assignment, work, and follow-up.` |

**BAD examples (do not produce):**

- `Bakes in the multi-step rules for moving a candidate from application to hire, including paired status fields and offer-acceptance ripples.` (Bakes in, paired status fields, ripples, all jargon.)
- `Tracks candidates from application to hire so the right pieces always get filled in in the right order.` (The "so [outcome]" clause is trigger-fodder; the description should name capabilities, not justify them.)
- `Plans headcount across scenarios so an approved scenario walks into real seats with the right paperwork at every step.` (Same anti-pattern, "so [outcome]" clause replaces the capability list.)
- `This skill helps with the Applicant Tracking System.` (Self-referential opener, restates the title.)

#### Body structure (in this exact order)

The body has exactly **five** sections after the heading. Do not
add, rename, or rearrange.

1. **Heading.** See "Title grammar" below.
2. **Model description (verbatim from the model's §1 narrative).**
   Immediately after the heading, copy the model file's §1 narrative
   paragraph(s) verbatim. Do not paraphrase. Do not insert your own
   summary. This paragraph explains what the SYSTEM is.
   - **Ignore the `domain` frontmatter field entirely** when building
     the README body. In every model file we have seen, `domain` is a
     short category tag (`ATS`, `CDP`, `ERP`, `Workforce Planning`,
     `Product Management`), not a description. Pasting it as a body
     paragraph leaves an orphan acronym floating under the heading
     and looks broken. The §1 narrative is always the source of truth
     for the body description.
   - If the model file has no §1 narrative, stop and ask the user to
     add one. Do not fabricate a description.
3. **Skill explanation paragraph (one paragraph, ~3 sentences,
   built on a fixed three-noun definition).** After a blank line,
   write **one** paragraph aimed at a non-technical human browsing
   the catalog. The paragraph names three things in order: the
   **model**, the **skill**, and the **failure modes**.

   #### The three-noun definition

   - **The model** describes the static structure: what entities
     exist, what fields they have, what values are allowed. It tells
     the agent *what can be recorded*.
   - **The agent** is good at understanding instructions and
     chaining steps, but two runs of the same prompt can take subtly
     different paths and produce subtly different records.
   - **The skill** is the missing piece between them: it teaches the
     agent *how to use this specific model to do its specific jobs
     reliably, the same way every time*.

   That third bullet is the value-prop, every paragraph must carry it
   somehow. The skill is not a metaphor about habits or shorthand,
   it is the model's instruction manual for the agent.

   #### Sentence-by-sentence shape

   **Sentence 1, the model.** Name the model and what it lays out
   or tracks. Use the verb-extraction rule below. Bridge from the
   previous paragraph by referring to the same kind of thing it
   ended on (records, plans, ideas, contracts).

   **Sentence 2, the skill.** Name the skill (by its title, not the
   pronoun "this skill") and what it teaches the agent: how to use
   the model to do its specific jobs reliably and the same way
   every time. Reuse the domain verb from sentence 1 if it reads
   naturally.

   **Sentence 3, what going wrong looks like.** Two or three
   concrete failure modes in plain domain words, semicolon-
   separated. These are evidence for the value-prop, not complaints
   about the platform.

   Optional sentence 4, what life looks like with it loaded. Only
   if it earns its keep, do not pad.

   #### Verb-extraction rule (critical, prevents all paragraphs
   reading the same)

   Most `system_name` values either have an action verb hiding in a
   suffix or **imply** one through a domain noun. Resolve in **three
   tiers**, in order. Stop at the first tier that fires.

   **Tier 1: Suffix match.** If `system_name` ends in an `-ing`
   gerund or an `-er`/`-or` agent noun from the table below, use the
   bare verb form.

   | Suffix | Verb | Example |
   |---|---|---|
   | `Tracking`, `Tracker` | tracks | "The Applicant Tracking model **tracks** ..." |
   | `Planning`, `Planner` | plans | "The Workforce Planning model **plans** ..." |
   | `Management`, `Manager` | manages | "The Equipment Lease Management model **manages** ..." |
   | `Budgeting` | budgets | "The Zero-Based Budgeting model **budgets** ..." |
   | `Scheduling`, `Scheduler` | schedules | |
   | `Forecasting` | forecasts | |
   | `Reporting` | reports | |
   | `Monitoring` | monitors | |
   | `Routing` | routes | |
   | `Booking` | books | |
   | `Provisioning` | provisions | |

   **Tier 2: Implied-domain-verb lookup.** If Tier 1 does not fire,
   check whether `system_name` contains one of these domain nouns,
   each of which implies a verb a user would actually say. Treat
   this list as authoritative; extend it as new patterns appear.

   | Noun in `system_name` | Verb | Reasoning |
   |---|---|---|
   | `Roadmap` | plans | A roadmap is a planning artefact |
   | `Inventory` | tracks | What you do with an inventory is track stock |
   | `Ledger` | records | A ledger records transactions |
   | `Directory` | lists | A directory lists entities |
   | `Registry` | registers | A registry registers entries |
   | `Pipeline` | moves | A pipeline moves work through stages |
   | `Catalog` | lists | A catalogue lists items |
   | `Calendar` | schedules | A calendar schedules events |
   | `Knowledge Base`, `KB` | answers | A KB answers questions |
   | `Dashboard` | surfaces | A dashboard surfaces metrics |
   | `CRM` | tracks | Customer relationship tracking |
   | `Helpdesk`, `Service Desk` | resolves | A helpdesk resolves tickets |

   Example: `system_name = "Product Roadmap"` matches `Roadmap` in
   Tier 2 → "The Product Roadmap model **plans** how every idea
   moves from intake through scoring and release commitment to a
   shipped feature ..."

   **Tier 3: Fallback palette.** Only when neither Tier 1 nor Tier
   2 fires, pick from `captures`, `holds`, `describes`, `lays out`,
   `organises`, `maps`. The fallback should be **rare**. If you find
   yourself reaching for it, pause and ask: "what does an operator
   actually *do* with this thing?" If a single verb captures it
   (even informally), prefer that verb and add it to the Tier 2
   table for future runs. If neither tier fires and no domain verb
   feels obvious, surface a one-line confirmation to the user
   before writing files: `"No clear domain verb in '<system_name>';
   using '<fallback>'. Override with a different verb, or proceed?"`

   The Tier 3 fallback palette has six options so even genuinely
   verbless system names do not all read the same.

   #### Worked examples (use as shape templates, not for verbatim
   copy)

   **Applicant Tracking** (verb extracted: track)

   > The Applicant Tracking model tracks every step of a hire, from
   > first application to recorded acceptance. The Applicant
   > Tracking Skill teaches an agent how to use that model to track
   > candidates through the funnel reliably and the same way every
   > time, so the right pieces always get filled in in the right
   > order. Without it, an offer can go out with no recorded
   > approver; a rejection can land with no reason on file and
   > quietly blank the funnel report; a candidate can accept while
   > the requisition stays open and get pulled into another pipeline
   > by mistake.

   **Workforce Planning** (verb extracted: plan)

   > The Workforce Planning model plans how the team grows across
   > scenarios and the positions a committed scenario will create.
   > The Workforce Planning Skill teaches an agent how to use that
   > model to plan headcount across scenarios and walk an approved
   > scenario into real seats reliably, with the right paired
   > updates and the right handoff to the recruiting team. Without
   > it, a plan can be marked approved with no record of who signed
   > off; two people can end up assigned to the same seat; an
   > approved scenario can sit dormant while the real positions
   > never get created.

   **Zero-Based Budgeting** (verb extracted: budget)

   > The Zero-Based Budgeting model budgets every line item from
   > scratch each cycle, with the assumptions behind each number.
   > The Zero-Based Budgeting Skill teaches an agent how to use
   > that model to budget a fresh cycle reliably, with assumptions
   > captured alongside the numbers and the prior cycle's reasoning
   > still readable when someone asks. Without it, a budget line
   > can land with no recorded assumption; a justification from
   > last cycle can quietly carry over without being re-examined; a
   > cut can ship without naming who approved it.

   **Product Roadmap** (Tier 2: `Roadmap` → plans)

   > The Product Roadmap model plans how every idea moves from
   > intake through scoring and release commitment to a shipped
   > feature, with the rationale weighing each one and the release
   > it lands in. The Product Roadmap Skill teaches an agent how
   > to use that model to plan a feature from intake through to a shipped
   > release reliably, without the handoffs between PM, design, and
   > engineering quietly going missing. Without it, an idea can get
   > scheduled with no recorded owner; a release can ship with
   > features still marked "in design"; a deferred feature can lose
   > the rationale that explains why it slipped.

   #### Hard bans (literal scans before declaring done)

   - Any snake_case or identifier-shaped token (`approved_at`,
     `originated_from_action_id`, `*_id`, `*_at`, `*_by_*`).
     Implementation, not value.
   - Mechanics jargon: `writes`, `rows`, `calls`, `PATCH`, `POST`,
     `API`, `schema`, `column`, `FK`, `foreign key`, `constraint`,
     `uniqueness`, `join`, `table`, `query`, `back-pointer`,
     `cascade` (the noun).
   - LLM-engineer language: `non-deterministic`, `stochastic`,
     `improvises`, `drift between runs`, `reproducible output`.
     Catalog readers do not think of agents that way.
   - Band-aid framings: "the platform does not enforce", "the
     database does not catch", "multi-step writes that aren't
     enforced". These frame the skill as patching a defect.
   - The phrase "this skill" anywhere; the literal front-matter
     `description` copied verbatim; `use-semantius`; CLI commands;
     file paths; code fragments.
   - Schema-cased entity names: "Position" not `positions`,
     "Interview Feedback" not `interview_feedback`. Use the model's
     `singular_label` values.
   - Verb-list rephrasing of the trigger bullets ("approving plans,
     opening requisitions, filling positions, onboarding new
     hires"). The bullets render right below; do not echo them.
   - The literal phrase "lays out what the system can record". That
     was the example, not a template; paraphrase based on the
     model's actual flavor.

   #### Required ingredients

   - The three-noun definition: the model paragraph names the model
     and its verb, the skill paragraph names the skill by title and
     the value-prop ("teaches an agent how to use that model to do
     its jobs reliably and the same way every time"), the failure
     paragraph names two or three concrete bad days.
   - Domain verb extracted from `system_name` per the rule above
     (or fallback palette if no verb is hiding).
   - Bridge to the previous paragraph by reusing a noun from its
     last clause (records, plans, ideas, contracts, the funnel,
     etc.). Do not start cold.

   #### The acceptance tests

   1. **Pattern test.** Replace the model name with "X" everywhere
      in the paragraph. If the result reads as something that could
      apply to any of the other skills in the catalog, the paragraph
      is too generic; the verb-extracted noun and the failure modes
      should make it unmistakably about this one model.
   2. **No-duplication test.** Place the paragraph above the
      rendered trigger bullet list. If any sentence reads like a
      paraphrase of the bullets, replace it.
   3. **Coffee test.** Read aloud as if to the operator the model
      describes (recruiter, planning lead, controller, support
      engineer). If they would squint at any sentence, rewrite.
4. **Sample prompts.** A bulleted list of **every** trigger phrase
   from the SKILL.md frontmatter `description`, verbatim and quoted,
   one per bullet, in the same order they appear in the description.
   Do not pick a subset. Do not paraphrase. If the description has
   ten quoted phrases, the bullet list has ten bullets. Sample
   prompts come **before** the capability list because catalog
   readers recognize and resonate with user-voice phrasing faster
   than verb-phrase capability bullets; the prompts pull the
   reader in, and the capability list gives them the scope check
   they want next.
5. **What it covers.** A short bulleted list (5–7 bullets, each a
   verb phrase under ~12 words) summarizing the capability scope
   of the skill. Pulled from the JTBD section titles plus the
   Common-queries appendix, grouped and condensed. Each bullet
   names a capability in plain domain words, no script names, no
   file paths, no jargon. The list functions as the catalog
   reader's scope check after the sample prompts hook them: "the
   prompts feel right, but does it actually do what I'd want?"
   See "What it covers, content rules" below for shaping
   guidance.
6. **Semantic model.** A Mermaid diagram copied verbatim from the model
   (see Mermaid section below).

#### README.mdx template

````mdx
---
title: <Heading text, see "Title grammar" below>
description: <One sentence, ≤140 chars. Shape: "<Extracted-verb>s <domain object> <list of lifecycle stages, operations, or artefacts in plain words>." Verb-led, names the actual nouns of the domain. No "so [benefit]" clause. No "Bakes in", no mechanics jargon, no snake_case, no "this skill", no em-dashes.>
---

# <Heading text, same as front-matter title, must contain "Skill">

<Verbatim copy of the model's §1 narrative paragraph(s). Ignore the
`domain` frontmatter field entirely (it is a short category tag like
ATS, CDP, ERP, never a description). No paraphrase, no code, no CLI,
no enum names.>

<Skill explanation paragraph: 2 to 4 sentences expanding the
front-matter `description` into prose for a human. Same value-prop,
not the same words. Mentions concrete domain nouns. Does not say
"this skill". Does not mention `use-semantius`, CLI, or harness
plumbing. Explains what loading this skill enables on top of the
system the previous paragraph described.>

## Sample prompts

- "<phrase 1 from SKILL.md description, verbatim>"
- "<phrase 2 from SKILL.md description, verbatim>"
- "<phrase 3 from SKILL.md description, verbatim>"
- ... (one bullet per quoted phrase in the SKILL.md description, no subset)

## What it covers

- <verb-phrase capability 1, e.g. "Move candidates through requisitions, applications, interviews, offers, and hires">
- <verb-phrase capability 2>
- <verb-phrase capability 3>
- ... (5–7 bullets total, see "What it covers, content rules" below)

## Semantic model

```mermaid
<Mermaid diagram, see "Mermaid diagram" below>
```
````

That is the entire README. Six elements only: front-matter, heading,
model description (verbatim from §1), skill explanation paragraph
(prose expansion of the front-matter description), sample prompts,
what it covers, mermaid diagram. **Do not add** any other section,
including "When to use it", "What's inside", "Generated from", or
"About".

#### What it covers, content rules

The `## What it covers` section is the catalog reader's scope check.
It comes **after** the sample prompts (which hook recognition) and
**before** the diagram (which is the visual model). Five rules
shape it:

1. **5–7 bullets.** Fewer reads as too thin; more reads as a
   feature dump and starts to compete with the prompts for
   attention. If the source has 10+ JTBDs, group them.
2. **Each bullet is a verb phrase under ~12 words.** Lead with a
   verb in the same Tier 1 / 2 / 3 family as the front-matter
   description's verb (no need to repeat the exact verb on every
   bullet, but stay in the family of action verbs the domain
   uses). Examples: "Deploy, return, and retire hardware
   assets"; "Install and uninstall software with license seat
   tracking"; "Receive purchase orders"; "Renew contracts".
3. **Group related JTBDs into single bullets when natural.**
   Deploy + return + retire collapse to one bullet ("Deploy,
   return, and retire hardware assets"); install + uninstall
   collapse to one ("Install and uninstall software with license
   seat tracking"). Do not split for the sake of bullet count.
4. **Common queries get one rolled-up bullet at the end.**
   Format: "Common reports: <list 3–5 query themes in plain
   words>". Example: "Common reports: asset count by status,
   contracts expiring, license utilization, spend by cost
   center". Do not list each query separately; that bloats the
   list and competes with the JTBDs for attention.
5. **No script names, no file paths, no jargon.** "Renew
   contracts" is good; "renew-contract.sh" is bad; "materialize
   the renewal handoff" is bad. The reader is non-technical;
   they care about what the skill *does*, not how the generator
   classified it.

The list is sourced from the JTBD section titles plus the Common-queries
appendix. Walk the JTBDs in the order they appear in the SKILL.md, group
adjacent related ones, render each group as a verb-phrase bullet, then
append the rolled-up "Common reports" bullet last. Keep the order from
the SKILL.md so the catalog list and the SKILL.md sections agree on
narrative flow.

#### Title grammar

This rule governs **two places** in the README.mdx that must carry
the same text: the front-matter `title` and the H1 heading. Both
**must** contain the word "Skill" with a capital S, written as a
standalone word (never "domain skill", never "Skill that…", never
lowercased).

The SKILL.md H1 is a **different** heading, governed by its own rule
(see the SKILL.md template above): it is `system_name` verbatim, no
"Skill" suffix, because the file is named `SKILL.md` and repeating
"Skill" in the heading is redundant. Title grammar does **not**
apply to the SKILL.md H1.

Algorithm:

1. Start with `system_name`.
2. If it ends in the word "System" (case-insensitive), drop that
   trailing word. Reason: appending "Skill" to a name that already
   ends in "System" produces "...System Skill", which reads as two
   nouns colliding. Resolve the collision in favor of "Skill",
   because "Skill" is the catalog's anchor word and every entry
   carries it; "System" is the one that drops. So "Applicant
   Tracking System" becomes "Applicant Tracking".
3. Append " Skill".

Examples:

| `system_name`             | Title                       |
|---------------------------|-----------------------------|
| Applicant Tracking System | Applicant Tracking Skill    |
| Workforce Planning        | Workforce Planning Skill    |
| Product Roadmap           | Product Roadmap Skill       |
| Customer Relations        | Customer Relations Skill    |
| CRM                       | CRM Skill                   |

If the resulting title reads awkwardly to a fluent English ear (rare,
flag it to the user), prefer rewording the system_name itself in the
model file rather than dropping "Skill" from the title. "Skill" is
the catalog's anchor word; humans scanning the list expect every
entry to have it.

#### Mermaid diagram

**Copy the mermaid block from the source model file verbatim.** The
semantic model already authors a domain-map mermaid diagram (it is
produced by `semantic-model-analyst` and is the single source of
truth for the entity layout). Locate the existing ```` ```mermaid ````
fenced block in the model file and paste it under `## Semantic model`
unchanged.

Do **not** generate a new diagram from the model's entity list and
FK section. Do **not** apply your own layout, labels, or grouping.
Any deviation from the model's diagram causes the README to drift
from the model the next time someone updates the model file.

If the model file has no mermaid block at all (rare; flag this to the
user as a model defect), omit the `## Semantic model` section entirely
and note in the Step 10 summary: `Model file has no mermaid block;
omitted Semantic model section. Ask <semantic-model-analyst> to add one.`

### Step 9, Self-review pass

Before printing the summary, re-read the SKILL.md you just wrote with
fresh eyes, as if a colleague were going to use it tomorrow against a
different model. The point is not a checklist; it is that small
drafting errors here scale, because every future invocation of the
generated skill pays the cost. Fix issues in place; surface anything
you can't fix without a design change in the Step 10 summary as a
known limitation.

Run the pass against the principles below. Principle 0 is a
structural-compliance check that runs **first** because it catches
the single most common defect from prior generations: skipping Pass 3
entirely and emitting a monolithic SKILL.md. The remaining principles
are *examples* of what to look for, drawn from defects observed in
prior generations, they are not exhaustive, and the principle is
what should drive the review on a new model where the specific defects
may be different.

**0. Pass 3 was actually applied (structural compliance).** Run this
check **before** anything else. It is mechanical and detects the
"agent skimmed past the classification step" failure mode that has
caused more re-runs than every other defect combined.

Walk every `### <JTBD>` heading in the SKILL.md body. For each one,
locate its `**Recipe:**` block and apply this rule:

- *Pointer form is one line.* The acceptable shapes are exactly:
  `**Recipe:** see [`references/<slug>.md`](references/<slug>.md).`
  or `**Recipe:** run \`scripts/<slug>.sh <args>\`.` plus optional
  one-sentence elaboration about exit codes.
- *Inline form is ≤5 lines of bash inside a single fenced code block,
  no `# Step N:` comments, no branching prose between steps.* If the
  recipe block has step comments, multiple `semantius call`
  invocations in sequence, or paragraphs of "if X, refuse" between
  bash lines, it is **not** inline. It belongs in
  `references/<slug>.md` and the SKILL.md body must shrink to the
  pointer form.

Count the JTBDs that violate one of those shapes (call this `V`) and
the JTBDs Pass 3 classified as `inline` (call this `I_classified`).
If `V > 0` **or** `V != I_classified`, Pass 3 was bypassed. Stop the
self-review. Go back, re-classify the violating JTBDs as `reference`
or `script`, write the corresponding files in `references/` or
`scripts/`, and replace the inline body in SKILL.md with the pointer
form. Then re-run this check from the top. Do not advance to
Principle 1 until `V == I_classified`.

Two separate count-based enforcements, applied after the per-JTBD
shape check:

- *Zero `references/` files with 5+ JTBDs:* unusual but not
  automatically wrong. Verify by walking each JTBD's body and
  confirming none of them carries a "ask the user before X"
  branch. Most domains have at least one such branch (charging to
  an inactive cost center, rewriting committed history, deleting
  with cascade). If you find one, it is a reference; promote it.
- *Zero `scripts/` files with 5+ JTBDs:* almost certainly a
  misclassification. Walk each reference and apply the
  "user-prompt branch" test from Pass 3: does this recipe actually
  need the *agent* to ask the *user* something, or does it just
  read, compute, validate, and write? If the latter, demote it to
  a script. Composition rules and computed-value recompute do not
  count as user-prompt branches; they are mechanical and belong in
  scripts. Cascade flows almost always belong in scripts.

**1. Self-contained at runtime.** The calling agent should never need
to consult the **source model file** or a deployment-specific config
to execute a recipe, the whole point of generating this skill is to
condense the model's domain facts (enums, FK shapes, label rules,
required fields) into the SKILL.md so the model file doesn't have to
load alongside.

`use-semantius` is the deliberate exception. It loads alongside this
skill by design and owns the platform mechanics, CLI install, env
vars, PostgREST URL-encoding, schema-management tools, cube query
DSL. Pointing to a `use-semantius` reference for *platform* concerns
(e.g. "see `references/cube-queries.md` for date filtering syntax")
is correct and not a punt. Pointing to it for *domain* facts the
generator should have resolved (an enum value, a FK target, a
required-on-create field set) is a punt, fix those.

Three things to scan for:

- *Hardcoded literals that will rot.* Dates, timestamps, ids, the
  generation year, anything that was correct only at write time.
  Every such literal in a recipe body must become a placeholder
  (`<current ISO timestamp>`, `<today's date, YYYY-MM-DD>`,
  `<feature_id>`) with a one-line note telling the agent to fill it
  at call time. Hardcoded timestamps are the most common offender ,
  search for them explicitly even if you don't think you wrote any.
- *Verbatim-copied content matches the source.* The README's body
  §1 paragraph(s) and the `## Semantic model` mermaid block are
  byte-copied from the model. Re-open the model file and diff
  these two regions against the README; any difference means the
  generator paraphrased instead of copying (defect, fix in place).
  This is the same check Step 4's drift pass runs on
  already-generated skills; on a fresh write it catches the
  generator paraphrasing through habit even though Step 2 had the
  source loaded.
- *Recipes that punt.* If a JTBD ends with "see `use-semantius` for
  the path" or "look up X in references/Y.md", the bake-in failed.
  Either resolve the value now (re-read the model and the use-semantius
  references) or, if it truly isn't knowable at generation time, keep
  the punt explicit and reconsider whether the JTBD passes the Step-2
  merit test. A JTBD that just redirects fails the test, drop it and
  say why in the Step 10 summary.

**2. Each fact lives in one place.** Restating the same rule in two
sections doesn't reinforce it; it creates drift. Re-read the SKILL.md
asking: *if this rule changed, how many places would I need to edit?*
The answer should be one.

- Cross-cutting rules belong in **Guardrails**; JTBD-specific recovery
  belongs in that JTBD's **Failure modes**. If the same sentence
  appears in both, delete one.
- Composition rules for caller-populated labels (`{user} → {feature}`)
  belong in *one* JTBD plus a one-line glossary pointer, not verbatim
  in three places.
- "What this skill does NOT do" is about scope (unbuilt features,
  out-of-domain tasks), not correct usage. If a bullet there overlaps
  with a guardrail, trim whichever side restates the other.

**3. No surprises in the cheap-to-read parts.** The glossary, enums,
and Cross-cutting data rules are skimmed first; the per-JTBD
reference files (with their FK & shape assumptions and extended
failure modes) are read on demand. Anything that will *surprise*
the calling agent at write time should surface in whichever layer
the agent reads before the surprise can bite, cross-cutting
surprises in SKILL.md, JTBD-local surprises at the top of the
reference file's recipe.

- Unique constraints on natural keys (e.g. `tag_name` unique).
- Delete behaviors that block writes (e.g. `restrict` on `author_id`
  means deleting a user with comments fails).
- Required caller-populated labels on junction or sub-entities.
- Built-in Semantius tables that overlap with declared entities (the
  model's §8 flags this, commonly `users`). The calling agent must
  not POST to a duplicate table.
- Internal contradictions: re-read the "auto-managed fields"
  paragraph against every POST recipe. If any recipe POSTs a `*_label`
  value, the auto-managed paragraph must carve those fields out
  explicitly; otherwise an agent skimming the glossary will conclude
  it can omit them.

**4. Recipes match the platform conventions.** The use-semantius
references encode how the platform actually works; the generated
skill should follow the same patterns so it composes cleanly.

- Fuzzy text search uses `search_vector=wfts(simple).<term>`, never
  `ilike` or `fts` (those bypass the search index).
- Field-equality (`<column>=eq.<value>`) is for known-exact values
  (ids, enums, unique keys), not banned, just a different tool than
  fuzzy search.
- Read-before-write on junctions without DB-level uniqueness.
- Audit-logged tables don't need explicit audit writes; recipes don't
  manage them.
- **No recipe re-derives a `computed_fields[].name`.** Walk every
  POST/PATCH body in every reference and inline recipe; if any of them
  writes a column listed under "Platform-derived fields" in the SKILL.md
  preamble, the recipe is wrong (the platform overwrites it). Drop the
  field from the body. The post-write read-back is fine and encouraged.
- **No recipe pre-validates a `validation_rules[].code`.** Walk every
  reference's branching prose; if it duplicates a check the platform
  already enforces (e.g. "refuse to attach a release_id when status
  isn't planned/in_progress/shipped" when `release_only_when_committed`
  is in the model), drop the client-side check and rewrite the JTBD's
  Failure modes block to name the platform `code` and the recovery
  action instead. Duplicated checks are brittle and confuse the agent
  about who owns the rule.
- **No recipe duplicates a `select_rule` in its own filter** (analyst
  v2.2+). Walk every GET path against an entity that appears in the
  `row_visibility_rules` index. If the path adds a filter that
  re-encodes the rule (e.g. `submitter_user_id=eq.$user_id` against an
  entity whose `select_rule` already filters on the same column), drop
  the duplicate filter. The platform applies the rule via RLS; the
  client-side duplication is dead code that breaks the moment the
  analyst updates the rule. Recipes against a scoped entity should
  read with the natural query and let the platform filter; the
  user-facing scope reminder lives in the JTBD preamble (sourced from
  the SKILL.md "Row-level read scope" block).
- **Every read recipe against a row-scoped entity carries a visibility
  callout**. For every JTBD whose Recipe reads an
  entity that appears in the `row_visibility_rules` index, the JTBD's
  preamble or Inputs block must contain a one-sentence scope reminder
  ("every caller with `view_permission` sees only rows where `<plain-
  English uniform predicate>`"). A read recipe on a scoped entity
  without that reminder is the silent-empty-result defect: a missing
  row is indistinguishable from no-such-row, and the agent (or the
  user) draws the wrong conclusion. Pull the scope sentence from the
  SKILL.md "Row-level read scope" preamble.
- **No recipe promises a `view_all_<plural>`-style permission bypass**
 ) critical rule). Walk every preamble line, every JTBD
  visibility callout, every Failure-modes block. If any prose names a
  permission code as a way to "see every row" / "bypass the filter" /
  "broader read access" / "elevated tier" / similar, the corresponding
  `Select rule` JsonLogic must literally reference that permission code
  via `{"require_permission": "<code>"}` or an equivalent platform
  operator AND the model's §7 must resolve the architectural decision.
  A prose claim about permission bypass with no JsonLogic reference
  and no §7 entry is the **canonical v2.2 defect** the audit exists to
  catch — the prose promises something the platform does not honor,
  and the calling agent ships with broken RBAC. Fix by either deleting
  the bypass prose (rule applies uniformly; broader access goes through
  human escalation), pointing at a real documented mechanism from §7,
  or routing the user back to `semantic-model-analyst` to resolve
  Stage 12 / Stage 12.5 properly.
- **Every transition JTBD that fires a `conditional_required_fields`
  trigger writes the dependent field in the same PATCH** (analyst
  v2.2+). Walk the `conditional_required_fields` sub-index from Step 2.
  For every `(entity, trigger_field, trigger_value, dependent_field)`
  tuple, find the JTBD whose Recipe PATCHes the trigger field to the
  trigger value. The Recipe body must include the dependent field in
  the same PATCH body. A transition that sets the trigger without the
  dependent is the silent-empty-housekeeping-field defect — the UI
  would have rendered `dependent_field` as `required` at form time, but
  the API recipe has no form. Fix: add the dependent to the PATCH
  body with the correct value (typically `$now` for `*_at` fields,
  `$user_id` for `*_by` fields).
- **No recipe interprets the JsonLogic of an `input_type_rule`** (analyst
  v2.2+). The rule is for the form-rendering layer, not for the recipe.
  Recipes drive their transition semantics from the JTBD's own intent
  (the analyst's prose, the `validation_rules`, the trigger condition
  captured in `conditional_required_fields`), not by re-evaluating the
  `input_type_rule` body. A recipe with a branch like *"check whether
  `input_type_rule` would have rendered this field as `hidden` for the
  current record"* is wrong — drop the branch, let the recipe's own
  preconditions decide.

If a new platform convention shows up in the use-semantius references
that this list doesn't mention, treat the principle ("match the
platform") as the authority and add the new convention to the recipes ,
the bullets above will lag.

**5. Recipes are reproducible.** Two callers given the same inputs
must produce byte-identical output. Most "weird drift" bugs in
generated skills trace to phrases that *seem* deterministic but are
not.

- *Composition rules are exact.* For every caller-populated label
  field (`*_label` on a junction or sub-entity), the rule names a
  precise algorithm: separator characters (with whitespace),
  cut points (column counts on which side of which boundary),
  fallback when the input is shorter than the cut, casing.
  Phrases like "first ~80 characters", "trim at a word boundary
  if possible", "approximately N", "around" are bans, replace with
  rules a script could implement: "first 80 chars of `comment_body`;
  if char 80 falls mid-word, cut at the last space at or before
  position 80; if the body was longer than the cut, append the
  literal `…` (U+2026), no trailing space."
- *Symbols are consistent across the file tree.* If the composition
  uses ` -> ` (ASCII), every example, every guardrail, every
  validation note uses ` -> `; do not mix ASCII and Unicode arrows
  (`→`), do not switch separators between examples
  (` / `, ` | `, ` -> `). Pick one set per skill and apply.
- *Computed values specify rounding.* A formula like
  `(reach * impact * confidence) / effort` over a `numeric(p, s)`
  column with `s = 2` requires the recipe to round to 2 decimals
  before the PATCH; otherwise the float-to-stored cast truncates
  the value and the `Validation` post-condition ("`rice_score`
  equals the formula") fails on a tiny rounding diff. Name the
  scale and the rounding behavior in the recipe.
- *Side-effect timestamps are placeholders.* Every `*_at`,
  `*_date`, `submitted_at`, `voted_at`, `posted_at`,
  `actual_release_date` field in a recipe body is a placeholder, the
  rule lives once at the SKILL.md top level, the per-JTBD reminder
  has been deleted. Re-search the file tree for hardcoded ISO dates
  and ISO timestamps; any hit is a defect.

**6. Cross-section coherence.** Each fact stated in one place must
not be silently contradicted in another.

- *Inputs tables match routing rules.* If a JTBD's prose says "for
  status X, route to JTBD Y instead", then X must not appear in
  this JTBD's `Inputs` table as a valid value. The contradiction
  forces the agent to guess. Drop X from the table and say outright
  which targets this JTBD owns.
- *Cube queries reference columns the glossary names.* If `Common
  queries` uses `<Entity>.sum_<column>` or `<Entity>.<dimension>`,
  the underlying column must appear in the glossary, in some
  reference file's FK & shape assumptions, or in the "what the
  entity carries" line. A query mentioning
  `Features.sum_estimated_cost` with no `estimated_cost` named
  anywhere else in SKILL.md leaves the agent unable to verify the
  field exists; it will guess and write a query that 500s.
- *SKILL.md outlines and reference files agree on the recipe shape.*
  Open the reference file and read its `## Recipe`. The steps,
  the writes, and the validation must match what SKILL.md's
  `Validation` and `Failure modes` summary claim. If the SKILL.md
  failure-modes mentions a `409 on <column>` and the reference
  recipe never POSTs to that column, one of them drifted; fix.
- *Reference-file slugs match SKILL.md links.* For every
  `references/<jtbd-slug>.md` link in SKILL.md, the file exists at
  that exact path. For every reference file written, the SKILL.md
  links to it. List both sets and diff.
- *Script names match SKILL.md invocations.* For every
  `scripts/<op-slug>.sh` mentioned in a SKILL.md `Recipe:` line,
  the script exists, and its `Usage:` comment matches the args the
  SKILL.md tells the agent to pass.
- *Every trigger phrase in the description is answerable from
  what the skill already provides.* For every quoted phrase in
  the SKILL.md frontmatter `description`, the agent must be able
  to fulfill it from one of:
  (1) a JTBD section in `## Jobs to be done` (the trigger maps to
  a recipe),
  (2) a literal example in the `## Common queries` appendix (the
  trigger is essentially that query),
  (3) the established pattern in the Common-queries appendix the
  agent can adapt (e.g. swap a measure or filter; appendix
  examples are intentionally pattern-establishing, not exhaustive),
  (4) the `## Lookup convention` block (e.g. "who has asset X" →
  `serial_number=eq.X&select=current_user_id`; this works as
  long as the convention block names the column).
  Each backing type is legitimate; the goal is not 1:1 recipe
  coverage, it is that an agent with the skill loaded does not
  have to guess column names, FK shapes, or query shapes from
  outside the skill. Triggers backed by (2)–(4) are not a
  fallback; they are an **encouraged** pattern. See Step 5
  "Trigger phrasing" for the action-vs-discovery split: a healthy
  description carries both, because discovery triggers (lookups
  and reports) are how the catalog reader sees the breadth of the
  model, and they are how the skill makes those queries
  deterministic for users who install it.
  A trigger fails this check only when none of (1)–(4) applies:
  the agent would have to invent a recipe, infer a relationship
  the skill never names, or look up enum values not in the
  glossary. In that case the fix is one of two things: (a) drop
  the trigger from the description and the README's sample
  prompts; (b) add the missing backing (usually one new
  Common-queries example, occasionally a new JTBD if the merit
  test passes, or a one-line addition to the lookup convention).
  Run this check **before** the README cross-check so the catalog
  list inherits a clean trigger set.

**7. Scripts handle real-world inputs.** Pre-existing structural
checks pass on scripts that would still 4xx in production the moment
a real catalog name with a space hits them. Walk every file in
`scripts/` AND every inline bash recipe in SKILL.md and run these
literal-text scans. Each is mechanical and detects a class of bug
the earlier principles miss because the offending lines look fine
in isolation.

- *Raw `$var` interpolation into a URL path.* Regex-scan every
  `semantius call crud postgrestRequest "{...}"` invocation for
  `$<varname>` or `${<varname>}` appearing inside a `path` value
  in a position that is **not** preceded by an `=eq.` against a
  known-UUID variable (`id`, `<entity>_id`). Every other
  interpolated value (search terms going into `wfts(simple).<term>`,
  exact-match filters whose value is a caller string like
  `alias_name=eq.<value>` or `relationship_verb=eq.<value>`, value
  lists in `in.(...)` filters) must come from a pre-encoded
  variable produced by `printf '%s' "$raw" | jq -sRr @uri`. A line
  that interpolates raw `$user_input` into the URL is a defect.
  Most catalog names contain spaces (`Customer Management`,
  `Investment Banking`, `Service Desk`); raw interpolation silently
  mangles them. Fix in place: introduce `enc_<name>=$(printf '%s'
  "$raw_<name>" | jq -sRr @uri)` and reference `${enc_<name>}` in
  the path.
- *String-concatenated JSON bodies.* Scan every script for the
  shapes `body="{` or `body="$body,` or any line that builds a
  JSON body by appending interpolated `"$var"` fragments. Every
  body must be built with `jq -nc --arg <key> "$<var>" ...
  '{...}'`. The naïve concatenation pattern fails the moment a
  caller value contains a `"`, a `\`, a newline, or a control
  character; research-agent prose is full of these. The platform
  surfaces a generic JSON parse error rather than the validation
  error the recipe was trying to test. Fix in place: rewrite the
  body using `jq`, using `--argjson` for booleans / numbers /
  nested objects and `--arg` for strings.
- *Optional columns written without a per-entity guard.* For every
  script that accepts an optional arg corresponding to a column
  (`notes`, `description`, `condition_notes`, `is_preferred`, any
  arg whose name matches a column on *some* but not *all* targeted
  entities), walk back to the model's per-entity field list (from
  Step 2's parse) and confirm the script enforces the entity-
  carries-this-column check before composing the body. A
  polymorphic script that unconditionally writes `notes` against an
  `entity` arg will 4xx on every entity that lacks a `notes` column;
  the platform's `column "notes" does not exist` response is opaque
  to the agent. Fix in place: bake the supports-column entity list
  into the script (computed at generation time from the model's §3)
  and refuse the caller's arg with a precise stderr message when
  the target entity does not carry the column. The Step 7 template
  shows the canonical case-statement form.
- *`--single` vs array misuse on caller-driven lookups.* For every
  fuzzy `wfts(simple).<term>` read, the recipe's intent is one of
  two things, "the term must resolve to exactly one row or the
  recipe cannot proceed" (use `--single` with a one-line guard) or
  "zero matches is a normal branch, ambiguous needs the candidate
  list" (use array-default with a two-step body inspection). Mixing
  these silently mis-reports: a `--single` read on an ambiguous
  match exits 2 (which the script may handle as "platform error"
  rather than "user must disambiguate"); an array read whose code
  path assumes `--single`'s bare-object shape mis-parses every row.
  Fix in place per the use-semantius `Pattern A` / `Pattern B`
  convention.

The fix for each defect is in-place rewriting of the offending
script lines, not "flag in summary and ship". Step 9 is a gate, not
a status report. Re-run this principle until every script passes
all four scans.

**Final pass: read it cold.** After applying principles 1–7, set the
files aside for a moment, then read SKILL.md top-to-bottom as if
encountering it for the first time, and skim each reference file
once. Where you backtrack, re-read, or pause to figure out what a
sentence means, the writing is doing more work than it should. The
specific defects that show up here are usually patterns the earlier
principles missed because they were too local: a glossary that
introduces a term still used unexplained in a JTBD three sections
later, a guardrail that contradicts a JTBD's failure-mode recovery,
a "see X" pointer where X never quite delivers what the pointer
promises. Tighten in place.

---

**README cross-check.** The README is for humans browsing a catalog,
so different failure modes apply. Run these as literal-text scans, not
vibes. If any check fails, fix and re-scan before declaring done.

1. **File exists.** Both `SKILL.md` and `README.mdx` are present in
   the target folder.
2. **Em-dash scan.** Literal-search the README for Unicode codepoint
   U+2014 (the em-dash, the long horizontal dash, distinct from the
   shorter hyphen `-` and en-dash `–`). Must be zero hits. Replace
   each with commas, colons, parentheses, or split sentences. The
   user has flagged em-dash use repeatedly.
3. **"this skill" scan.** Literal-search the README (case-insensitive)
   for the substring "this skill". Must be zero hits. Rewrite any
   sentence that uses it. The catalog renders many cards side by side
   and "This skill helps with..." openings make the list unreadable.
4. **Headings: one rule per file, do NOT make them match.**
   - **SKILL.md H1**: must equal `system_name` verbatim. No "Skill"
     suffix (the file is `SKILL.md`, the word would be redundant), no
     "domain" prefix, no rewording. For `system_name = "Applicant
     Tracking System"` the only valid SKILL.md H1 is `# Applicant
     Tracking System`.
   - **README.mdx H1 and front-matter `title`**: must be identical to
     each other and must follow Title grammar: contain "Skill" with
     capital S as a standalone word, no "domain" anywhere, no
     lowercased "skill", trailing "System" dropped from `system_name`
     before " Skill" is appended. For the same `system_name` the only
     valid README H1 is `# Applicant Tracking Skill`.

   Reject for the README: `# Applicant Tracking System Skill`,
   `# Applicant Tracking System domain skill`, `# Applicant Tracking
   System`, `# Applicant Tracking domain skill`, and any other
   variant. Reject for the SKILL.md: anything that adds "Skill",
   "domain", or rewords the system name.
5. **Model description paragraph is verbatim from §1.** The first
   body paragraph(s) under the heading are a verbatim copy of the
   model file's §1 narrative. Diff against the source model. No
   paraphrase, no summary.
   - **No orphan `domain` line.** The `domain` frontmatter is
     ignored when building the README body (it is always a short
     category tag like `ATS`, `CDP`, `ERP`). If the README starts
     with such a short word or acronym on its own line under the
     heading, the `domain` tag was wrongly pasted as a body
     paragraph. Delete it. The §1 narrative is the only source for
     this section.
6. **Skill explanation paragraph passes the non-technical reader
   test AND does not duplicate the trigger list.** Verify there is
   a second paragraph between the model description and `## Sample
   prompts`. Run these literal scans on that paragraph; any failure
   means rewrite, not patch:
   - **Not a copy of the front-matter `description`.** Diff against
     the front-matter `description`. They must share the value-prop
     but not the words.
   - **Three-noun definition is present.** Sentence 1 names the
     model and what it tracks/plans/manages/captures (model). The
     skill is named by its title (not "this skill") and explained
     as "teaches an agent how to use that model to <verb> <its
     jobs> reliably and the same way every time". The paragraph
     ends with two or three concrete failure modes.
   - **Domain verb extracted from `system_name` (three-tier).**
     Run the three-tier resolution and verify the verb actually
     used in sentence 1 matches.
     - **Tier 1 fail:** if `system_name` ends in
       `Tracking|Tracker|Planning|Planner|Management|Manager|Budgeting|Scheduling|Scheduler|Forecasting|Reporting|Monitoring|Routing|Booking|Provisioning`,
       the bare verb (track, plan, manage, budget, schedule,
       forecast, report, monitor, route, book, provision) must
       appear in sentence 1.
     - **Tier 2 fail:** if `system_name` contains
       `Roadmap|Inventory|Ledger|Directory|Registry|Pipeline|Catalog|Calendar|Knowledge Base|KB|Dashboard|CRM|Helpdesk|Service Desk`,
       the corresponding implied verb (plans, tracks, records,
       lists, registers, moves, lists, schedules, answers,
       surfaces, tracks, resolves) must appear in sentence 1.
     - **Tier 3 misuse:** using a fallback verb (`captures`,
       `holds`, `describes`, `lays out`, `organizes`, `maps`) when
       Tier 1 or Tier 2 would have fired is a fail. Rewrite using
       the matched verb. The verb in the front-matter `description`
       must be the same.
   - **Pattern test (catalog uniqueness).** Mentally substitute
     "X" for the model name everywhere in the paragraph. The result
     must NOT read as something that could apply to any other skill
     in the catalog. The verb-extracted noun and the failure stories
     should make the paragraph unmistakably about this one model.
     Generic openers like "The system has a handful of multi-step
     moves", "Loading the domain knowledge means", "Multi-step
     writes are not enforced" are a fail.
   - **No duplication of the trigger bullet list.** Read the
     paragraph and the rendered `## Sample prompts` list together.
     Comma-strung verb lists that mirror the bullets are a fail.
   - **No band-aid framing.** Phrases like "the platform does not
     enforce", "the database does not catch", "multi-step writes
     not enforced" frame the skill as patching a defect. Replace
     with the positive three-noun definition.
   - **No LLM-engineer language.** Scan for "non-deterministic",
     "deterministic", "stochastic", "improvises", "drift between
     runs", "reproducible output". Catalog readers do not think
     of agents that way. Use "the same way every time".
   - **No identifier-shaped tokens.** Regex
     `\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b` matches snake_case
     (`approved_at`, `originated_from_action_id`,
     `headcount_actions`). Zero hits.
   - **No mechanics jargon.** Case-insensitive scan for `writes`,
     `rows`, `calls`, `PATCH`, `POST`, `API`, `schema`, `column`,
     `FK`, `foreign key`, `constraint`, `uniqueness`, `join`,
     `table`, `query`, `back-pointer`, `cascade` (noun). Zero hits.
   - **No `use-semantius`**, no CLI commands, no file paths, no
     code fences.
   - **No "this skill"** substring, does not start with "This skill".
   - **Carries two or three concrete failure modes** in plain
     domain words, semicolon-separated. Phrased the way a domain
     expert would describe a bad day: "an offer can go out with no
     recorded approver", "two people can end up on the same seat".
   - **Domain nouns use user labels, not table names.** Cross-check
     against the model's `singular_label` values.
   - **Skill self-reference is by title.** Look for `# <Title>` H1,
     then verify the paragraph refers to the skill as "the <Title>"
     (e.g. "the Applicant Tracking Skill"), not as "this skill".
   - **Banned literal phrase: "lays out what the system can
     record".** That was an example, not a template. Paraphrase
     based on the model's actual flavor and the extracted verb.
7. **`description` follows the verb-led capability shape.** One
   sentence, ≤140 characters, written for a non-technical reader.
   The description names *what the skill does* by listing the actual
   capabilities/lifecycle stages of the domain, not by justifying
   the skill with a "so [outcome]" benefit clause. Run these literal
   scans:
   - **Shape:** `<Verb><s> <domain object> <list of lifecycle
     stages, operations, or artefacts>`. The verb is the same one
     extracted for paragraph 2 (`tracks`, `plans`, `manages`,
     `budgets`, `schedules`, `forecasts`, `reports`, `monitors`,
     `routes`, `books`, `provisions`) or the fallback (`Captures`,
     `Holds`, `Maps`, `Organises`, `Records`, `Resolves`).
   - **Banned shape: "so [outcome]" clause.** If the description
     contains ` so ` followed by a benefit/outcome clause (e.g. "so
     the right pieces always get filled in in the right order", "so
     renewals never fall off the calendar", "so two people never
     end up on the same seat"), it is using the body paragraph's
     value-prop shape instead of the catalog's capability shape.
     Rewrite to list the actual capabilities (workflow stages,
     operations, artefacts) instead. Also banned: ` while `, ` with
     ` followed by an outcome clause.
   - **Banned starters and substrings:** `Bakes in`, `bakes in`,
     `baked in`, `Bakes the`. Catalog readers do not know or care
     that anything is baked. Replace with the extracted verb.
   - **No mechanics jargon** in the description: `multi-step rules`,
     `paired status fields`, `paired writes`, `cascade`,
     `invariants`, `knock-on changes`, `multi-table cascade`,
     `seat-cascade`. Same ban list as paragraph 2.
   - **No identifier-shaped tokens** (snake_case regex from item 6).
   - **No "This skill", "A skill for", "Domain skill for", "Skill
     that".** Lead with the verb.
   - **No restatement of the system name.** "The Applicant
     Tracking System ..." is bad; the title already says it.
   - **Verb coherence with paragraph 2.** The description's verb
     must match the verb extracted for paragraph 2 (same Tier 1/2/3
     resolution). The description names the *capabilities* (catalog
     card view); paragraph 2 carries the *value-prop* (failure
     modes). They share the verb but not the shape.
8. **No provenance keys in front matter.** Exactly two keys: `title`
   and `description`. No `generated_from`, no `semantic_model`, no
   other key.
9. **Mermaid is the model's mermaid, byte-for-byte.** Diff the
   ```` ```mermaid ```` block in the README against the one in the
   source model file. They are identical. Any difference means the
   diagram was regenerated instead of copied.
10. **Sample prompts: concrete user-voice sentences, mapped to
    backings.** The README's `## Sample prompts` list and the
    SKILL.md frontmatter `description` are **independently
    authored** with different shapes: the description carries
    abstract verb-phrase intents, the README carries concrete
    user-voice sentences. They do not share wording. Run these
    checks on the README's sample-prompts list:
    - **Volume.** 12–17 bullets. Below 12 the catalog list looks
      thin; above 17 it dominates the page.
    - **Concrete user-voice phrasing.** Each bullet is a sentence
      a real person would type, in casual or natural register.
      Reject bullets that read as abstract intent phrases (e.g.
      `"return a hardware asset"` is wrong; `"Bob is leaving,
      return his laptop"` is right). The description is where
      intent phrases belong, not the README.
    - **Action vs discovery split.** 8–11 action prompts (concrete
      phrasings of JTBD intents, multiple synonyms welcome) plus
      4–6 discovery prompts (concrete lookup or report questions).
    - **Backing per Principle 6.** Each action prompt maps to a
      JTBD section; each discovery prompt maps to a Common-queries
      example, its adaptable pattern, or the lookup convention.
      Unbacked prompts are leaks: drop or back.
    - **No literal user-voice quotes appear in the SKILL.md
      description.** Run a separate scan on the description: if
      it contains quoted full-sentence user phrasings (e.g.
      `"Bob is leaving, return his laptop"`), that is matcher
      signal pollution. The description should enumerate intent
      classes ("return or unassign a hardware asset"), not list
      literal phrasings. Strip the quoted sentences from the
      description; the equivalent concrete phrasings stay in the
      README sample prompts.
11. **`## What it covers` is present, ordered, and well-shaped.**
    The section sits between `## Sample prompts` and `## Semantic
    model` (this order is load-bearing: prompts hook the reader,
    capabilities anchor the scope check, the diagram closes with
    the visual). Run these literal scans:
    - Section heading is exactly `## What it covers`.
    - Bullet count is in `[5, 7]`. Fewer reads as thin; more reads
      as a feature dump.
    - Each JTBD bullet leads with a verb and is under ~12 words.
      The trailing `Common reports: ...` bullet is the one
      structural exception, it leads with the noun phrase
      "Common reports:" and may run longer (it lists 3–5 themes
      separated by commas); apply only the no-jargon and
      no-identifier scans to it.
    - No script names (regex `\.sh\b`), no file paths (regex `/`
      followed by lowercase), no snake_case identifiers (regex
      `\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b`), no jargon from the
      banned mechanics list (Principle 6's body-paragraph bans
      apply here too: writes, rows, calls, PATCH, POST, FK,
      cascade, etc.). This applies to every bullet, including the
      Common reports bullet.
    - The bullets cover, in order, the same JTBDs the SKILL.md's
      `## Jobs to be done` lists, with adjacent related JTBDs
      grouped into single bullets where natural (e.g. deploy +
      return + retire collapse to one bullet about hardware
      lifecycle). The Common-queries appendix is summarized in a
      single trailing "Common reports: ..." bullet, not split.
    - No bullet duplicates a sample prompt. The prompt list is
      user-voice phrasing; the capability list is action scope.
      Overlap means the capability list isn't earning its place.
12. **No `use-semantius` mentions** and no agent-harness jargon
    anywhere in the README.

**Output of the self-review.** Report **per-principle**, not "no
issues found" as a single line. For each of Principles 0–7 plus the
README cross-check, write either:

- the fix you made, in one phrase (e.g. "Principle 1: replaced 3
  hardcoded timestamps with placeholders"); or
- the evidence that the principle was *actually scanned* against the
  generated files (e.g. "Principle 7 URL-encoding scan: 14
  interpolation sites checked, all routed through `jq -sRr @uri`";
  "Principle 7 JSON-body scan: 9 bodies checked, all built via
  `jq -nc`"; "Principle 7 column-existence scan: 2 polymorphic
  scripts have entity-supports-column guards on `notes` arg").

"Self-review pass, no issues found" is **not an acceptable form**
without the per-principle evidence, because the most common defect
in prior generations was the generator declaring no issues while
having skipped a principle entirely. Behavioral correctness (does
the script actually run on real catalog names?) is checked by
Principle 7, not by Principle 0; a Principle 0 pass plus a missing
Principle 7 line is the recurring failure mode this report shape is
designed to catch. If a principle has nothing to check on a given
generation (e.g. no scripts written, so Principle 7's script scans
are vacuous), say so explicitly: "Principle 7: no scripts written,
vacuous."

---

### Step 10, Summarize

Print to the user:

- The folder created: `<skills-root>/<modelslug>/` (state which root was
  used, project or user) and the files inside it. The two top-level
  files (`SKILL.md`, `README.mdx`) are required, missing either means
  the run is incomplete. List `references/` and `scripts/` contents
  if any were written.
- The **sections written** (one bullet each), with the merit signal
  that earned the spot **and** the Pass-3 classification, e.g.
  - "Vote on a feature, junction without uniqueness + caller-populated
    label, **reference** (`references/cast-vote.md`)"
  - "Ship a release, cascade flow, **script** (`scripts/ship-release.sh`)"
  - "Capture a feature, simple POST with no branching, **inline**"
- The **Common queries** baked into the appendix (titles only).
- The **dropped candidates** with reasons (e.g. "manage-tag, pure CRUD
  on `tags`, no merit signal, calling agent uses use-semantius
  directly"). The user may ask to add some back.
- The **platform-enforceable gaps** from Pass 2's tracking, when any.
  One bullet per gap (entity, field, kind, §3-prose evidence), and
  whether the user chose to proceed with the stopgap recipe or
  paused to fix the model. This survives in the user's audit trail
  so a later regeneration can confirm the gap was either closed
  (model now carries the rule, no gap reported) or knowingly accepted
  again.
- The **self-review result** from Step 9, **one line per principle
  (0 through 7 plus the README cross-check)**, in the per-principle
  evidence shape required by Step 9's "Output of the self-review".
  Either the fix made or the explicit scan-evidence; a collapsed
  "no issues found" line is rejected by Step 9 and must not appear
  here. The Principle 7 lines in particular must name a count of
  interpolation sites / JSON bodies / polymorphic-column guards
  inspected, not just "passed", because that was the principle
  prior generations skipped most often. Example shape:
  - "Principle 0: 7 JTBDs, 0 inline / 0 reference / 7 script;
    Pass 3 alignment confirmed."
  - "Principle 1: replaced 2 hardcoded timestamps with placeholders;
    §1 paragraph and mermaid byte-match the model."
  - "Principle 4: dropped a client-side discriminator pre-check in
    `add-alias.sh`; failure-modes now name the platform `code`."
  - "Principle 7 URL-encoding: 12 interpolation sites scanned, all
    routed through `jq -sRr @uri`."
  - "Principle 7 JSON bodies: 9 bodies scanned, all built via `jq
    -nc --arg`."
  - "Principle 7 column-existence: `promote-record.sh` now refuses
    `notes` arg on entities without a `notes` column (7 entities
    listed)."
  - "Principle 7 `--single` vs array: 14 reads scanned, classified
    per use-semantius Pattern A / Pattern B."
  - "README cross-check: 12 checks, all pass."
- The **file-tree size profile**, one line:
  `SKILL.md <N> lines, references/ <M> files (<lo>-<hi> lines each),
  scripts/ <K> files`. Surfacing this gives the user a feel for
  whether the split landed in a reasonable place; a 700-line SKILL.md
  with empty `references/` is a signal the classifier was too
  conservative.
- The **audit findings** from Step 4. On a fresh generation Step 4
  is skipped (there are no pre-existing artifacts to audit), but
  the bullet still appears, with the wording **"Fresh generation;
  Step 4 audit skipped. Behavioral correctness of the freshly-
  written files is covered by the Step 9 self-review above
  (Principle 0 structural + Principle 7 script-robustness)."** Do
  not collapse to "nothing to audit", that wording invites the
  generator (and the user) to read it as "behavioral correctness
  was also skipped", which is exactly the failure mode the
  per-principle self-review report is designed to prevent. On a
  regeneration, replace the fresh-generation sentence with the
  real findings, grouped by file and severity:
  - **Defects** (file is broken; rewrite recommended): e.g.
    "`references/score-rice.md`: linked from SKILL.md but missing
    on disk."
  - **Non-canonical** (works but uses an outdated pattern; user
    decides): e.g. "`cast-vote.sh`: 4 reads use legacy two-guard
    pattern, `--single` would simplify."
  - **Orphans** (no JTBD with this slug in current plan): e.g.
    "`tag-feature.md`: orphan; consider removing or restoring the
    JTBD."
  After listing, ask: *"Regenerate flagged files? (all-defects /
  all-flagged / per-file / none)"*, default `all-defects`. The user
  picks; Steps 5–7 rerun for the chosen subset, files outside the
  subset stay untouched.

---

## What this skill does **not** do

- It does not run `semantius` itself, recipes are written, not executed.
- It does not deploy the model, that's `semantic-model-deployer`.
- It does not generate evals, add via `skill-creator` later.

## Re-running on an updated model

Regenerate into the same target folder. The flow is:

1. **Step 4 audits the existing artifacts** (read-only) and produces
   a findings list grouped by defect / non-canonical / orphan. See
   Step 4 for the checks it runs.
2. **Step 10 surfaces the findings to the user** and asks which
   flagged files to regenerate (default: defects only).
3. **Steps 5–7 write the chosen subset.** `SKILL.md` and
   `README.mdx` are always rewritten because they always need to
   reflect the current generation's plan; references and scripts
   are rewritten only for files the user opted to regenerate. Files
   outside that subset stay untouched, including hand-edited ones.

Orphans (files for JTBDs that no longer exist in the current plan)
are surfaced in the audit but not auto-deleted. The user may have
referenced them externally or be mid-edit. The Step 10 summary names
each orphan and asks; default is to keep.

Hand-edits stay safe by default. The `README.mdx` and reference
files attract domain-expert hand-edits (narrative copy, failure-mode
wording, user-prompt phrasing); the audit treats those edits as
authoritative unless the file has a real defect (broken link,
missing required field, contradicts the model). For non-canonical
patterns alone, the user decides whether to take the upgrade.

## Rebuild from scratch (Mode D)

A holistic regeneration of the entire generated skill folder, distinct from the conservative "Re-running on an updated model" flow above. The conservative re-run preserves hand-edits and rewrites only defective files; Mode D throws out the prior generation entirely and re-derives every artifact from the current model, treating the prior folder as **archived knowledge** for lessons learned but never as a structural constraint.

### When to choose Mode D

Trigger phrases the user is likely to use:
- "Rebuild / reanalyze / re-author the `<slug>` skill from scratch."
- "The model has drifted across many iterations, regenerate everything."
- "Throw out the existing skill folder and start over."
- "We accumulated cruft in the generated skill, I want a fresh pass."

### When *not* to use Mode D

- The model has minor changes and you only want to update affected files, use the conservative **Re-running on an updated model** flow (the default re-run behavior).
- The user wants to preserve hand-edits to README.mdx narrative or reference-file copy, use the conservative flow. Mode D rewrites everything.
- The user wants audit-only (no writes), run Step 4 alone and stop without proceeding to Step 10's regeneration prompt.
- The model file's major differs from `EXPECTED_MAJOR`, refuse and route the user to the analyst's Mode D Rebuild on the model file first; this skill cannot rebuild a generated skill from a stale-major model.

### How a rebuild runs

1. **Run Steps 1–3 as if generating from scratch.** Re-parse the current model file and re-derive jobs to be done from first principles. Do **not** consult the prior `SKILL.md` or its reference files for the JTBD list, the model is the only input. Reading the prior generation here would import its biases and defeat the point of a rebuild.

2. **At Step 4, the audit's role flips.** Instead of producing a "regenerate this defective file" list, it produces a "lessons from the prior generation" list, surfaced for the user at Step 10. Look for:
   - Hand-edited narrative copy in README.mdx or reference files that captures domain nuance not in the model (rare; surface so the user can paste relevant bits manually after the rebuild lands).
   - JTBDs present in the prior plan that no longer have a model basis (likely intentional drops; surface as "removed").
   - Guardrails or domain-glossary entries that look user-customized (preserve verbatim only if the user explicitly opts in at Step 10).
   - Orphan files (JTBDs that no longer exist in the rebuilt plan); surfaced but never auto-deleted.

3. **Steps 5–9 write a complete fresh folder.** Default target: a sibling folder `<skills-root>/<slug>.rebuild/` so the prior survives for diffing. Overwriting `<skills-root>/<slug>/` directly is allowed **only after explicit user confirmation** at the Step 10 summary gate.

4. **Step 10 shows the diff before overwriting.** The summary names: JTBDs added / removed / renamed, references regenerated, scripts regenerated, and any hand-edits the audit flagged for manual carry-over. Ask: *"Does this rebuild look right, or anything to keep from the prior folder?"* Loop until confirmed. No overwrite of `<slug>/` until the user says yes.

### What carries over

- **Nothing structural by default.** The semantic-model file is the single source of truth; prior artifacts are not. The rebuilt SKILL.md, README.mdx, references, and scripts are derived fresh from the model.
- **Hand-edited content** (README narrative, reference-file failure-mode wording, guardrail prose) is surfaced in the Step 10 diff for opt-in manual carry-over. The skill does not auto-merge; the user pastes the bits they want to keep into the rebuilt folder.
- **The target folder name** (`<slug>/`) stays the same unless the user explicitly renames the system, in which case follow the slug change loudly per the front-matter rules in Step 5 (a slug change breaks any external references to the prior folder).

### What this is not

- **Not the conservative re-run.** That preserves hand-edits and rewrites only defective files. Mode D rewrites everything.
- **Not a fix-up of broken artifacts.** Use Step 4 audit + Step 10 subset selection for that, the conservative flow handles it correctly.
- **Not an upgrade path for major-version mismatches.** Major mismatch is rejected at Step 2; the user must re-author the model via `semantic-model-analyst` Mode D Rebuild first, then re-run skill-maker (any flow) against the fresh file.

---

## Failure modes

- **Model file's `version` major differs from `EXPECTED_MAJOR`** (or `version` is missing), refuse. The model is from a different schema era and recipes would bake in stale patterns. Tell the user to run `semantic-model-analyst` to re-author the model at current major (archived-knowledge mode handles older files), then re-run skill-maker against the new file.
- **Model file missing required frontmatter**, stop and ask. Don't
  guess `system_slug`.
- **Model file has open §7.1 blockers**, refuse. Tell the user to
  resolve blockers in `semantic-model-analyst` first.
- **Conflicting target folder**, if `<skills-root>/<modelslug>/`
  already exists and the SKILL.md was not generated by this skill
  (no link back to the model file in its header), stop and ask before
  overwriting.
- **JTBD count > ~12 after filtering**, Step 3.5 (Cluster check)
  runs and may surface a clean two-skill split. If it does, the
  Confirmation checkpoint already presents the split as a fourth
  list; no separate warning needed. If Step 3.5 finds no clean cut
  (the model really is one tightly-coupled big domain), warn the
  user that the resulting one-skill description will under-trigger
  and ask whether to drop lower-merit candidates or split the model
  file itself. Proceed with one oversized skill only if the user
  confirms.
