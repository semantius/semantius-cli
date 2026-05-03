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
  on top of an existing `*-semantic-model.md` file. The generated
  SKILL.md delegates platform mechanics (CLI install, PostgREST
  encoding, cube DSL) to `use-semantius`, which is expected to load
  alongside.
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

---

## Inputs

- `MODEL_PATH`: absolute path to a `*-semantic-model.md` file with valid
  frontmatter (`system_slug`, `system_name`, `entities`, etc.) and §3
  entity definitions.

## Output

A single folder under the user's Claude skills root containing **two
files**:

```
<skills-root>/<modelslug>/
├── SKILL.md     # for the calling agent, terse, recipe-dense
└── README.mdx   # for humans browsing a skill catalog, narrative + diagram
```

`SKILL.md` is what an agent harness loads at runtime. `README.mdx` is a
human-facing catalog entry: a downstream system renders these into a
gallery so a person can browse available skills, understand each one's
purpose at a glance, and decide whether to install it. The two files
share a folder, but their audiences and formats are different, do not
collapse them, and do not skip the README.

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

The generated SKILL.md is **self-contained at runtime**, its glossary,
enums, FK cheatsheet, and recipes resolve every value at generation time so
the calling agent never needs to open the model file to act.

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

### Step 0, Load the Semantius reference

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

### Step 1, Parse the model

Read `MODEL_PATH` and extract:

- `system_slug`, `system_name`, `domain` from frontmatter.
- Entity list with `singular_label`, `label_column`, fields (name, format,
  required), enum values (§5), FK relationships (§4), parent/cascade-child
  flags, `audit_log`.

Compute `modelslug = system_slug.replace(/_/g, "-")`.

Refuse if §6.1 lists open blockers, the model is not finished and the
skill would bake in wrong recipes.

### Step 2, Reason about jobs to be done

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
Shape test: `owner_*_id` field, sharing tables, multi-tenant scoping
via a tenant FK on most entities. Candidates: transfer ownership of X,
share X with, revoke access to X.

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

##### Skip rules

Do **not** nominate any of the following, they fall outside the
"job to be done" frame:

- **Single-row CRUD on master-data tables** with no lifecycle (insert
  one department, edit a job code). The calling agent uses
  `use-semantius` directly; an extra section is just noise.
- **Seed / sample / test-data population.** One-off developer work,
  not a recurring job. If the user wants a seed script, ask separately.
- **Entities listed in §6.2 "Future considerations"**, they don't
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
| **Computed field** | A stored numeric/derived field (e.g. `rice_score`, `total_amount`, `days_open`) whose value depends on sibling fields. The recipe must recompute on every relevant PATCH. |
| **DB-unguarded lifecycle gate** | Status enum where some transitions are valid and others aren't, but the DB accepts any value. The recipe must read-before-write. |
| **DB-unguarded invariant across FKs** | E.g. `features.release_id` and `features.product_id` must agree on product. The recipe must read both rows and check before patching. |
| **Cascade flow** | Flipping one parent row should flip a filtered set of children in the same logical operation (e.g. release-shipped → its planned/in-progress features → shipped). |
| **Junction without uniqueness** | M:N junction without a DB-level unique constraint on the natural key. The recipe must dedupe-before-insert. |
| **Materialization / handoff** | One entity row spawns rows in a different table (Pattern C). The order, FK back-pointers, and source-status flip are easy to get wrong. |
| **Side-effect fields on transition** | `approved_at`, `committed_at`, `actual_release_date`, etc. that must be set in the same PATCH as the status flip, easy to forget. |
| **Audit-trail read** | Audit-logged entity (`audit_log: true`) where "who/when changed X" is a likely user question. Worth a short recipe even though writes need no special handling. |

If the only thing a candidate does is single-table CRUD with the platform
defaults (no merit signals), drop it. List dropped candidates in the Step
4 summary as `skipped: pure CRUD against <table>, calling agent uses
use-semantius directly`. This is not a failure; it is the design.

#### Sizing

After filtering, aim for **5–10 sections** plus the optional `Common
queries` appendix.

- Fewer than 5 sections after filtering: the model may be too thin to
  justify a domain skill. Tell the user; ask whether to ship it anyway
  or extend `use-semantius` with a glossary file instead.
- More than ~10 sections after filtering: a single skill that long
  under-triggers, the description gets diluted and the matcher loses
  signal. Push back: ask the user whether the lower-merit candidates
  can drop, or whether the model is really two domains stitched into
  one (suggest splitting the model file). Proceed only if they confirm.

#### Confirmation checkpoint

Present three lists to the user:

1. **Sections**, the JTBDs that earned a place (one bullet each, with
   the merit signals that justified them).
2. **Common queries**, the cube queries that go in the appendix.
3. **Skipped**, Pass-1 candidates that failed the merit test, with the
   reason. The user may disagree and ask to add some back.

Wait for confirmation before writing files. This is the only human
checkpoint.

### Step 3, Write the consolidated SKILL.md

The folder gets two files written in sequence: the agent-facing
`SKILL.md` (this step) and the human-facing `README.mdx` (Step 3.4).
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
  by default. Mention that the skill delegates platform mechanics to
  `use-semantius` so the model knows both can load together.>
semantic_model: <system_slug, e.g. product_roadmap (no path, no .md extension)>
---

# <system_name>

The H1 here is **`system_name` verbatim**. No "Skill" suffix, no
"domain" prefix, no rewording. The file is named `SKILL.md`, so the
agent loading it already knows it is a skill, repeating "Skill" in
the heading is noise. Examples: `# Applicant Tracking System`,
`# Workforce Planning`, `# Customer Relations`.

(The README.mdx H1 follows a different rule, the Title grammar in
Step 3.4, because the catalog needs the "Skill" suffix to
disambiguate cards. Do not confuse the two.)

This skill carries the domain map and the jobs-to-be-done for
<system_name>. Platform mechanics, CLI install, env vars, PostgREST
URL-encoding, `sqlToRest`, cube `discover`/`validate`/`load`, and
schema-management tools, live in `use-semantius`. Assume it loads
alongside; do not re-explain CLI basics here.

If a task is purely about defining schema, managing permissions, or
running ad-hoc queries against tables you already know, call
`use-semantius` directly, going through this skill adds nothing.

**Auto-managed fields** (set by Semantius on every table; never include
in POST/PATCH bodies): `id`, `created_at`, `updated_at`. The
`label_column` field is **required on insert and caller-populated** on
every entity unless the model explicitly says it is auto-derived ,
this includes junction tables like `<junction>` and sub-entities like
`<sub-entity>`, where the recipe must compose the value (see each
JTBD for the composition rule). Do not omit `*_label` from POST bodies.

---

## Domain glossary

<One short table. Pull `singular_label`s, table names, and a one-line
"what it represents" for each entity. Group related entities together
(e.g. "Pipeline: leads, opportunities, accounts"). Skip junction tables
unless a job touches them directly. Do not duplicate FK targets here ,
the FK cheatsheet is below.>

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

## Foreign-key cheatsheet

<Only the FKs that JTBDs cross. Format: `child.field → parent.id`.
Note any unique / 1:1 constraints that commonly cause 409s, and any
junctions whose `(parent_id, child_id)` pair lacks a DB-level unique
constraint (those need read-before-insert in recipes).>

- `opportunities.lead_id → leads.id`
- `accounts.opportunity_id → opportunities.id` (unique, one account per
  closed-won opportunity)

<List audit-logged tables here in one line so the calling agent knows
audit rows write themselves. Example: "Audit-logged: `opportunities`,
`accounts`, Semantius writes the audit rows; recipes don't manage
them.">

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
| `<input>` | yes/no | <where it comes from> |

If a required input is missing, look it up first via `postgrestRequest`
against the relevant table, don't ask the user unless the lookup is
ambiguous.

**Lookup convention (bake one example into every JTBD that takes a
human-friendly identifier):** Semantius adds a `search_vector` column
to searchable entities for full-text search across all text fields.
Use it whenever the user passes a name, title, email, code, etc., not
a UUID:

```bash
# Resolve a feature by anything the user typed (title, description, etc.)
semantius call crud postgrestRequest '{"method":"GET","path":"/features?search_vector=wfts(simple).<term>&select=id,feature_title"}'
```

Use `wfts(simple).<term>` for fuzzy text searches, never `ilike` and
never `fts`, they bypass the search index and mismatch the platform
convention.

Field-equality (`<column>=eq.<value>`) is the right tool for a
*different* job: filtering on a known-exact value. Use it for UUIDs,
FK ids, status enums, and unique columns whose values the caller
already knows verbatim (`tag_name`, `user_email`, `release_name`).
The two are not in competition, `wfts` resolves a fuzzy human input
to a row; `eq` selects rows whose column exactly equals a known value.

If a lookup returns more than one row, present the candidates and
ask; if zero, ask the user to clarify rather than guessing.

**Recipe:**

```bash
# 1. Look up the lead
semantius call crud postgrestRequest '{"method":"GET","path":"/leads?email=eq.foo@bar.com&select=id,lead_status"}'

# 2. Verify status is `qualified`

# 3. Create the opportunity
semantius call crud postgrestRequest '{
  "method":"POST",
  "path":"/opportunities",
  "body":{
    "lead_id":"<id from step 1>",
    "stage":"prospecting",
    "amount":50000,
    "owner_employee_id":"<owner>"
  }
}'

# 4. Mark the lead as converted
semantius call crud postgrestRequest '{
  "method":"PATCH",
  "path":"/leads?id=eq.<id>",
  "body":{"lead_status":"converted"}
}'
```

**Validation:** <2–3 short post-conditions, only the ones that have
actually been broken in practice.>

**Failure modes:** <2–3 most likely failures, each paired with a
*recovery action* the calling agent can take, not just "this fails":

- `409 on accounts.opportunity_id` (uniqueness) → an account already
  exists for this opportunity; PATCH the existing row instead.
- FK violation on `lead_id` → the lead was deleted; ask the user
  whether to recreate it or abort the conversion.>

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
Pull from §6.1 of the model (resolved blockers / explicit constraints)
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
  §6.2 "Future considerations" of the model at generation time and
  write it as a plain bullet, do *not* cite "§6.2" in the SKILL.md,
  the calling agent has no way to look it up. If §6.2 is empty or
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
- **1:1 / unique constraints**, flag in **Failure modes** with the
  exact 409 condition *and* the recovery action (PATCH the existing row,
  pick a different parent, etc.).
- **Cube queries in the appendix**, always lead with
  `cube discover '{}'` and tell the calling agent to *map* the
  appendix's measure/dimension names against discover's output. Cube
  schema names drift on regeneration; the appendix is a starting point,
  not a contract.

#### Trigger phrasing

The frontmatter `description` decides whether Claude Code consults the
skill at all. Make it slightly pushy:

- Lead with the domain noun ("CRM", "workforce planning") so domain-level
  asks trigger.
- List 4–6 verb-phrasings spanning the JTBDs, including informal forms
  ("close this deal" alongside "set opportunity to closed_won").
- Mention `use-semantius` so the matcher learns the two skills compose.

### Step 3.4 (Write the README.mdx, human-facing catalog entry)

After the SKILL.md is written, generate a sibling `README.mdx` in the
same folder. This file is **not** loaded by any agent harness; it
exists so a person browsing a skill catalog can understand at a glance
what the skill is for and whether they want it. Optimize for human
skim, not agent triggering.

This step is **not optional**. A run that produces only `SKILL.md` is
incomplete; the catalog system depends on the README being there. If
you find yourself about to print the Step 4 summary without having
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

The `description` is the single line a person reads when scanning the
catalog. It must:

- Be **one** sentence, **≤140 characters**.
- Be a **unique value proposition** for this skill, not a restatement
  of what the system is. The title already conveys the domain. The
  description says what becomes easier when the skill is loaded:
  which mistakes are prevented, which multi-step jobs become one
  step, which non-obvious invariants are baked in.
- Not start with "This skill", "A skill for", "Domain skill for",
  "Skill that", or any equivalent self-referential opener. Lead with
  a verb phrase or a noun phrase that carries domain weight.
- Not contain the substring "this skill" or em-dashes (see banned
  list above).

Examples (illustrative, regenerate from the actual model):

- BAD: `description: This skill helps with the Applicant Tracking System.`
- BAD: `description: Domain skill for an in-house recruiting team, open requisitions, run candidates, hire.`
- GOOD: `description: Bakes in the multi-step rules for moving a candidate from application to hire, including paired status fields and offer-acceptance ripples.`

#### Body structure (in this exact order)

The body has exactly **four** sections after the heading. Do not
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

   Most `system_name` values have an action verb hiding inside.
   Extract it for sentence 1 (and optionally sentence 2):

   | `system_name` ends in / contains | Verb | Example |
   |---|---|---|
   | `Tracking`, `Tracker` | track | "The Applicant Tracking model **tracks** ..." |
   | `Planning`, `Planner` | plan | "The Workforce Planning model **plans** ..." |
   | `Management`, `Manager` | manage | "The Equipment Lease Management model **manages** ..." |
   | `Budgeting` | budget | "The Zero-Based Budgeting model **budgets** ..." |
   | `Scheduling`, `Scheduler` | schedule | |
   | `Forecasting` | forecast | |
   | `Reporting` | report | |
   | `Monitoring` | monitor | |
   | `Routing` | route | |
   | `Booking` | book | |
   | `Provisioning` | provision | |

   General rule: if the system name ends in an `-ing` gerund or an
   `-er`/`-or` agent noun, the bare verb form is the right verb for
   sentence 1. The skill in sentence 2 then teaches the agent "how
   to **<verb>** [the domain]".

   **Fallback palette** (only when no verb is hiding in the name,
   e.g. `Product Roadmap`, `Northwind`, `CDP`): pick from
   `captures`, `holds`, `describes`, `lays out`, `organizes`,
   `maps`. Six options so even fallback paragraphs do not all read
   the same.

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

   **Product Roadmap** (no embedded verb, fallback used)

   > The Product Roadmap model captures every idea, the rationale
   > weighing it, and the release that ships it. The Product
   > Roadmap Skill teaches an agent how to use that model to take
   > an idea from intake through prioritization to a shipped
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
   ten quoted phrases, the bullet list has ten bullets.
5. **Semantic model.** A Mermaid diagram copied verbatim from the model
   (see Mermaid section below).

#### README.mdx template

````mdx
---
title: <Heading text, see "Title grammar" below>
description: <One sentence, ≤140 chars. Unique value-prop. Never starts with or contains "this skill". No em-dashes.>
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

## Semantic model

```mermaid
<Mermaid diagram, see "Mermaid diagram" below>
```
````

That is the entire README. Five elements only: front-matter, heading,
model description (verbatim from §1), skill explanation paragraph
(prose expansion of the front-matter description), sample triggers,
mermaid diagram. **Do not add** any other section, including "What
this skill helps with", "When to use it", "What's inside", "Generated
from", or "About".

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
and note in the Step 4 summary: `Model file has no mermaid block;
omitted Semantic model section. Ask <semantic-model-analyst> to add one.`

### Step 3.5, Self-review pass

Before printing the summary, re-read the SKILL.md you just wrote with
fresh eyes, as if a colleague were going to use it tomorrow against a
different model. The point is not a checklist; it is that small
drafting errors here scale, because every future invocation of the
generated skill pays the cost. Fix issues in place; surface anything
you can't fix without a design change in the Step 4 summary as a
known limitation.

Run the pass against four general principles. The bullets under each
are *examples* of what to look for, drawn from defects observed in
prior generations, they are not exhaustive, and the principle is
what should drive the review on a new model where the specific defects
may be different.

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

Two things to scan for:

- *Hardcoded literals that will rot.* Dates, timestamps, ids, the
  generation year, anything that was correct only at write time.
  Every such literal in a recipe body must become a placeholder
  (`<current ISO timestamp>`, `<today's date, YYYY-MM-DD>`,
  `<feature_id>`) with a one-line note telling the agent to fill it
  at call time. Hardcoded timestamps are the most common offender ,
  search for them explicitly even if you don't think you wrote any.
- *Recipes that punt.* If a JTBD ends with "see `use-semantius` for
  the path" or "look up X in references/Y.md", the bake-in failed.
  Either resolve the value now (re-read the model and the use-semantius
  references) or, if it truly isn't knowable at generation time, keep
  the punt explicit and reconsider whether the JTBD passes the Step-2
  merit test. A JTBD that just redirects fails the test, drop it and
  say why in the Step 4 summary.

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

**3. No surprises in the cheap-to-read parts.** The glossary and FK
cheatsheet are skimmed first; what is buried in JTBD failure-modes is
read last, if ever. Anything that will *surprise* the calling agent
at write time should surface in the cheap-to-read parts.

- Unique constraints on natural keys (e.g. `tag_name` unique).
- Delete behaviors that block writes (e.g. `restrict` on `author_id`
  means deleting a user with comments fails).
- Required caller-populated labels on junction or sub-entities.
- Built-in Semantius tables that overlap with declared entities (the
  model's §7 flags this, commonly `users`). The calling agent must
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

If a new platform convention shows up in the use-semantius references
that this list doesn't mention, treat the principle ("match the
platform") as the authority and add the new convention to the recipes ,
the bullets above will lag.

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
   - **Domain verb extracted from `system_name`.** If `system_name`
     ends in `Tracking|Tracker|Planning|Planner|Management|Manager|Budgeting|Scheduling|Scheduler|Forecasting|Reporting|Monitoring|Routing|Booking|Provisioning`,
     sentence 1 must use the bare verb form (track, plan, manage,
     budget, schedule, forecast, report, monitor, route, book,
     provision). Using a generic fallback verb when an embedded
     verb was available is a fail. Fallback verbs (`captures`,
     `holds`, `describes`, `lays out`, `organizes`, `maps`) are
     only allowed when the system name has no embedded verb.
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
7. **`description` is unique value, not a domain restatement.** One
   sentence, ≤140 characters, does not start with "This", "A skill",
   "Domain skill", or "Skill that". Says what *new* value loading the
   skill adds, not what the system is (the title already conveys
   that).
8. **No provenance keys in front matter.** Exactly two keys: `title`
   and `description`. No `generated_from`, no `semantic_model`, no
   other key.
9. **Mermaid is the model's mermaid, byte-for-byte.** Diff the
   ```` ```mermaid ```` block in the README against the one in the
   source model file. They are identical. Any difference means the
   diagram was regenerated instead of copied.
10. **Sample prompts are verbatim AND complete.** Count the quoted
    phrases in the SKILL.md frontmatter `description`. The README's
    `## Sample prompts` list must have **exactly that many** bullets,
    in the same order, each bullet quoting one phrase verbatim. No
    subset, no paraphrase, no reordering. If the description has 10
    quoted phrases, the bullet list has 10 bullets.
11. **No `use-semantius` mentions** and no agent-harness jargon
    anywhere in the README.

**Output of the self-review.** If you found nothing, write one line in
the Step 4 summary: "Self-review pass, no issues found." If you fixed
things, list the principles you touched and a one-phrase description
per fix (e.g. "Principle 1: replaced 3 hardcoded timestamps with
placeholders; Principle 2: collapsed a duplicate guardrail into one
JTBD's failure modes"). This trails into the user's audit trail and
helps them spot drift if they regenerate later.

---

### Step 4, Summarize

Print to the user:

- The folder created: `<skills-root>/<modelslug>/` (state which root was
  used, project or user) and the two files inside it (`SKILL.md` and
  `README.mdx`). If only one file is present, the run is incomplete.
- The **sections written** (one bullet each, with the merit signal that
  earned the spot, e.g. "Vote on a feature, junction without uniqueness
  + caller-populated label").
- The **Common queries** baked into the appendix (titles only).
- The **dropped candidates** with reasons (e.g. "manage-tag, pure CRUD
  on `tags`, no merit signal, calling agent uses use-semantius
  directly"). The user may ask to add some back.
- The **self-review result** from Step 3.5, either "no issues found"
  or the principles you touched and what you changed (e.g.
  "Principle 1: replaced 2 hardcoded timestamps with placeholders;
  Principle 3: surfaced `tag_name` uniqueness in the glossary"). This
  gives the user a quick audit trail.

---

## What this skill does **not** do

- It does not run `semantius` itself, recipes are written, not executed.
- It does not deploy the model, that's `semantic-model-deployer`.
- It does not generate evals, add via `skill-creator` later.

## Re-running on an updated model

Safe by design: regenerate into the same target folder. Both
`SKILL.md` and `README.mdx` are overwritten in place, there are no
orphan files to clean up because the output is exactly two files.

If the user has hand-edited either file, ask before overwriting, diff
first, then merge or replace. The `README.mdx` is the more likely
candidate for hand-editing (humans tweak narrative copy more often
than agents tweak recipes), so check it specifically.

## Failure modes

- **Model file missing required frontmatter**, stop and ask. Don't
  guess `system_slug`.
- **Model file has open §6.1 blockers**, refuse. Tell the user to
  resolve blockers in `semantic-model-analyst` first.
- **Conflicting target folder**, if `<skills-root>/<modelslug>/`
  already exists and the SKILL.md was not generated by this skill
  (no link back to the model file in its header), stop and ask before
  overwriting.
- **JTBD count > ~12 after filtering**, warn the user that the
  resulting skill will under-trigger because its description tries to
  cover too many shapes. Ask whether lower-merit candidates can drop,
  or whether the model itself is two domains stitched together
  (in which case the cleaner fix is to split the
  `*-semantic-model.md`). Proceed only if the user confirms.
