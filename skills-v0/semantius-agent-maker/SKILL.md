---
name: semantius-agent-maker
description: >-
  Generate ONE user-specified Agent Skill (agentskills.io format) on top of a
  Semantius semantic model. Use whenever the user wants to build a custom,
  task-scoped skill against a specific `*-semantic-model.md` and the goal comes
  from them rather than from the model's inherent CRUD shape. Triggers include
  "build a research agent for the enterprise model", "wrap this multi-step
  workflow as a skill on the workforce model", "make a skill that researches /
  reasons / decides about X using the CRM model", "I want an agent that does X
  for the ATS model and writes back via semantius". Especially relevant when
  the skill involves judgment, external lookups (web research, vendor pricing,
  alternative discovery), or multi-step reasoning that ends with deterministic
  writes through `use-semantius`. Differs from `semantius-skill-maker`, which
  auto-derives a batch of deterministic CRUD/lifecycle recipes from the model
  without user input — use this skill when the user brings the task.
---

# semantius-agent-maker

A skill for authoring ONE model-aware Agent Skill against a Semantius semantic
model, where the user supplies the task. The output is a SKILL.md package the
user can install and a calling agent can invoke.

This skill forks the authoring framework from Anthropic's `skill-creator`
(adapted for Semantius model awareness) and composes with `use-semantius` at
runtime (the maker references it; generated skills declare it as a co-loaded
dependency for CLI mechanics).

---

## When to use this skill vs. its siblings

| Situation | Use |
|---|---|
| User says "generate skills for this model" (no specific task) | `semantius-skill-maker` |
| User says "build a skill that does X with this model" (task supplied) | **this skill** |
| User wants to bundle multiple existing skills into an A2A agent card | (separate concern; not this skill's job) |
| User wants the live module reverse-engineered into a model file | `semantic-model-optimizer` |

The defining property of *this* skill: **the user brings the goal**. The
maker's job is to interview them, find the slice of the model the goal
touches, and write a tight, model-aware SKILL.md around it.

---

## Schema compatibility: `EXPECTED_MAJOR = 3`

This skill expects model files written by `semantic-model-analyst` major `3`. Check the model file's frontmatter `version: "MAJOR.MINOR"` at the start of Step 1. **Major must equal `EXPECTED_MAJOR`**, minor is informational. Mismatch handling mirrors `semantius-skill-maker`:

- **Older major** — route the user back to the analyst's Mode D (Rebuild) to migrate the file, then re-run agent-maker.
- **Newer major** — tell the user to update `semantius-agent-maker` before retrying.
- **Missing `version` key** — treat as major `0`; same response as older-major.

When the analyst's major bumps, this skill's `EXPECTED_MAJOR` must move in lock-step with `semantic-model-analyst`, `semantic-model-deployer`, and `semantius-skill-maker`. The quartet shares the major.

---

## Inputs (ask for these up front if not provided)

1. **Path to a `*-semantic-model.md`** in the working directory. Required.
   If missing, the model can be reverse-engineered with
   `semantic-model-optimizer`, but do not invent one.
2. **The task in plain English.** A one- or two-sentence description of what
   the skill should do. Examples:
   - "Research point solutions in a given domain and add the good ones to the catalog."
   - "Given a candidate, run a background check workflow and record the result."
   - "Compare ingredient alternatives by price across vendors and pick one."
3. **Target output path.** Propose
   `<cwd>/.claude/skills/<generated-skill-name>/SKILL.md` and let the user
   override. The generated skill is one folder; bundled resources are optional.

Do not start writing until you have all three. If the user is vague on the
task, interview them (next section) before drafting anything.

---

## Workflow

### Step 1 — Read the model and `use-semantius` references

Gate on the model file's frontmatter `version` major first (see "Schema compatibility" above). Refuse and route the user if the major doesn't match `EXPECTED_MAJOR = 3`; do not parse anything else when the gate fails.

Once the version gate passes, read the supplied model file end to end. Build a mental index of:

- Entity table names and singular labels
- Fields per entity (especially required fields, enums, FK shapes)
- Module slug (URLs use `module_slug`, lowercase)
- **Module type** — read frontmatter `module_type` (`"domain"` or `"master"`, default `"domain"` when absent). A `master` module hosts shared / master data consumed by multiple domain modules; writes to its entities are visible to every consuming domain via cross-module `permission_hierarchy` rows. When the task's slice (Step 3) touches a master module, the generated skill must surface a cross-domain-impact callout on every write recipe.
- **Per-entity `**Shared master cluster:** <cluster>` annotation** — note which entities in this (domain) module are flagged as classic master concepts. This is an authoring hint: those entities may have been (or may soon be) promoted to a master module on re-deploy. Treat the annotation as informational; if the user's task writes to such an entity, include a one-line "shared concept across domains" note in the generated skill so the calling agent is aware.
- Label composition rules and lookup conventions
- Cross-cutting data rules and guardrails
- **Entity-level `Select rule` sub-blocks** — note which entities carry a non-empty `select_rule`. Capture the rule's plain-English **uniform per-row predicate** (from the sub-block's `description`, the entity's §3 prose, or a paraphrase of the JsonLogic intent). **The rule applies uniformly to every caller with `view_permission`** — the platform evaluates the JsonLogic body per row with `$today` / `$now` / `$user_id` as reserved variables; there is no documented mechanism by which holding a specific permission causes the rule to be skipped. If the model's §7 carries an explicit architectural-decision entry naming a documented broadening mechanism (a separate cube view / entity surface admins read, or a Postgres `BYPASSRLS` role attribute), capture that mechanism alongside the predicate. **Never read the §2 Permissions summary for a `<slug>:view_all_<plural>`-style permission and assume the platform honors it as a bypass — that mechanism is not in the current platform spec; promising it in the generated skill ships broken RBAC.**
- **Field-level `Input type rules` entries** — note which fields carry a non-empty `input_type_rule` and what trigger the rule's `description` (or JsonLogic intent) names. Two patterns matter at authoring time: (a) rules that flip a field's effective mode to `required` on a sibling-field transition (typically `*_at` housekeeping fields like `approved_at`, `closed_at`, `submitted_at`) — when the user's task drives that transition, the recipe must include the dependent field in the same PATCH body; (b) rules that flip a field to `readonly` after a terminal state — recipes that update the entity after that state should drop the locked field from their PATCH body.

Be aware of `use-semantius`'s `references/` directory (cli-usage,
data-modeling, rbac, crud-tools, cube-queries, cube-tools, webhook-import).
You do not need to inline these — the generated skill will declare
`use-semantius` as a dependency and the runtime will load them as needed.

### Step 2 — Interview the user

Forked from `skill-creator`'s "Capture Intent" + "Interview and Research".
Adapt for Semantius. Get answers to:

1. **What should the skill enable an agent to do?** Concrete goal, in the
   user's own words.
2. **When should the skill trigger?** Phrasings a real user would type.
3. **What entities does the goal touch?** Validate against the model.
   If the user names an entity that doesn't exist, ask whether to add it
   (via `semantic-model-deployer` later) or pick the nearest existing one.
4. **Where does non-deterministic input come from?** Web search? An external
   API? The user's own judgment in conversation? None (pure CRUD)?
5. **Where does the skill end?** Read-only report? Write to the catalog?
   Multi-step write with user approval gates?
6. **Approval gates.** For writes, must the agent ask before each write,
   or batch and ask once at the end? Default: ask once per logical unit
   of work (one entity creation = one approval, a batch import = one
   approval).
7. **Idempotency.** Re-running the skill on the same inputs — should it
   no-op, append, or update? The default for "research X and write to
   catalog" is **read-first-then-create-if-missing**, never blind insert.
8. **Failure handling.** What's a domain error (refuse) vs. a transient
   error (retry once)?
9. **Read scope** (when any entity the task reads has a `select_rule`). Ask:
   "The model applies a uniform per-row filter on `<entity>` — every caller
   with `view_permission`, including the one running this agent, sees only
   `<plain-English predicate from the rule>`. Does this skill respect that
   uniform scope (the agent acts on what the caller can see), or does the
   task genuinely need to read rows outside the predicate?"

   The default is **respect the scope**; this is the simplest answer and is
   correct for most agent skills. If the user needs broader read access,
   the path depends on what the **model file's §7 already resolves**:

   - If §7 carries an architectural-decision entry naming a documented
     broadening mechanism (option C separate cube view / entity surface,
     option D Postgres `BYPASSRLS` role provisioned outside Semantius),
     wire the generated skill's read step to that mechanism explicitly.
   - If §7 does NOT resolve a broadening mechanism, the skill **cannot
     promise broader read access**. The generated skill says so plainly:
     "broader read access requires running as a caller who holds the
     role with broader visibility; escalate or hand off". Do NOT propose
     a `<slug>:view_all_<plural>` permission as a bypass; that mechanism
     is not documented in the current platform spec, and a generated
     skill that names it ships broken RBAC. If the user thinks they need
     broader access and §7 doesn't cover it, the correct route is to send
     the user back to `semantic-model-analyst` to resolve Stage 12's
     architectural-decision question before generating the skill.

Proactively suggest answers based on what the model implies. Don't make the
user fill every blank from scratch.

### Step 3 — Identify the model slice

Do NOT inline the whole model. Identify only the entities the skill reads or
writes, plus their FK closure (entities referenced by required FKs of the
touched entities).

For each entity in the slice, the generated skill will need:

- Table name and singular label
- Required fields with type and any enum values
- FK fields with the target entity and its key column
- Label composition rule (so the generated skill can build display labels)
- Any cross-cutting rule that applies (e.g. "soft-deactivate, never hard-delete")
- **Master-module / shared-concept callout** — when the entity sits in a `module_type: master` module, OR carries a `**Shared master cluster:** <cluster>` annotation in §3, record this on the slice. The generated SKILL.md surfaces a one-line "Writes to this entity are visible across consuming modules" guardrail on every write recipe touching it; the calling agent should treat the data as shared, not module-private. The slice note does not change the recipe shape (the CLI call is identical), only the surrounding prose.
- **Row-level read scope** when the entity carries a non-empty `select_rule`. Pull the uniform per-row predicate from the Step 1 mental index. The slice notes this so the generated SKILL.md can surface the visibility callout. If the model's §7 named a documented broadening mechanism, capture it; if §7 did NOT, the slice notes only the uniform predicate and routes broader-access requests to escalation — **never invents a `view_all_<plural>` permission bypass**.
- **Conditional UI states** for any field on the entity that carries a non-empty `input_type_rule` AND whose trigger or target lies on the user's task path. Cross-check the user's task against the rule's trigger condition: when the task drives the transition the rule keys on (e.g. the task is "approve the offer" and `approved_at` has `input_type_rule: hidden until status=approved`), record `(entity, field, trigger_field, trigger_value)` as a paired side-effect — the recipe must set the dependent field in the same PATCH as the trigger. Fields whose rule is unrelated to the task path are noise; keep the slice tight.

Entities not in the slice should be **referenced by name only** (one-line note
in the generated skill: "this domain also has X, Y, Z — out of scope").

### Step 4 — Decide the skill's shape

Three shapes, pick one (or hybrid):

- **Pure recipe** — deterministic, fixed steps, no reasoning. Closer to what
  `semantius-skill-maker` produces. If the user's task is really this, push
  back and suggest they run `semantius-skill-maker` instead.
- **Pure reasoning** — judgment, web research, summarization. No model writes.
  Rare — usually the user also wants the result captured somewhere.
- **Hybrid (most common)** — reason at the top (research, compare, decide),
  act at the bottom (write findings to the model via `use-semantius`
  recipes). The reasoning section is open-ended; the action section is a
  tight recipe.

Name the shape explicitly in the generated SKILL.md so the calling agent
knows what to expect.

### Step 5 — Draft the generated SKILL.md

Use the structure in the "Generated skill anatomy" section below. Inline
only the model slice from Step 3. Reference `use-semantius` as a co-loaded
dependency in the frontmatter description (so the runtime loads it
alongside).

Length target: ≤ 500 lines for the generated SKILL.md. If the task genuinely
needs more, split into reference files under `references/` and point at them
from SKILL.md.

### Step 6 — Self-review pass

Before showing the draft to the user, check:

- [ ] Frontmatter description is "pushy" — lists concrete trigger phrases,
      explains when to use vs. skip.
- [ ] The model slice is inlined; entities outside the slice are named but
      not detailed.
- [ ] Every model write uses the `--single` pattern from `use-semantius`
      when exactly-one is expected; array pattern when zero-or-many is the
      normal answer.
- [ ] Every recipe step has an explicit exit-code contract.
- [ ] Read-before-write is enforced anywhere a duplicate is possible.
- [ ] Approval gates are placed where the user said they should be.
- [ ] The "runtime disagreement" rule is included: if the live schema
      contradicts the inlined slice, abort and recommend regenerating —
      do not silently adapt.
- [ ] FK shapes match what the model says today (re-read the model section,
      do not rely on memory).
- [ ] (Analyst v2.2+) Every read recipe against an entity in the slice that
      carries a `select_rule` includes a one-sentence visibility callout
      ("you will see only `<plain-English scope>`"), either inline in the
      recipe or in the entity's slice block. A read with no callout against
      a scoped entity is the silent-empty-result defect — a missing row is
      indistinguishable from no-such-row, and the agent draws the wrong
      conclusion.
- [ ] (Analyst v2.2+) No recipe duplicates a `select_rule` in its own GET
      filter. If the entity's rule filters on `submitter_user_id = $user_id`,
      the recipe's path does NOT add the same filter — the platform applies
      it via RLS, and the client-side duplication is dead code that breaks
      when the analyst updates the rule.
- [ ] (Analyst v2.2+) Every transition recipe that fires a trigger named in
      the slice's "Conditional UI states" block sets the dependent field in
      the same PATCH body. Example: when the slice records `approved_at`'s
      trigger as `status = "approved"`, the "approve offer" recipe's PATCH
      includes both `status = "approved"` and `approved_at = $now`. A
      transition that sets the trigger without the dependent is the
      silent-empty-housekeeping-field defect — the UI would have rendered
      the dependent as `required` at form time, but the recipe has no form.
- [ ] (Analyst v2.2+) No recipe interprets the JsonLogic body of an
      `input_type_rule`. The rule is for the form-rendering layer; recipes
      derive their semantics from the task's own intent (the user's
      interview answers, the entity's `validation_rules`), not by
      re-evaluating the UI rule's body.
- [ ] (Analyst v2.2+ critical rule) **No prose anywhere in the generated
      skill promises a `<slug>:view_all_<plural>`-style permission bypass
      of `select_rule`.** Walk every preamble line, every JTBD visibility
      callout, every Approval-gates entry, every Failure-modes block. If
      any prose names a permission code as a path to "see every row" /
      "bypass the filter" / "broader read access" / "elevated tier", the
      ONLY acceptable shape is: (a) the source model's §7 explicitly
      resolves the broadening mechanism (option C separate cube view,
      option D Postgres `BYPASSRLS` role attribute) AND the prose names
      THAT mechanism, not a permission code; OR (b) delete the prose
      entirely and route broader-access requests to "escalate to a caller
      who holds the role". A prose promise of a permission bypass that
      the platform does not honor is the canonical v2.2 defect — the
      generated skill looks right but silently ships broken RBAC.
- [ ] (Analyst v3.0+) Every write recipe against an entity sitting in a
      `module_type: master` module, or carrying a `**Shared master cluster:**`
      annotation in the source model, includes a one-line cross-domain-impact
      callout ("writes to `<entity>` are visible to every consuming domain
      module"). A silent write against a shared entity is a recipe defect:
      the calling agent may assume the data is module-private and reason
      incorrectly about what its write touches.

### Step 7 — Confirm output path and write

Default: `<cwd>/.claude/skills/<generated-skill-name>/SKILL.md`. The skill
name should be `<model-slug>-<verb-phrase>` — e.g.
`enterprise-research-domain`, `workforce-onboard-employee`,
`ats-screen-candidate`. Verb-first reads cleanly as "what the skill does."

Confirm with the user before writing. If they want the skill under
`agents/<domain>/<skill-name>/` instead (alongside an eventual agent card),
honor that.

### Step 8 — Show the user and iterate

Surface the draft. Ask the user to react to:

- Does the trigger description match how they'd ask for this?
- Is the model slice right, or are there entities you missed/over-included?
- Do the approval gates land where they want them?
- Does the recipe at the bottom look correct for the writes they expect?

Iterate until the user says it's right. Don't add a heavyweight eval loop in
v1 — qualitative review is enough.

---

## Generated skill anatomy

The skill this maker produces follows this structure:

```
<generated-skill-name>/
└── SKILL.md
    ├── Frontmatter (name, description)
    ├── # Purpose (1 paragraph)
    ├── ## Inputs (what the calling agent must supply)
    ├── ## Model slice (entities, FKs, enums, label rules)
    ├── ## Workflow (the reasoning + acting steps)
    ├── ## Recipes (the deterministic writes, with --single / array patterns)
    ├── ## Approval gates (where to pause and ask)
    ├── ## Guardrails (what the skill refuses to do)
    └── ## When the runtime disagrees with this slice (abort + regenerate)
```

Bundled `scripts/` or `references/` are optional and rare for v1 outputs.
Add them only if the SKILL.md crosses 500 lines or if the skill bundles
reusable shell scripts that benefit multiple invocations.

### Frontmatter description rule (pushy triggering)

The description is the primary trigger mechanism. Make it:

- Specific to the model and task (mention entities by name)
- List multiple phrasings a real user would type
- Explain when to use AND when to skip
- Slightly "pushy" — Claude tends to undertrigger skills

Bad: `"A skill for the enterprise model."`

Good: `"Research point solutions for a given domain in the enterprise model.
Use whenever the user wants to add solutions/vendors to the catalog, asks
'what solutions exist for ITSM/CRM/HRIS/...', wants to compare alternatives,
or needs vendor + pricing context for a domain. Pulls web research, dedupes
against the existing catalog, and writes new solutions + vendors + their
domain mappings via use-semantius after user approval. Skip when the user
just wants to read the existing catalog (use a plain query instead)."`

### Model-slice section

For each entity in the slice, write a block like:

```markdown
### `<table_name>` (<singular_label>)

**Module:** `<module_slug>`
**Required fields:**
- `<name>` (<type>) — <one-line meaning>
- `<name>` (<type>, enum: `value1` | `value2` | `value3`)
**FKs:**
- `<field>` → `<target_table>.<key>` (format: reference)
**Label rule:** `<how the display label is composed>`
**Lookup convention:** `<how to resolve user input to a row>`
**Row-level read scope** *(omit when the entity has no `select_rule`)*:
- Every caller with `view_permission` sees only rows where `<plain-English
  uniform predicate>`. <Optional, only when the source model's §7
  explicitly resolves a broadening mechanism: "Broader read access for
  `<role>` is provisioned via `<mechanism — separate cube view, Postgres
  BYPASSRLS role, etc.>` per the model's §7."> **NEVER write a line like
  "callers holding `<slug>:view_all_X` bypass the filter"** — that
  mechanism is not in the platform spec; promising it ships broken RBAC.
  When the user's task genuinely needs broader access and the model's §7
  has not resolved a mechanism, the recipe says "escalate to a user who
  holds the role with broader visibility" and does not pretend to grant it.
- The platform applies this filter via RLS on every read; this skill does
  not duplicate the rule in its own query filters.
**Conditional UI states** *(omit when no field on this entity has an
`input_type_rule` on the task path)*:
- `<field>`: <trigger gist, e.g. "becomes required when `status` is being
  set to `approved`; locks to readonly after save">. The recipe at the
  bottom sets this field in the same PATCH as the trigger.
```

Do not include fields the skill doesn't read or write. Brevity over
completeness — the calling agent loads this into context every time the
skill triggers. The two analyst-v2.2 sub-blocks (`Row-level read scope`,
`Conditional UI states`) are likewise opt-in: include them only when the
model declares the rule AND the rule bears on the task. An entity in the
slice whose `select_rule` doesn't affect the task's read path, or whose
field-level `input_type_rule` triggers fall outside the task, omits the
sub-block.

### Recipe section

Every model write is a recipe. Each recipe:

1. Starts with the reads it needs (parallel-fetch if independent)
2. Branches on conditions explicitly (refuse / no-op / proceed)
3. Writes paired fields in one call (never split related writes)
4. Verifies the write took effect (read-back via `--single`)
5. Has an explicit exit-code contract

Use the patterns from `use-semantius`'s response-handling section:
`--single` for exactly-one reads, default array for zero-or-many.

### Runtime disagreement clause (mandatory)

Every generated SKILL.md ends with this clause (adapt the wording):

```markdown
## When the runtime disagrees with this slice

This skill bakes in the model's shape as of <generation date>. If a write
fails with 409 / 422 / a missing-column / a missing-FK error, the live
schema has drifted from the slice. Abort. Run `read_entity` / `read_field`
on the affected entity, surface the drift to the user, and recommend
regenerating this skill against the current model. Do not silently adapt
the recipe to the new shape — that masks real schema changes the user
should see.
```

---

## Authoring patterns (forked from `skill-creator`)

### Progressive disclosure

A skill's instructions are loaded into context every time it triggers. Keep
the SKILL.md lean. If it grows past ~500 lines, split:

- `SKILL.md` — the workflow and the slice
- `references/<topic>.md` — details loaded only when the workflow points at
  them ("read `references/dedup-strategy.md` before any catalog write")

### Imperative form

Prefer "Read the entity. Branch on status. Refuse if released." over "The
agent should read the entity and then check the status." Imperative
voice is shorter and clearer.

### Explain the why

LLMs follow instructions better when they understand the reason. Instead
of `ALWAYS read before writing`, write `Read before writing because the
crud server returns exit 0 with empty array on zero rows — a blind insert
followed by a "verification" read will succeed at the protocol layer and
corrupt the catalog with duplicates.`

Avoid heavy-handed `MUST` / `NEVER` blocks unless the rule is genuinely
non-negotiable. Where you do use them, follow with one sentence of why.

### Lean prompts

Remove anything not pulling its weight. If you find yourself writing a
section "just in case," cut it. The agent is smart and can ask if it
needs more.

### Theory of mind

The agent invoking the generated skill has not read the model. It only
has the SKILL.md and the user's prompt. Anything the skill needs that
isn't in SKILL.md or won't be in the user's prompt must come from a
`semantius call` at runtime — so either inline it now or write the call
that fetches it.

### Language conventions for bundled scripts

When a generated skill needs a script (under `scripts/` or inline in a
recipe), use this preference order:

1. **Bash** for short, linear chains of `semantius call` invocations
   (≤ ~30 lines, no nontrivial parsing). Bash is the lingua franca of
   the `use-semantius` reference and stays readable for simple pipelines.
2. **Bun (TypeScript/JavaScript)** for anything with branching, JSON
   shaping beyond what `jq` handles cleanly, parallel fan-out, retries,
   or shared helpers across multiple operations. `use-semantius` already
   advertises Bun as a first-class scripting option for chaining the CLI.
3. **Do not default to Python.** Only use Python if the user explicitly
   asks for it or if a required library exists only in Python.

When in doubt: Bash for one-screen recipes, Bun for anything that would
need a second screen. Reach for Python only on explicit request.

---

## Non-determinism patterns (research, judgment, multi-step)

The defining shape of an agentic skill: **reason at the top, act at the
bottom.** The reasoning section may be open-ended; the action section is
always a recipe.

### Pattern 1: Research-and-record

1. Take a query (e.g. "domain = CRM").
2. Read existing catalog rows for that query (dedupe baseline).
3. Web research for candidates not in the baseline.
4. Filter, score, summarize — the reasoning step.
5. Show candidates to user for approval.
6. For each approved candidate: read-then-create via a deterministic recipe.
7. Read back to verify.

### Pattern 2: Judgment-then-write

1. Read inputs (entity row, supporting context).
2. Reason about the right next state / value / target.
3. State the proposed change and the reasoning.
4. Ask user for confirmation.
5. Write via a deterministic recipe.
6. Read back to verify.

### Pattern 3: Multi-step workflow

1. Decompose the workflow into named stages with explicit pre/post-conditions.
2. For each stage: read pre-condition → act → verify post-condition.
3. Between stages where state is mutated, expose a checkpoint so a re-run
   resumes from the last completed stage instead of restarting.

In all three: the reasoning section is allowed to be free-form; the
recipes at the bottom are tight, with explicit reads and verifies.

---

## Guardrails the maker enforces in every output

1. **Read before write.** Every `create_*` is preceded by the matching
   `read_*` to check for duplicates. Use existing IDs if found.
2. **Paired writes go together.** Never split fields that are validated
   together into two API calls.
3. **No silent adaptation.** If the slice and the live schema disagree,
   abort and surface the drift.
4. **No hard deletes of business records by default.** Soft-deactivate
   unless the user explicitly opts in.
5. **Approval gates for writes.** Default: one approval per logical unit
   of work, not one per row.
6. **Idempotent re-runs.** Re-running with the same inputs is safe;
   document the no-op / update / append behavior explicitly.
7. **Exit-code contract.** 0 = success, 1 = usage/validation, 2 =
   platform/tool error, 3 = network.
8. **Link after writes.** Output the UI link
   `https://tests.semantius.app/<module_slug>/<table_name>` so the user
   can verify in the browser.
9. **Visibility callout on row-scoped reads**. Every read
   against an entity carrying a `select_rule` is preceded by a one-sentence
   reminder of what every caller with `view_permission` sees (the uniform
   per-row predicate). The reminder lives in the slice block (preferred)
   or inline in the recipe (when the slice is omitted). Generated skills
   that read a scoped entity without naming the scope leave the calling
   agent unable to tell "no matching rows" from "rows exist but are
   filtered out for me", and the conclusion downstream is silently wrong.
   **The reminder never promises a `view_all_<plural>`-style permission
   bypass; that mechanism is not in the platform spec.** When the model's
   §7 has resolved a documented broadening mechanism, the reminder may
   point at it; otherwise broader access is human escalation, full stop.
10. **Paired side-effect for `input_type_rule`-triggered required fields.**
    When the slice's `Conditional UI states` block records
    a field whose UI rule flips to `required` on a transition the recipe
    drives, the PATCH body sets both the trigger field and the dependent
    field in the same call. The UI would have prompted for the dependent
    at form time; the recipe has no form and must carry the value itself.

---

## What this skill does NOT do

- Does not auto-derive jobs from the model (that's `semantius-skill-maker`).
- Does not bundle multiple skills into an A2A agent card.
- Does not deploy the model to a live instance (that's
  `semantic-model-deployer`).
- Does not run a formal eval loop in v1 (qualitative review only). Can be
  added later if you want quantitative benchmarking.
- Does not write skills for non-Semantius backends.

---

## Re-running on an updated model

If the user updates the model after the skill was generated, re-run this
maker against the new model and the same task. The output replaces the
prior SKILL.md (snapshot the prior version first if the user wants
diff-able history). Do not try to "patch" an existing generated skill in
place — the slice may have shifted in ways a patch can't safely capture.

---

## First-time invocation checklist

When the user first asks you to build a skill, do this in order:

1. Confirm the model path. Read it.
2. Confirm the task in one sentence.
3. Interview (Step 2 above) — get the answers you need.
4. Propose the slice and the shape; let the user correct.
5. Propose the generated skill name and output path; let the user override.
6. Draft the SKILL.md. Self-review (Step 6).
7. Show the user. Iterate.

Do not skip the interview. Skills written without it are usually wrong on
the approval gates, the idempotency rule, or the slice — and those are
the hard parts to fix later.
