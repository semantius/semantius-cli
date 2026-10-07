# Fast flow (experimental, shared across Semantius skills)

*Canonical copy. `semantius-admin`, `semantius-architect`, `semantius-analyst`, and `semantius-modeler` each keep a resident "Fast flow" section of five lines or fewer that points here, and every question point in their stage files carries its own one-line "Fast flow, after the go-ahead" rule naming its pick. So a gate resolves correctly even when this file was not read; this file holds the detail (the pick procedure, the fixed picks, the log, the summary, the resume rule). Keep the resident sections, the gate lines, and this file in sync.*

## 1. What it is

Fast flow is the third value of the `.interaction_flow` switch ([`interaction-flow.md`](./interaction-flow.md)). For a new build: a baseline product, a short interview, one go-ahead, then no further questions until the module is deployed and the demo-data question waits.

## 2. When a run is a fast run

**The switch.** The user turns it on by saying "fast flow" (`.interaction_flow: fast`); "plan flow" or "expert flow" replaces it. A bare "fast", "just do it", "don't ask me", "quick", or "simple" changes nothing. Switching to it narrates: *"Switched to fast flow (experimental)."*

**The scope.** The saved switch is the org's preference, not a per-run fact. The admin decides the flow for each run:

| Run | Flow |
|---|---|
| New build from an idea (`Architect mode: create`), switch `fast` | `fast` |
| Anything that starts from an existing design: clone, deploying a blueprint or spec, customize, extend, audit | `plan`; the admin narrates once: *"Fast flow covers new builds only; this run uses plan flow."* |
| Rebuild | `expert` (reopening every decision is its purpose) |

**The two signals.** A sub-skill is in fast flow only when one of these says so; the saved switch on its own never makes a sub-skill skip a question.

1. **The run context line** `Interaction flow: fast`, passed by the admin to every sub-skill (`semantius-admin/SKILL.md`, Step 7.3).
2. **The task marker.** The admin writes the state into the description of its pipeline tasks (read it with `TaskGet`): `fast: awaiting go-ahead` when the run starts, `fast: go-ahead given` when the user says yes, `fast: plan flow for this build` when the user picks "Ask me as usual".

| Skill | Fast flow before the go-ahead | Fast flow after the go-ahead |
|---|---|---|
| Architect | Signal 1, or the marker says `fast: awaiting go-ahead` | The marker says `fast: go-ahead given` |
| Analyst, modeler | never (they run after it) | Signal 1, or the marker says `fast: go-ahead given` |

Check both signals at Step 0 and again after a context reset. When neither is present, run in plan flow. **That is the safe direction:** a lost signal means the user is asked questions again, never that a question is answered for them by mistake.

**Direct calls.** The architect called directly on a new idea while the switch is `fast` hands the run to `semantius-admin` (load it with the Skill tool, passing the user's request) before it creates any task; the admin re-enters the architect with the run context. The analyst or modeler called directly runs in plan flow, whatever the switch says.

**Questions before the go-ahead still fire:** the admin's Step 0 clarifying question and the Step 1.3 match widget. If the user picks "Deploy the existing…", the run starts from a blueprint and therefore runs in plan flow.

**Fast flow includes plan flow.** The six questions plan flow skips ([`interaction-flow.md`](./interaction-flow.md), section 3) take their plan-flow defaults in fast flow too.

## 3. Before the go-ahead (architect)

The detail lives in the architect's stage files; this is the map.

- **Baseline** (`stage-1-capture.md`). Pick 3 to 4 products whose data model fits the request. With none, there is no baseline: modern names.
- **Interview** (`stage-1-capture.md`, the interview templates). Zero to two questions: "Closest to" (skipped when the user named a product) and the must-haves question, which replaces Stage 3's "Also track". "Users" and "Replaces" are not asked.
- **Naming** (`stage-2-naming.md`). A saved `.naming.mode` wins. Otherwise the baseline's own names (`template:<baseline>`), with no widget and nothing saved. No baseline: modern names, and the design is described as "inspired by <Product>" at most.
- **Entities** (`stage-3-entities.md`). Drafted from the baseline's object model and trimmed to the interview answers; the family question takes its Recommended option; the entity-list question is not asked (the go-ahead covers it).
- **The go-ahead** (below), at the end of Stage 3.

### The go-ahead

**Exact matches first.** Read the deployed tables once (read-only): `semantius call crud read_entity '{}' | jq -r '.[] | "\(.table_name)\t\(.module_name)"'`. An **exact match** is a drafted table whose table name equals a deployed table's name. This is the same definition the analyst uses for "exact" (`../../semantius-analyst/references/stage-2-inspect.md`, cross-module exact match and the link-target exact match).

**The summary**, one message, in plain language (Writing Convention 8):

1. The baseline: *"Based on how <Product> models this. Names follow <Product>; say "modern names" to switch."*
2. The entity table (Plural Label, one-line purpose, and the Vendor object column when naming follows a product).
3. The 2 to 4 best-practice points (Stage 1 aside).
4. The exact matches, one line, left out when there are none: *"Organizations already exist in Sales; I'll use them."*
5. What happens next: *"After your go-ahead I build and deploy without more questions. I only connect to records your instance already has when the name matches exactly, and that may share or reshape them; anything that only looks similar is kept separate. Everything I decide is listed at the end."*

**The question**, one `AskUserQuestion`, alone in its response:

- question: `"Build and deploy it now?"`
- header: `"Go-ahead"`
- options:
  1. `"Yes, build and deploy it (Recommended)"`, description `"I finish the design, match it against your live model, and deploy it without more questions. You get the list of what I decided at the end."`
  2. `"Change something first"`, description `"Tell me what to change. I update the design and show it to you again."`
  3. `"Ask me as usual for this build"`, description `"I ask each question as it comes up, like plan flow. Fast flow stays on for later builds."`

**Recording the answer.** Before anything else, the admin updates the marker in its pipeline tasks' descriptions (`TaskList`, then `TaskUpdate` each):

- **Yes:** `fast: go-ahead given`.
- **Change something first:** stays `fast: awaiting go-ahead`; take the change in prose, update the draft, show the summary again, ask again.
- **Ask me as usual:** `fast: plan flow for this build`, and the rest of this run is in plan flow (the admin passes `Interaction flow: plan` to the analyst and modeler). The switch stays `fast`.

## 4. After the go-ahead

### 4.1 The turn rule

After the go-ahead, only a stop condition (4.2) or the modeler's Closing Contract may end the turn.

- Never call `AskUserQuestion` (the one exception, the architect's keep-or-replace question, is in 4.2; the modeler's closing sample-data question is part of the Closing Contract).
- Never end a message with a question, and never print a template that ends in one ("Look right?", "Add, drop, or rename any?", "Proceed with execution?"). A message that ends in a question ends the turn, which stops the run exactly as a widget would.
- Don't render stage proposals, plan summaries, or "Picked for you" lines. Log one line per decision instead (section 5); the task list shows progress.

### 4.2 What still stops the run

These behave exactly as in plan flow: a loud halt, no success footer.

- Halts, errors, and refusals, including version gates and the analyst or modeler refusing an input.
- Catalog drift found by the modeler since the analyst ran.
- A 🔴 blocker. Never waive one, never answer a "waive and proceed at your own risk" prompt.
- Deploy errors.
- A pre-save check that fails with no proposed fix. A failure that comes with a proposed fix ("Want me to add a hire-candidate permission and proceed?") gets the fix applied and logged, and the save continues.

One question pauses the run instead of ending it: the architect's keep-or-replace question for a live module whose permissions were set up by hand (`access_scope: custom`). It is the only question asked between the go-ahead and the modeler's closing sample-data question; with the answer the run continues in fast flow.

### 4.3 The pick procedure

**Never remove anything; this comes before every rule below.** Fast flow never removes or destructively changes anything already deployed: a field, an enum value, a rule, or a format change that would lose data. When a pick or a planned change would do that, don't do it and don't ask: keep what is deployed, log it, and continue.

At every other question point, take the first rule that applies:

| # | Situation | What fast flow does |
|---|---|---|
| 1 | A saved answer exists in `customizations.yaml` | Use it, as in every flow. |
| 2 | One of plan flow's five skipped questions | Use its plan-flow default. |
| 3 | A question about linking to, sharing, or reusing a deployed entity whose table name is **not** an exact match (section 3) | Take the option that keeps this module's own copy and changes nothing outside it, even when mapping is recommended. |
| 4 | The question has a "(Recommended)" option | Take it, even when it changes another module. After rule 3 this only happens for exact matches. |
| 5 | No option is recommended | Take the option that changes nothing outside this module. |
| 6 | A multi-select with nothing recommended | Select none. The skills word multi-selects so that choosing none is the safe outcome. |
| 7 | A question that asks the user for facts ("two or three example entity names") | Take the most conservative assumption and log it. |
| 8 | A prose gate ("Look right?", "Add or drop any?", the analyst's plan confirmation, the Stage 10 rules scan, "Proceed with execution?") | Accept the draft as proposed. |
| 9 | Anything else | Take the first option that isn't Cancel, Stop, or Skip. |

### 4.4 Fixed picks at known gates

The concrete pick at the main known gates, from rules 1 to 9. Every gate's own fast-flow line names its pick, including gates not listed here.

| Skill | Gate | Pick |
|---|---|---|
| Architect | Stages 6, 7, 9, 10 confirmations | Accept the draft. |
| Architect | Stage 10 permission step: access level | The script's result (`--flow fast`; a fast run never picks `raci`). |
| Architect | Stage 10 permission step: live module set up by hand (`custom`) | Pause and ask keep or replace; with the answer the run continues. |
| Architect | Stage 11 RACI matrix confirmation (only when the live module already uses `raci`) | Accept the matrix without asking. |
| Architect | "Unsure of the vendor object" offer (`stage-3-entities.md`) | Option (c): mark the entity "inspired-by, not canonical". |
| Architect | Stage 13 catalog text | The plan-flow default (drafts written). |
| Architect | Pre-save failure with a proposed fix | Apply the fix. |
| Analyst | 3b, same table name in another module (3b.0, 3b.1, 3b.2 and its follow-ups) | The Recommended option: these are exact matches. Where to host, Case D (no Recommended option): the first module listed. |
| Analyst | 3c similar name | Option 3, "Different concept, keep both names": this module keeps the name shown at the go-ahead. |
| Analyst | 3c.1 / N8 Case A | "Keep them separate" (rule 3 overrides the Recommended option). |
| Analyst | 3c.1 / N8 Case B | "Keep our own <Plural Label>" (rule 3 overrides the Recommended option). |
| Analyst | 3c.1 / N8 Case C, and one entity with several candidate bases | "Keep them separate". |
| Analyst | 3d missing owner module | The plan-flow default, "Set up <Plural Label> in this module for now"; the name-clash follow-up takes its Recommended option. |
| Analyst | 3e several candidate link targets | The candidate whose table name matches exactly; if none does, "Create our own here under a different name". |
| Analyst | 3e single candidate in an unexpected module | The Recommended option. |
| Analyst | Entity moved by hand since the last run (`stage-3-placement.md`, 2g drift) | Neither option: leave the entity where it is now and continue. |
| Analyst | 3f drift questions | The Recommended option; for the multi-select batch, select none (keep the live values). A cross-primitive format change (no widget, normally a 🔴 blocker): keep the live format (never remove). |
| Analyst | 4.N N7 | The Recommended option. |
| Analyst | 3g plan confirmation, Stage 10 rules scan | Accept. |
| Modeler | "Proceed with execution?" | Proceed: the go-ahead was the write gate. |
| Modeler | Ambiguous link target | The exact-name candidate; otherwise "Skip this link". |
| Modeler | Link proposals (1 to 3 or 4 or more) | Apply all: they are exact matches already. |
| Modeler | Rule clash on a shared entity (4e) | Keep the live rule (never remove). |
| Modeler | Extra fields on users, a tier change, a row visibility rule, a shared entity with no manager (Gate B) | Proceed as the spec says, but never remove a live row visibility rule (keep it). |
| Modeler | A change that removes or retypes live data (an enum value removal, a field deletion, a cross-primitive format change) | Skip it and keep what is deployed (never remove). |
| Modeler | A live rule the spec does not have | Keep the live rule. |
| Modeler | A required field on a table that already has records, required enums with no default included | Add the column as optional (nullable). |
| Modeler | Diagram disagrees with the relationships | Log it. |
| Modeler | Sample data | **Always asked.** It is the last question of the run and it waits. |

### 4.5 What fast flow never saves, and how its tasks complete

- **Nothing auto-picked is written to `customizations.yaml`.** It is a default, not the user's decision, so it must not become standing policy (the same rule as plan flow's defaults). Answers the user actually gave before the go-ahead (the must-haves) are saved as usual.
- **Auto-picks never become `Q:` tasks.** They are resolved at the enumerate step like a policy hit (`task-tracking.md`, section 3). The log line (section 5) stands in for the task; where a skill checks that every must-fire question has a completed `Q:` task, a log line for that decision satisfies the check.
- **Stage tasks complete when their draft is done and their picks are logged**, not when a user confirmation lands.

## 5. The auto-picks log

`.tmp_admin/<run_id>/auto-picks.md`, in the run folder next to the diagnostic logs. It is a per-run diagnostic, not a policy record (gitignored, ephemeral; `output-discipline.md`), so the admin's "no decision log file" rule allows it. Each skill writes one line per decision, when the stage lists its questions:

```bash
AUTO_PICKS=".tmp_admin/$RUN_ID/auto-picks.md"
log_pick() { mkdir -p "$(dirname "$AUTO_PICKS")"; printf '%s | %s | %s | %s | touches: %s\n' "$1" "$2" "$3" "$4" "$5" >> "$AUTO_PICKS"; }
# log_pick <skill> "<decision in plain words>" "<pick>" <saved|default|recommended|fixed|draft> "<this module | Module Display Name>"
log_pick analyst "Organizations exist in Sales with the same name" "Shared, kept once in Sales" recommended "Sales"
```

Plain language, Plural Labels and module display names, no raw identifiers: the summary is built from these lines verbatim. `touches:` names the other module whenever the pick changes something outside the module being built; otherwise `this module`.

## 6. The "Decided for you" summary

The modeler's Stage 5 verification report ends with this section, **before** the Closing Contract's `---`, built from the log:

> **Decided for you after your go-ahead**
>
> Changes to other modules:
> - Organizations are shared with Sales, kept once there (same name in both).
>
> In this module:
> - Persons are kept separate from Contacts in Sales (similar, not the same name).
> - Related modules, handoffs, and rules were accepted as drafted.
>
> Say "change" and what you want different to revisit any of these.

Lines that touch other modules come first, then the rest grouped by skill. Leave out the "Changes to other modules" group when it is empty, and the whole section when the log is missing or empty. The Closing Contract that follows is unchanged: the status line, the link, and the demo-data question, which is asked and waits.

On a halt, the admin's failure report (Step 6.8) adds one line after the halt message: *"Before it stopped, I decided N things for you; they're listed in the run folder."* (the run-folder path is already printed on a failed run).

## 7. Resuming after a context reset

`TaskList` first, as always, then `TaskGet` the admin pipeline task to read the marker. `fast: go-ahead given`: re-read this file and continue from the current stage without asking anything, and never ask the go-ahead again. `fast: awaiting go-ahead`: show the go-ahead summary again and ask it. `fast: plan flow for this build`, or no marker: the run is in plan flow.
