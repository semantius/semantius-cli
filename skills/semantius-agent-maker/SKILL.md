---
name: semantius-agent-maker
description: >-
  Generate task-oriented Claude Code skills and an A2A agent card from a
  Semantius semantic-model file (`*-semantic-model.md`). Use whenever the user
  wants to "generate skills/agent for this model", "make an A2A agent for the
  workforce model", "turn this semantic model into runnable jobs", "produce an
  agent card for this model", or any phrasing that asks to derive callable
  workflows or an agent definition from an existing semantic-model file. Also
  trigger proactively when a `*-semantic-model.md` file is present and the
  user references skills, agents, A2A, or "jobs to be done" against it. The
  skill reasons about jobs once, at generation time, and bakes concrete
  `semantius` CLI recipes into each generated skill so that calling agents
  just execute them — they do not re-derive workflows from the model.
---

# semantius-agent-maker

Turn a semantic-model markdown file (the artifact produced by
`semantic-model-analyst`) into:

1. A folder of task-oriented Claude Code skills, one per job-to-be-done that
   the model supports.
2. An [A2A](https://a2aproject.github.io/A2A/) `agent-card.json` describing
   those skills as a callable agent.

The point of this skill is to do the reasoning **once**, at generation time,
so that downstream agents (human or A2A clients) can just call a job by name
and follow the baked recipe — they do not read the semantic model and
re-derive what to do every time.

---

## Inputs

- `MODEL_PATH`: absolute path to a `*-semantic-model.md` file with valid
  frontmatter (`system_slug`, `system_name`, `entities`, etc.) and §3
  entity definitions.

## Outputs

All artifacts go into a single folder next to the model file:

```
<model-dir>/agents/<modelslug>/
├── agent-card.json
├── <modelslug>-<job-1>/
│   └── SKILL.md
├── <modelslug>-<job-2>/
│   └── SKILL.md
└── ...
```

`<modelslug>` is the model's `system_slug` with **all underscores and dashes
removed** (e.g. `workforce_planning` → `workforceplanning`). This produces
short, prefix-safe skill names (`workforceplanning-open-requisition`) that
remain unambiguous when many model-agents are loaded into one Claude Code
session.

`<job-…>` is a kebab-case verb-phrase (`open-requisition`,
`stage-headcount-action`, `commit-scenario`, `report-headcount`).

## Source of truth

Generated skills **link back** to the model file rather than duplicating its
field tables. This keeps recipes thin and prevents drift. If the model
changes, the user re-runs this skill; recipes regenerate, the link survives.

---

## Workflow

### Step 0 — Load the Semantius reference

Before reasoning about jobs, read the `use-semantius` skill so the recipes
you bake in use the right CLI patterns:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
Read: <skills-root>/use-semantius/references/crud-tools.md
Read: <skills-root>/use-semantius/references/cube-queries.md
```

You will not run `semantius` yourself in this skill — but the recipes you
write must be valid CLI invocations. If `use-semantius` cannot be located,
stop and ask the user.

### Step 1 — Parse the model

Read `MODEL_PATH` and extract:

- `system_slug`, `system_name`, `domain` from frontmatter.
- The entity list (§2 / §3) with each entity's:
  - `singular_label`, `label_column`
  - all fields (name, format, required)
  - all enum fields and their value lists (§5)
  - all FK relationships (§4)
  - whether it is a *parent* of another entity (cascade child)
  - whether `audit_log: true`

Compute `modelslug = system_slug.replace(/[_-]/g, "")`.

### Step 2 — Reason about jobs to be done

This is the only step where **judgment** is required. Walk every detection
pattern below against the model. Each is a *shape test* — if the model
has the shape, the pattern nominates jobs; if not, it produces zero. More
patterns does not mean more jobs, it means broader coverage.

The downstream skills are static recipes, so err on the side of **fewer,
sharper jobs** rather than one skill per CRUD verb. A good target is 5–12
jobs for a model with ~10 entities.

The patterns are **generic across domains** — not just transactional
business models. Walk all of them every time, regardless of what the
model "looks like" at first glance.

#### Pattern A — Lifecycle transitions on status enums

**Shape test:** entity has a `*_status` enum + side-effect fields like
`approved_at`, `approved_by_*`, `committed_at`.

Each non-trivial transition (more than a status flip) becomes a job.
Pure status flips with no side effects collapse into the entity's primary
lifecycle skill.

Example (workforce planning):
`headcount_plans.plan_status` → **create-headcount-plan**, **approve-plan**;
`scenarios.scenario_status` + `is_active_for_plan` → **create-scenario**,
**mark-scenario-active**; `hiring_requisitions.requisition_status` →
**open-requisition**, **fill-requisition**.

#### Pattern B — Polymorphic action/event staging

**Shape test:** entity named `*_actions`, `*_events`, `*_transactions`,
`*_movements`, with a polymorphic `*_type` enum that fans out behavior.

One staging skill per such entity, with branches per type value inside
the same SKILL.md. Do not split into one skill per enum value — that
produces overlapping skills.

#### Pattern C — Materialization / handoff

**Shape test:** entity exists so another entity can be created from it;
look for `originated_from_*_id` back-pointers, or "approved → real" flows
where a staging row spawns one or more rows in a different table.

These are the highest-value jobs because they touch multiple tables and
are the most error-prone for a calling agent to derive.

Example: `headcount_actions.committed → positions` → **commit-scenario**.

#### Pattern D — Hierarchy operations

**Shape test:** self-referencing FK like `parent_*_id`, `manager_*_id`,
`backfill_for_*_id`; tree-shaped data.

Jobs: **reparent-X** (move a sub-tree without orphaning), **roll-up-X**
(aggregate up the tree), cycle prevention. Skip if the self-FK is purely
informational (e.g. "previous version of this row") with no operation that
restructures the tree.

#### Pattern E — Ownership / sharing

**Shape test:** `owner_*_id` field, sharing tables, multi-tenant scoping
via a tenant FK on most entities.

Jobs: **transfer-ownership-of-X**, **share-X-with**, **revoke-access-to-X**.

#### Pattern F — Publication / versioning

**Shape test:** `draft`/`published` states distinct from approval, version
chains (`*_version`, `previous_version_id`), `published_at` separate from
`created_at`.

Jobs: **publish-X**, **unpublish-X**, **create-new-version-of-X**.
Distinct from Pattern A approval — publication is about distribution, not
sign-off, and the side effects differ (cache invalidation, notification,
visibility scope).

#### Pattern G — External-system handoff

**Shape test:** fields like `external_*_url`, `*_external_id`,
`webhook_*` entities, or a status value such as `synced`/`failed`.

Jobs: **sync-X-to-external**, **replay-failed-X**, **reconcile-X**.

#### Pattern H — Bulk ingest

**Shape test:** model declares webhook receivers, or has an entity whose
typical population unit is a batch (a CSV-shaped table with no parent
beyond the batch).

Job: **import-X-from-csv** that uses the webhook-import flow.

#### Pattern I — Cross-entity reporting

**Shape test:** 3+ entities joined by FKs and at least one numeric measure
(cost, count, duration, FTE, amount).

One **report-<domain>** skill using Layer 3 (`cube discover` + `cube load`).
Bake in 2–4 concrete example queries (e.g. headcount by department, cost
by cost-center, open positions by location).

#### Skip rules

Do **not** generate a skill for any of the following — they fall outside
the "job to be done" frame:

- **Single-row CRUD on master-data tables** with no lifecycle (insert one
  department, edit a job code). The calling agent uses `use-semantius`
  directly; an extra skill is just noise.
- **Seed / sample / test-data population.** This is a one-off developer
  task, not a recurring job. If the user wants a seed script, they can
  ask for one separately — it does not belong in the agent.
- **Entities listed in §6 "Future considerations"** — they don't exist yet.
- **Pure read-by-id lookups** — the calling agent uses `postgrestRequest`
  directly.

#### When none of the patterns fire

If a model has shapes none of the patterns recognize (rare, but possible
for unusual domains), name the unmatched shape explicitly in the
confirmation step and ask the user whether it warrants a custom job.
Do not invent a job to fill space.

#### Output of step 2

A list of jobs, each with:

```yaml
- slug: open-requisition          # kebab-case verb phrase
  title: Open a hiring requisition
  description: Create a hiring_requisition record for an open or
               approved-future position and hand the seat to recruiting.
  primary_entity: hiring_requisitions
  touches: [positions, employees]
  inputs: [position_id, recruiter_employee_id?, target_fill_date?]
  outputs: [requisition_id, requisition_number]
  triggers:
    - "open a req for position POS-00123"
    - "hand this position off to recruiting"
    - "create a hiring requisition"
```

Present this list to the user for confirmation before generating files.
This is the only human checkpoint — once they say "go", the rest is
mechanical.

### Step 3 — Generate one skill per job

For each job, write `<model-dir>/agents/<modelslug>/<modelslug>-<slug>/SKILL.md`
using the template below. The recipe inside must be **executable as-is** —
the calling agent must not need to consult the semantic-model file to fill
in fields, FK targets, or status transitions.

#### SKILL.md template

```markdown
---
name: <modelslug>-<slug>
description: >-
  <one-paragraph description; lead with the job; list 3–5 trigger phrases
  the user might say; mention the primary entity by table name and label.
  Be slightly pushy about triggering — see skill-creator guidance.>
---

# <modelslug>-<slug>

**Job:** <title>
**Model:** [<system_name>](<relative-path-to-model.md>)
**Primary entity:** `<primary_entity>` — <singular_label>

## When to use

<2–4 bullets describing the situations this skill handles, including
variants if Heuristic B applied.>

## Inputs

| Name | Required | Notes |
|---|---|---|
| `<input>` | yes/no | <where it comes from — usually a prior read> |

If any required input is missing, look it up first using
`semantius call crud postgrestRequest` against the relevant table — do not
ask the user unless the lookup is ambiguous.

## Recipe

<Numbered steps. Each step is one or more `semantius` invocations with
fully-formed JSON. Use the actual field names and enum values from the
model — do not write placeholders.

For status-flip steps, name the exact `from → to` transition and any
side-effect fields that must be set in the same PATCH (e.g. `approved_at`,
`committed_at`, `approved_by_employee_id`).

For materialization steps (Heuristic C), spell out: read source rows,
construct target rows with the FK back to the source, insert in the
correct order, then PATCH the source's status to `committed`.>

```bash
# 1. Look up the position
semantius call crud postgrestRequest '{"method":"GET","path":"/positions?position_code=eq.POS-00123&select=id,position_status,department_id"}'

# 2. Verify status is `open` or `approved_future`
# (skill checks this, no separate command)

# 3. Create the requisition
semantius call crud postgrestRequest '{
  "method":"POST",
  "path":"/hiring_requisitions",
  "body":{
    "requisition_number":"REQ-2026-0123",
    "position_id":"<id from step 1>",
    "requisition_status":"open",
    "opened_date":"2026-04-26",
    "recruiter_employee_id":"<optional>",
    "hiring_manager_employee_id":"<optional>"
  }
}'
```

## Validation

<Bullet list of post-conditions to check with a follow-up GET. Keep it
short — only the ones that have actually been broken in practice.>

## Failure modes

<Bullet list of the 2–3 most likely things to go wrong (FK violation,
status not in the allowed source set, uniqueness collision) and how to
recover.>

## Related skills

<Cross-links to sibling skills in the same agent that commonly come
before/after this one.>
```

#### What goes into the recipe — concretely

When you bake the recipe, **resolve every reference**:

- Enum values: copy from §5 of the model, not abstract terms. Write
  `"action_status":"committed"`, not `"action_status":"<terminal value>"`.
- FK fields: list them by name with the target table — e.g.
  `position_id → positions.id`. If the calling agent passes a
  human-friendly value (a `position_code`), the first step of the recipe
  must be the lookup that resolves it to an id.
- Required-on-create vs required-on-update: the model's `Required` column
  is intent, not platform-enforced. For *create* steps, list the fields the
  business rule requires (e.g. `add` action requires `job_id`,
  `department_id`, `location_id`, `cost_center_id`, `effective_date`,
  `fte`); for *transfer* it's a different set. Make the variants explicit.
- Audit-logged entities: nothing extra to do — Semantius handles audit
  rows. Mention it in passing only if the user might worry the recipe
  isn't writing audit data.
- 1:1 / unique constraints: highlight in **Failure modes** (e.g.
  `positions.current_employee_id` is unique — assigning an employee who
  already fills a position will 409).

#### Trigger-phrase quality

The `description` frontmatter is what makes Claude Code consult the skill.
Bake in 3–5 realistic phrasings, including ones that don't name the
entity by its table name (`"open a req"` as well as
`"create hiring requisition"`). Be slightly pushy — skills under-trigger
by default.

### Step 4 — Generate the A2A agent card

Write `<model-dir>/agents/<modelslug>/agent-card.json` following the A2A
[`AgentCard`](https://a2aproject.github.io/A2A/specification/#agent-card)
schema:

```json
{
  "name": "<modelslug>-agent",
  "description": "<one-line: what this agent owns. Pull from system_name + domain. e.g. 'Workforce planning agent backed by the Workforce Planning semantic model. Owns headcount plans, scenarios, headcount actions, positions, and hiring requisitions.'>",
  "url": "<placeholder if unknown — e.g. 'https://example.invalid/agents/<modelslug>'>",
  "version": "0.1.0",
  "provider": {
    "organization": "<from env or 'unknown'>",
    "url": "<placeholder>"
  },
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "<modelslug>-<slug>",
      "name": "<title>",
      "description": "<same as the SKILL.md description, trimmed to 1–2 sentences>",
      "tags": ["<modelslug>", "<primary_entity>", "<verb e.g. create/transition/report>"],
      "examples": [
        "<one trigger phrase>",
        "<another trigger phrase>"
      ],
      "inputModes": ["text/plain"],
      "outputModes": ["application/json"]
    }
  ]
}
```

Notes:

- The agent's `name` is `<modelslug>-agent` (no `agent-card` suffix — the
  filename carries that).
- Each `skills[].id` matches the generated skill's folder name *and* its
  SKILL.md `name` frontmatter exactly. This is the contract that lets an
  A2A client map a skill invocation to a folder on disk.
- `tags` should always include `<modelslug>` (so a host agent can filter
  to one model) plus the primary entity and a verb category.
- `examples` are pulled from the same trigger phrases used in the SKILL.md
  description — keep them in sync.
- Leave `url` and `provider.url` as `https://example.invalid/...`
  placeholders unless the user has supplied real values; the user
  fills these in when deploying the agent.

### Step 5 — Summarize

Print to the user:

- `<model-dir>/agents/<modelslug>/` — the folder you created.
- A bullet list of the skills you generated (slug + one-line purpose).
- The agent card path.
- Any jobs you considered but deliberately skipped (Heuristic F), so the
  user can ask for them if they disagree.

---

## What this skill does **not** do

- It does not run `semantius` itself. The recipes are written, not executed.
- It does not deploy the model. That's `semantic-model-deployer`'s job; the
  model must already be deployed for the generated skills to work.
- It does not register the agent with an A2A server. That's a separate
  ops step. The card it produces is a static artifact.
- It does not generate tests or evals for the produced skills. Those can
  be added later via `skill-creator`.

## Re-running on an updated model

Safe by design: regenerate into the same target folder. Existing files
are overwritten. If a job disappears from the model (e.g. an entity was
removed), its skill folder will remain orphaned — list any orphans in
the Step 5 summary so the user can delete them.

## Failure modes

- **Model file missing required frontmatter** — stop and ask. Don't guess
  `system_slug`.
- **Model file has open §6.1 blockers** — refuse. The model is not
  finished; generated skills would be wrong. Tell the user to resolve
  blockers in `semantic-model-analyst` first.
- **Conflicting target folder** — if `<model-dir>/agents/<modelslug>/`
  already exists and was *not* generated by this skill (no `agent-card.json`
  inside), stop and ask before overwriting.
