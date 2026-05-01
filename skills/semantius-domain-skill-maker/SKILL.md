---
name: semantius-domain-skill-maker
description: >-
  Generate ONE consolidated, domain-specific Claude Code skill from a Semantius
  semantic-model file (`*-semantic-model.md`). Use when the user wants "a single
  CRM skill", "one skill for this model", "wrap the workforce model in a skill",
  "make a domain skill that extends use-semantius", or any phrasing that asks
  for a single skill (not a folder of skills, not an A2A agent) on top of an
  existing semantic-model file. Distinct from `semantius-agent-maker`, which
  emits many skills + an A2A agent card; this skill emits exactly one SKILL.md
  that delegates platform mechanics to `use-semantius` and adds the domain
  glossary, jobs-to-be-done, and guardrails on top.
---

# semantius-domain-skill-maker

Turn a semantic-model markdown file (the artifact produced by
`semantic-model-analyst`) into **one** task-aware Claude Code skill that wraps
the model with domain knowledge. The generated skill does not duplicate
`use-semantius` — it sits on top of it.

This is the lightweight counterpart to `semantius-agent-maker`. Use it when
you want a single trigger ("CRM stuff") rather than many narrow ones.

---

## When to use this vs `semantius-agent-maker`

| Need | Use |
|---|---|
| Quick start, one trigger, easy to edit | **this skill** |
| A2A agent card, separate skills per JTBD | `semantius-agent-maker` |
| Few JTBDs (≤ ~8) or unclear which matter | **this skill** |
| Many JTBDs, distinct guardrails per task | `semantius-agent-maker` |
| Prototyping a new domain | **this skill** (split later) |

If both fit, prefer this one. Splitting a fat skill later is cheap;
consolidating many small skills is not.

---

## Inputs

- `MODEL_PATH`: absolute path to a `*-semantic-model.md` file with valid
  frontmatter (`system_slug`, `system_name`, `entities`, etc.) and §3
  entity definitions.

## Output

A single folder under the user's Claude skills root:

```
<skills-root>/<modelslug>/
└── SKILL.md
```

`<modelslug>` is the model's `system_slug` with **all underscores and dashes
removed** (e.g. `customer_relations` → `customerrelations`). The folder name
and the SKILL.md `name` frontmatter match exactly.

`<skills-root>` resolution order:

1. **Project skills root** — the nearest `.claude/skills/` directory walking
   up from the model file's location, or from the current working directory.
   Prefer this if found.
2. **User skills root** — `~/.claude/skills/` (on Windows:
   `%USERPROFILE%\.claude\skills\`).

If both exist, ask the user which to use; default to the project root. If
neither exists, ask before creating one.

### Source-of-truth and the model reference

The generated SKILL.md is **self-contained at runtime** — its glossary,
enums, FK cheatsheet, and recipes resolve every value at generation time so
the calling agent never needs to open the model file to act.

The model file is still referenced, but only as **provenance metadata in
frontmatter** (`semantic_model:` key — see the template below), not as a
clickable link in the body. Two reasons:

- A body link invites the agent to fetch a 400+ line file the SKILL.md
  has already condensed. That defeats the point of generating the skill.
- Provenance still needs to live somewhere — for re-generation, audit, and
  drift detection — and frontmatter is the right place because it's
  machine-readable and the agent doesn't render it as a follow-up action.

Use an absolute path for `semantic_model` because the SKILL.md no longer
sits next to the model.

---

## Workflow

### Step 0 — Load the Semantius reference

Before writing recipes, read the `use-semantius` skill so the JTBD recipes
use the right CLI patterns:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
Read: <skills-root>/use-semantius/references/crud-tools.md
Read: <skills-root>/use-semantius/references/cube-queries.md
```

You will not run `semantius` yourself in this skill — but the recipes you
bake in must be valid CLI invocations. If `use-semantius` cannot be located,
stop and ask the user.

### Step 1 — Parse the model

Read `MODEL_PATH` and extract:

- `system_slug`, `system_name`, `domain` from frontmatter.
- Entity list with `singular_label`, `label_column`, fields (name, format,
  required), enum values (§5), FK relationships (§4), parent/cascade-child
  flags, `audit_log`.

Compute `modelslug = system_slug.replace(/[_-]/g, "")`.

Refuse if §6.1 lists open blockers — the model is not finished and the
skill would bake in wrong recipes.

### Step 2 — Reason about jobs to be done

JTBD discovery is a two-pass process: **nominate** broadly with the shared
patterns, then **filter** with the merit test. The merit test matters more
here than in `semantius-agent-maker` because every section sits in one
file — slack adds noise to every load, not just to one rarely-triggered
sibling skill.

#### Pass 1 — Nominate with the shared patterns

Apply the **same nine patterns (A–I)** and the same skip rules from
`<skills-root>/semantius-agent-maker/SKILL.md` (Step 2). Read them once
and walk all of them; the patterns are generic across domains, so don't
short-circuit because the model "looks like" only one pattern.

Two pattern-level adjustments specific to this skill:

- **Pattern I (cross-entity reporting) does not become a JTBD section
  here.** Promote it instead to a `## Common queries` appendix at the
  end of the SKILL.md — 3–5 pre-shaped cube queries the calling agent
  can adapt. Reporting is largely `use-semantius` territory once the
  schema is known; baking in *example queries* is useful, but framing
  it as a "job" misleads the calling agent into routing every analytic
  question through this skill.
- **Pattern H (bulk ingest) becomes a one-line pointer**, not a recipe,
  unless the model declares webhook receivers explicitly. If it does,
  write a JTBD; otherwise the SKILL.md just notes "for CSV import, see
  `use-semantius` `references/webhook-import.md`".

#### Pass 2 — Apply the merit test (earn-its-place filter)

For each candidate from Pass 1, ask: *would the calling agent get this
right with `use-semantius` alone?* If yes, drop the candidate — an extra
section is just noise, the calling agent should call `use-semantius`
directly. A candidate **earns** a section only if it answers YES to ≥1
of the following:

| Merit signal | What to check in the model |
|---|---|
| **Caller-populated label** | Junction or sub-entity has a required `*_label` column distinct from any `label_column`, with no DB-level default. The recipe must compose the label client-side — not obvious from the schema alone. |
| **Computed field** | A stored numeric/derived field (e.g. `rice_score`, `total_amount`, `days_open`) whose value depends on sibling fields. The recipe must recompute on every relevant PATCH. |
| **DB-unguarded lifecycle gate** | Status enum where some transitions are valid and others aren't, but the DB accepts any value. The recipe must read-before-write. |
| **DB-unguarded invariant across FKs** | E.g. `features.release_id` and `features.product_id` must agree on product. The recipe must read both rows and check before patching. |
| **Cascade flow** | Flipping one parent row should flip a filtered set of children in the same logical operation (e.g. release-shipped → its planned/in-progress features → shipped). |
| **Junction without uniqueness** | M:N junction without a DB-level unique constraint on the natural key. The recipe must dedupe-before-insert. |
| **Materialization / handoff** | One entity row spawns rows in a different table (Pattern C). The order, FK back-pointers, and source-status flip are easy to get wrong. |
| **Side-effect fields on transition** | `approved_at`, `committed_at`, `actual_release_date`, etc. that must be set in the same PATCH as the status flip — easy to forget. |
| **Audit-trail read** | Audit-logged entity (`audit_log: true`) where "who/when changed X" is a likely user question. Worth a short recipe even though writes need no special handling. |

If the only thing a candidate does is single-table CRUD with the platform
defaults (no merit signals), drop it. List dropped candidates in the Step
4 summary as `skipped: pure CRUD against <table> — calling agent uses
use-semantius directly`. This is not a failure; it is the design.

#### Sizing

After filtering, aim for **5–10 sections** plus the optional `Common
queries` appendix.

- Fewer than 5 sections after filtering: the model may be too thin to
  justify a domain skill. Tell the user; ask whether to ship it anyway
  or extend `use-semantius` with a glossary file instead.
- More than ~10 sections after filtering: a single skill that long
  under-triggers. Recommend `semantius-agent-maker` for finer trigger
  granularity (one skill per JTBD).

#### Confirmation checkpoint

Present three lists to the user:

1. **Sections** — the JTBDs that earned a place (one bullet each, with
   the merit signals that justified them).
2. **Common queries** — the cube queries that go in the appendix.
3. **Skipped** — Pass-1 candidates that failed the merit test, with the
   reason. The user may disagree and ask to add some back.

Wait for confirmation before writing files. This is the only human
checkpoint.

### Step 3 — Write the consolidated SKILL.md

Use the template below. Resolve every reference at generation time
(enum values, FK target tables, required-on-create field sets) — the
calling agent must not need to consult the semantic-model file to fill
in fields.

#### SKILL.md template

````markdown
---
name: <modelslug>
description: >-
  <One paragraph. Lead with the domain ("Use this skill for anything
  involving <system_name> — <one-line domain summary>"). List 4–6
  realistic trigger phrases users might say, mixing entity names and
  task verbs (e.g. "create a lead", "convert opportunity to account",
  "report pipeline by stage"). Be slightly pushy — skills under-trigger
  by default. Mention that the skill delegates platform mechanics to
  `use-semantius` so the model knows both can load together.>
semantic_model: <absolute-path-to-model.md>
generated_from: semantius-domain-skill-maker
---

# <system_name> domain skill

This skill carries the domain map and the jobs-to-be-done for
<system_name>. Platform mechanics — CLI install, env vars, PostgREST
URL-encoding, `sqlToRest`, cube `discover`/`validate`/`load`, and
schema-management tools — live in `use-semantius`. Assume it loads
alongside; do not re-explain CLI basics here.

If a task is purely about defining schema, managing permissions, or
running ad-hoc queries against tables you already know, call
`use-semantius` directly — going through this skill adds nothing.

**Auto-managed fields** (set by Semantius on every table; never include
in POST/PATCH bodies): `id`, `created_at`, `updated_at`, and the
`label` column derived from each entity's `label_column`.

---

## Domain glossary

<One short table. Pull `singular_label`s, table names, and a one-line
"what it represents" for each entity. Group related entities together
(e.g. "Pipeline: leads, opportunities, accounts"). Skip junction tables
unless a job touches them directly. Do not duplicate FK targets here —
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
- `accounts.opportunity_id → opportunities.id` (unique — one account per
  closed-won opportunity)

<List audit-logged tables here in one line so the calling agent knows
audit rows write themselves. Example: "Audit-logged: `opportunities`,
`accounts` — Semantius writes the audit rows; recipes don't manage
them.">

---

## Jobs to be done

<One H2 per JTBD. Each section follows the structure below. Order
sections by typical lifecycle (create → progress → close → report),
not alphabetically.>

### <Job title — verb phrase>

**Triggers:** `<phrase 1>`, `<phrase 2>`, `<phrase 3>`

**Inputs:**

| Name | Required | Notes |
|---|---|---|
| `<input>` | yes/no | <where it comes from> |

If a required input is missing, look it up first via `postgrestRequest`
against the relevant table — don't ask the user unless the lookup is
ambiguous.

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
*recovery action* the calling agent can take — not just "this fails":

- `409 on accounts.opportunity_id` (uniqueness) → an account already
  exists for this opportunity; PATCH the existing row instead.
- FK violation on `lead_id` → the lead was deleted; ask the user
  whether to recreate it or abort the conversion.>

---

### <next job…>

…

---

## Common queries

<Optional appendix from Pattern I — pre-shaped cube queries for
reporting tasks. These are *not* JTBDs; they're examples the calling
agent can adapt. Open with one note, then 3–5 query blocks.>

Always run `cube discover '{}'` first to refresh the schema. Match the
dimension and measure names below against what `discover` returns —
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
should appear here *or* in the relevant JTBD's failure-modes — not both.
Pull from §6.1 of the model (resolved blockers / explicit constraints)
and from the merit signals that triggered each JTBD. Examples:

- Never PATCH `opportunities.stage` directly to `closed_won` without
  setting `closed_date` and `won_amount` in the same call.
- `accounts` rows are only created via the close-won flow — never
  insert directly.
- `*_status` flips in this domain are not DB-guarded; always read
  current status before writing.
- Junction labels are caller-populated — see each junction JTBD for the
  composition convention.>

## What this skill does NOT do

- Schema changes — use `use-semantius` directly.
- RBAC / permissions — use `use-semantius` directly.
- One-off seed data — write a script, don't bake it into a JTBD.
- <Inline the bullet list of unbuilt features here. Pull each item from
  §6.2 "Future considerations" of the model at generation time and
  write it as a plain bullet — do *not* cite "§6.2" in the SKILL.md,
  the calling agent has no way to look it up. If §6.2 is empty or
  missing, drop this bullet entirely.>
````

#### What goes into each recipe — concretely

When you bake a recipe, **resolve every reference**:

- **Enum values** — copy verbatim from §5. Write `"stage":"closed_won"`,
  not `"stage":"<terminal value>"`.
- **FK fields** — list by name with target table; if the agent passes a
  human-friendly value (an email, a code), the first recipe step is the
  lookup that resolves it to an id.
- **Required-on-create field sets** — the model's `Required` column is
  intent, not platform-enforced. Spell out the business-required fields
  per JTBD; they often differ from create vs update.
- **Audit-logged entities** — Semantius handles audit rows automatically
  on writes; recipes don't manage them. The non-obvious case is *reading*
  the audit trail. If the merit test surfaced an audit-read JTBD, the
  recipe is a single GET against the audit endpoint with the entity id —
  see `use-semantius` `references/crud-tools.md` for the path shape.
- **1:1 / unique constraints** — flag in **Failure modes** with the
  exact 409 condition *and* the recovery action (PATCH the existing row,
  pick a different parent, etc.).
- **Cube queries in the appendix** — always lead with
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

### Step 4 — Summarize

Print to the user:

- The folder created: `<skills-root>/<modelslug>/` (state which root was
  used — project or user).
- The **sections written** (one bullet each, with the merit signal that
  earned the spot, e.g. "Vote on a feature — junction without uniqueness
  + caller-populated label").
- The **Common queries** baked into the appendix (titles only).
- The **dropped candidates** with reasons (e.g. "manage-tag — pure CRUD
  on `tags`, no merit signal — calling agent uses use-semantius
  directly"). The user may ask to add some back.
- A one-line note: "If sections grow past ~10, switch to
  `semantius-agent-maker` for finer trigger granularity."

---

## What this skill does **not** do

- It does not run `semantius` itself — recipes are written, not executed.
- It does not deploy the model — that's `semantic-model-deployer`.
- It does not generate an A2A agent card — that's `semantius-agent-maker`.
- It does not generate evals — add via `skill-creator` later.

## Re-running on an updated model

Safe by design: regenerate into the same target folder. The single
SKILL.md is overwritten. No orphan-folder concerns (unlike
`semantius-agent-maker`), because there is only one skill.

If the user has hand-edited the generated SKILL.md, ask before
overwriting — diff first, then merge or replace.

## Failure modes

- **Model file missing required frontmatter** — stop and ask. Don't
  guess `system_slug`.
- **Model file has open §6.1 blockers** — refuse. Tell the user to
  resolve blockers in `semantic-model-analyst` first.
- **Conflicting target folder** — if `<skills-root>/<modelslug>/`
  already exists and the SKILL.md was not generated by this skill
  (no link back to the model file in its header), stop and ask before
  overwriting.
- **JTBD count > ~12** — warn the user; recommend
  `semantius-agent-maker` instead, but proceed if they confirm.
