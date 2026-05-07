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

A single folder under the user's Claude skills root. Two top-level
files are always written; `references/` and `scripts/` subfolders are
written only when the JTBD classifier in Step 2 (Pass 3) puts work
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
engages one JTBD at a time. The classifier in Step 2 (Pass 3) decides
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
file. The classification belongs in the Step 4 summary so the user
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
Step 2 Pass 3. The full recipe body, lookup-then-compose-then-write,
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

### Step 3.2, Write the reference files (one per JTBD classified `reference`)

For every JTBD that Pass 3 classified as `reference`, write a sibling
file at `<skills-root>/<modelslug>/references/<jtbd-slug>.md`. The
slug matches the SKILL.md `<jtbd-slug>` link target byte-for-byte, the
agent will fail to load the file if the link drifts. Use a short
verb-phrase slug (`schedule-feature.md`, `cast-vote.md`,
`ship-release.md`), not a full sentence.

The reference file is loaded by the calling agent **only** when it
enters that specific JTBD. SKILL.md has already been read by then, so
the agent knows the glossary, enums, FK cheatsheet, lookup
convention, timestamp rule, and guardrails. Do not restate any of
those. The reference file owns the recipe body and any rules that
only matter inside this JTBD.

#### Reference file template

```markdown
# <Job title (matches SKILL.md ### heading verbatim)>

<One opening sentence: what this recipe does and the most
load-bearing invariant. No marketing, no value-prop, the agent has
already chosen this recipe. Example: "Cast or update a vote on a
feature. The `(feature_id, user_id)` junction has no DB-level
uniqueness, so the recipe must read first.">

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
# Step 1: parallel-fetch (no dependency between these reads).
# Both reads use --single because the agent passed a unique key
# (id, email, code); zero rows or multiple rows is a domain error.
# expect: --single, exit 0 returns one row as a bare object {...};
# exit 1 = not found (refuse and tell the user "<entity> '<value>'
# not found"); exit 2 = ambiguous (rare, surface as a model bug).
semantius call crud postgrestRequest --single '{"method":"GET","path":"/<table>?<unique-filter>&select=<cols>"}'
semantius call crud postgrestRequest --single '{"method":"GET","path":"/<other>?<unique-filter>&select=<cols>"}'

# Step 2: dedupe check on a junction without DB-level uniqueness.
# Drop --single because zero rows is the legitimate "go ahead and
# POST" branch.
# expect: array; [] means "no duplicate, proceed to step 3"; one
# row means "already exists, PATCH instead or do nothing".
semantius call crud postgrestRequest '{"method":"GET","path":"/<junction>?<parent-a>=eq.<a>&<parent-b>=eq.<b>&select=id"}'

# Step 3: <branch / compute / refuse logic with explicit conditions,
#         e.g. "if release_status in (released, cancelled), refuse">

# Step 4: <write> (paired fields go in one call, never split).
# Use --single when the write must affect exactly one row (POST a
# new row; PATCH by id). The response is the bare object on success.
# expect: --single, exit 0 returns the inserted/updated object;
# exit 2 = the filter matched zero rows or many, the write did not
# take effect.
semantius call crud postgrestRequest --single '{
  "method":"<POST|PATCH>",
  "path":"/<table>[?id=eq.<id>]",
  "body":{<resolved body>}
}'

# Step 5: <verify the post-condition the validation block claims>.
# --single asserts the row exists post-write.
# expect: --single, the row's <field> equals <expected value>; if
# the value is wrong, the write did not take what we sent (rare;
# investigate before declaring success).
semantius call crud postgrestRequest --single '{"method":"GET","path":"/<table>?id=eq.<id>&select=id,<field>"}'
```

Annotate each recipe step's leading comment with **what the step
depends on** AND **what the agent should expect from the response**.

- Independent reads carry the leading comment "parallel-fetch (no
  dependency)" so the agent runs them in one round trip.
- Dependent steps name what they consume from earlier steps.
- Every `GET` is tagged either `--single` (assert exactly one row,
  bare object response, exit 1 = not found, exit 2 = ambiguous) or
  array-default (drop the flag, response is `[...]`, may be empty;
  the dedupe / list / count case). The `# expect:` line names which
  pattern is in use AND the action on failure:
  - `--single`: exit 1 => refuse and tell the user "<entity> not found";
    exit 2 => surface as a model bug (a unique-key lookup should never
    return many).
  - array: state explicitly what `[]` means in this recipe (usually
    "go ahead" for dedupe, "no rows match" for lists). The action on
    `[]` is part of the recipe's branch logic, not an error path.
- Every `POST` / `PATCH` / `DELETE` whose effect is supposed to
  change exactly one row uses `--single` and the `# expect:` line
  names the field that confirms the change. Bulk operations (cascade
  sweeps, multi-row PATCH) drop `--single`; the `# expect:` line
  names the residual-count check that follows.

**Default to `--single` for unique-key reads.** If the recipe writes
the lookup as `?<col>=eq.<value>` against a `unique` column, an
`id`, or a composite key the recipe has already proven unique, use
`--single`. Drop it only when zero or many rows is a normal branch.
This is the single most common defect in generated recipes: leaving
off `--single` on a unique-key read, then having to follow up with a
manual empty-result check that the agent forgets.

The semantics of `--single` and the array-default pattern, plus the
exit codes, live in `use-semantius`'s "Response handling: exit code
is not enough" section. The reference does not re-explain them; the
per-step `# expect:` annotations exist so the agent does not have
to consult that section mid-recipe to remember which pattern this
call uses.

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

#### What goes into a reference file, vs what stays in SKILL.md

The split exists so SKILL.md stays small. Apply the test for each
piece of content:

- *Every JTBD touches it* (lookup convention, timestamp rule,
  glossary, enums, FK cheatsheet, guardrails) → SKILL.md only.
- *Only this JTBD touches it* (recipe body, JTBD-specific
  composition rules, extended failure modes, computed-field rounding)
  → reference file.
- *Some JTBDs touch it, others don't* (e.g. junction-without-uniqueness
  warning) → SKILL.md FK cheatsheet calls it out at the entity level
  (the cheap-to-read part); the affected reference files name the
  exact recovery action.

A reference file aimed at fewer than ~40 lines means the JTBD
probably belongs inline in SKILL.md after all, the file split has
overhead (an extra read). A reference file growing past ~120 lines
means either the JTBD is doing two jobs (split it) or the reference
is restating SKILL.md material (delete the duplicates).

### Step 3.3, Write the script files (one per JTBD classified `script`)

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

# Step 1: read by unique key or id - canonical --single pattern.
# `--single` makes the CLI assert exactly one row: exit 1 on zero,
# exit 2 on many, and the response is the bare object (no [0] index).
# One guard now does the work of two.
row=$(semantius call crud postgrestRequest --single "{\"method\":\"GET\",\"path\":\"/<table>?<unique-filter>\"}") \
  || { echo "step 1: <entity> '<lookup-value>' not found or ambiguous" >&2; exit 1; }
# Optional further precondition checks on parsed fields. The response
# is a bare object, so use grep without `head -n1` and without [0]:
status=$(printf '%s' "$row" | grep -oE '"<col>":"[^"]+"' | sed 's/.*:"\(.*\)"/\1/')
if [ "$status" = "<bad-value>" ]; then
  echo "step 1: <entity> in $status state, refusing" >&2; exit 1
fi

# Step 2..N: write. Use --single on a POST/PATCH/DELETE that must
# affect exactly one row; the assertion AND the response shape match
# the read pattern above.
semantius call crud postgrestRequest --single "{\"method\":\"PATCH\",\"path\":\"/<table>?id=eq.<id>\",\"body\":{...}}" \
  >/dev/null \
  || { echo "step 2 (PATCH <table>) failed; row not found or write rejected" >&2; exit 2; }

# Bulk writes that legitimately affect 0..N rows (cascade sweeps,
# dedupe POSTs that may match nothing) DROP --single. Exit-code
# guard alone is fine; the empty result is part of the contract.
semantius call crud postgrestRequest "{\"method\":\"PATCH\",\"path\":\"/<table>?<bulk-filter>\",\"body\":{...}}" \
  >/dev/null \
  || { echo "step 3 (sweep <child>) failed; partial state possible, see above" >&2; exit 2; }

echo "<op-slug>: ok"
```

#### Two read patterns, pick by intent

Every `semantius call ... GET ...` in a script falls into one of two
patterns. The choice depends on whether zero rows is a domain error
or a normal branch.

**Pattern A: `--single`** for any read that **must** resolve to
exactly one row (lookup by `id`, by a unique column, by a composite
key the recipe has already proven unique). The CLI asserts the count
and returns the bare object. One guard is enough:

```bash
row=$(semantius call crud postgrestRequest --single "{...GET by unique key...}") \
  || { echo "step N: <entity> '<value>' not found or ambiguous" >&2; exit 1; }
# $row is {"id":"...", ...}; parse with jq '.id' or
# grep -oE '"id":"[^"]+"' (no head -n1, no [0]).
```

**Pattern B: array (drop `--single`)** for reads where the count is
the answer (dedupe checks, list queries, residual-rows counts). The
response is an array; the script must inspect emptiness and act on
it:

```bash
rows=$(semantius call crud postgrestRequest "{...GET that may return 0..N...}") \
  || { echo "step N (<what>) failed" >&2; exit 2; }
if ! printf '%s' "$rows" | grep -q '"id"'; then
  # zero rows - dedupe says "go ahead and create"
  ...
else
  # one or more rows - "already exists / use existing"
  ...
fi
```

**Choosing per call:** if zero rows means "the user named something
that doesn't exist, refuse," use `--single`. If zero rows means "no
duplicate, continue with the create," drop `--single`. Never use
`--single` on a dedupe check; never drop it on a unique-key lookup.

A canonical residual-count check (after a cascade sweep, verifying
that no rows are left in the source state) stays as Pattern B; the
intent is to count, and zero is the success case:

```bash
remaining=$(semantius call crud postgrestRequest "{\"method\":\"GET\",\"path\":\"/<table>?<source-state-filter>&select=id\"}") \
  || { echo "step N (verify sweep) failed" >&2; exit 2; }
count=$(printf '%s' "$remaining" | grep -oE '"id"' | wc -l | tr -d ' ')
if [ "$count" != "0" ]; then
  echo "step N: $count row(s) still in source state after sweep; rerun" >&2; exit 2
fi
```

Use `jq` if it is available (the platform mostly assumes it isn't);
the `grep -oE` patterns above work without `jq`. Note that `jq` paths
differ between the two patterns: `--single` returns `{...}` so use
`.id`; the array form returns `[{...}]` so use `.[0].id`.

#### Conventions every script follows

- **First-line shebang `#!/usr/bin/env bash`**, `set -euo pipefail`
  immediately after, no exceptions. Silent failures in shell are how
  cascade scripts leave half-state.
- **Validate args before any platform call.** Print usage to stderr,
  exit 1. The agent reads stderr to recover.
- **Exit codes are part of the contract.** 0 = ok, 1 = bad inputs,
  2 = platform error. Don't invent more codes; the agent only
  branches on these three.
- **Failure messages name the failed step.** `step 3 (sweep
  <child>) failed` is recoverable; `error` is not.
- **Idempotent.** A repeat run on partially-applied state must
  either complete or be a deterministic no-op. For cascade scripts,
  filter writes to "rows still in the source state", not "all rows
  in the parent set"; running twice then becomes safe.
- **No interactive prompts.** The agent invokes non-interactively.
  If the operation needs a user confirmation, the JTBD is a
  `reference`, not a `script`.

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

The `description` is the **single line a non-technical person reads
on the catalog card** before deciding whether to open the skill.
It must follow the same audience and verb logic as the body's
skill-explanation paragraph (Step 3.4 §3), compressed to one
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
  rule used in the body paragraph (Step 3.4 § "Verb-extraction
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
  fields — they should be recognisable to an operator of the system.

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
itself names *capabilities*, not benefits — the body paragraph's
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
- `Plans headcount across scenarios so an approved scenario walks into real seats with the right paperwork at every step.` (Same anti-pattern — "so [outcome]" clause replaces the capability list.)
- `This skill helps with the Applicant Tracking System.` (Self-referential opener, restates the title.)

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
   ten quoted phrases, the bullet list has ten bullets.
5. **Semantic model.** A Mermaid diagram copied verbatim from the model
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

**Empty-result handling, in scripts and references.** This is the
third structural check, applied per file. The CLI offers two read
patterns; every read must commit to one. `--single` asserts exactly
one row (exit 1 = not found, exit 2 = ambiguous, bare-object
response); the array default returns `[...]` and may be empty (used
for dedupe, list, count).

For each `<op>.sh` in `scripts/`:

1. Walk every `semantius call ... GET` invocation.
2. For each one, classify it as **`--single`** (the flag is
   present) or **array** (no flag).
3. Verify the surrounding code matches the pattern:
   - `--single` reads need only the exit-code guard
     `|| { echo "...not found or ambiguous"; exit 1; }`. They
     should NOT have a follow-up `grep -q '"id"'` block; that
     would be redundant.
   - array reads need the exit-code guard `|| { ...; exit 2; }`
     PLUS an explicit body check (`grep -q '"id"'`,
     `if [ -z "$<var>" ]`, `[ "$count" = "0" ]`, or equivalent).
     The two together cover transport failure and empty-result.
4. Verify the classification matches intent: a read by `id`,
   unique column, or composite-unique key SHOULD use `--single`;
   a dedupe check, list query, or residual-count check SHOULD NOT.
   A unique-key read without `--single` is a defect even if the
   exit-code + grep pattern is correct, because the assertion
   belongs at the protocol level.
5. Verify the response parsing matches the pattern: `--single`
   responses are bare objects (`grep -oE '"id":"[^"]+"'` without
   `head -n1`, `jq '.id'` not `jq '.[0].id'`); array responses
   need `head -n1` or `[0]`. A mismatch silently produces empty
   strings and corrupts downstream steps.

For each `<jtbd>.md` in `references/`:

1. Count `semantius call ... GET` invocations in the `## Recipe`
   block (call this `R`).
2. Count `# expect:` annotations on those invocations.
3. Annotations must equal `R`. If a GET has no `# expect:` line,
   add one. The annotation must name which pattern the call uses:
   - `--single`: "exit 0 returns one row as `{...}`; exit 1 = not
     found, refuse and tell the user '<entity> not found'."
   - array: "response is `[...]`; `[]` means <branch action>; one
     or more rows means <branch action>."
4. Verify the call itself matches the annotation: `--single` is
   present iff the annotation says `--single`. A unique-key lookup
   without `--single` in the call (even if the annotation is
   present) is a defect; fix the call.
5. Repeat for every `POST`, `PATCH`, `DELETE` in the recipe whose
   effect is supposed to change state: each needs an `# expect:`
   line describing the response that confirms the change. Use
   `--single` on writes that target exactly one row; the
   annotation says so, the call carries the flag.

If the JTBD is so simple that no GET has a meaningful "not found"
case (e.g. the only read is by a UUID the agent just created), the
`# expect:` annotation can say so explicitly: `# expect: --single,
row exists because we just POSTed it; exit 1 means a concurrent
delete happened, abort and tell the user`. The annotation still
appears; it cannot be omitted just because the failure case is
rare. Use `--single` here too; the assertion is part of the
intent.

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
  the underlying column must appear in the glossary, FK cheatsheet,
  or "what the entity carries" line. A query mentioning
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

**Final pass: read it cold.** After applying principles 1–6, set the
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
- The **self-review result** from Step 3.5, either "no issues found"
  or the principles you touched and what you changed (e.g.
  "Principle 1: replaced 2 hardcoded timestamps with placeholders;
  Principle 3: surfaced `tag_name` uniqueness in the glossary;
  Principle 5: tightened `comment_label` cut-rule to a deterministic
  algorithm; Principle 6: dropped `planned` from the Triage Inputs
  table to remove a contradiction with the Schedule routing rule").
  This gives the user a quick audit trail.
- The **file-tree size profile**, one line:
  `SKILL.md <N> lines, references/ <M> files (<lo>-<hi> lines each),
  scripts/ <K> files`. Surfacing this gives the user a feel for
  whether the split landed in a reasonable place; a 700-line SKILL.md
  with empty `references/` is a signal the classifier was too
  conservative.

---

## What this skill does **not** do

- It does not run `semantius` itself, recipes are written, not executed.
- It does not deploy the model, that's `semantic-model-deployer`.
- It does not generate evals, add via `skill-creator` later.

## Re-running on an updated model

Regenerate into the same target folder. `SKILL.md` and `README.mdx`
are overwritten in place. The `references/` and `scripts/` folders
need a small extra step: a JTBD that existed in the previous run but
no longer earns a Pass-3 spot leaves an orphan file behind. Before
writing, list the existing `references/*.md` and `scripts/*.sh`,
diff against the new generation's output, and **ask the user** before
deleting any orphan: it may have been hand-edited or referenced
externally. Default to keeping orphans and noting them in the Step 4
summary as "stale, not regenerated, consider removing".

If the user has hand-edited any file, ask before overwriting, diff
first, then merge or replace. The `README.mdx` is the most likely
candidate for hand-editing (humans tweak narrative copy more often
than agents tweak recipes); reference files are a close second
(domain experts often refine the failure-mode prose).

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
