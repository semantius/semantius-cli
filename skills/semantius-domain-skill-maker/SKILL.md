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

The skill **links back** to the model file (absolute or repo-relative path)
rather than duplicating its field tables. Because the SKILL.md no longer
sits next to the model, always use a path that resolves regardless of
where the skill is loaded from — an absolute path is safest.

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

Use the **same nine patterns** as `semantius-agent-maker` (A–I) and the
same skip rules. They are not duplicated here — read them in
`<skills-root>/semantius-agent-maker/SKILL.md` (Step 2) and apply them
unchanged.

The difference is what you do with the result:

- `semantius-agent-maker` emits one SKILL.md per job.
- **This skill emits one SKILL.md with one section per job.**

Aim for 5–12 jobs. If the count grows beyond ~12, suggest the user switch
to `semantius-agent-maker` — a single skill that long under-triggers.

Present the JTBD list to the user for confirmation before writing files.
This is the only human checkpoint.

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
---

# <system_name> domain skill

**Model:** [<system_name>](<relative-path-to-model.md>)
**Platform layer:** delegates to `use-semantius` for CLI, schema rules,
and CRUD/cube mechanics. This skill adds the domain map and the
jobs-to-be-done.

If a task is purely about *defining* schema, permissions, or running
ad-hoc queries against tables you already know, use `use-semantius`
directly — that's faster than going through this skill.

---

## Domain glossary

<One short table. Pull `singular_label`s, table names, and a one-line
"what it represents" for each entity. Group related entities together
(e.g. "Pipeline: leads, opportunities, accounts"). Skip junction tables
unless a job touches them directly.>

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
Note any unique / 1:1 constraints that commonly cause 409s.>

- `opportunities.lead_id → leads.id`
- `accounts.opportunity_id → opportunities.id` (unique — one account per
  closed-won opportunity)

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

**Failure modes:** <2–3 most likely failures — FK violation, status not
in allowed source set, uniqueness collision — and how to recover.>

---

### <next job…>

…

---

## Guardrails

<Domain-specific rules the calling model should never violate. Pull
from §6 of the model and from the patterns above. Examples:

- Never PATCH `opportunities.stage` directly to `closed_won` without
  setting `closed_date` and `won_amount` in the same call.
- `accounts` rows are only created via the close-won flow — never
  insert directly.
- `*_status` flips in this domain are not idempotent; always read
  current status before writing.>

## What this skill does NOT do

- Schema changes — use `use-semantius` directly.
- RBAC / permissions — use `use-semantius` directly.
- One-off seed data — write a script, don't bake it into a JTBD.
- Anything in §6 "Future considerations" of the model.
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
- **Audit-logged entities** — Semantius handles audit rows automatically.
  Mention only if the calling agent might worry the recipe is silent.
- **1:1 / unique constraints** — flag in **Failure modes** with the
  exact 409 condition.

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
- The JTBD list (one bullet each).
- Any patterns that fired but were skipped, with reasons (so the user
  can ask for them if they disagree).
- A one-line note: "If the JTBD count grows past ~12, switch to
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
