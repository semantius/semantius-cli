# Yolo mode (experimental, shared across Semantius skills)

*Canonical copy. `semantius-admin`, `semantius-architect`, `semantius-analyst`, and `semantius-modeler` each keep a resident "Yolo mode" section of five lines or fewer that points here, and every question point in their stage files carries its own one-line "Yolo mode, after the go-ahead" rule naming its pick. So a gate resolves correctly even when this file was not read; this file holds the detail (the pick procedure, the fixed picks, the log, the summary, the resume rule). Keep the resident sections, the gate lines, and this file in sync.*

## 1. What it is

Yolo mode is the third value of the `.interaction_level` switch ([`interaction-level.md`](./interaction-level.md)). For a new build: a baseline product, a short interview, one go-ahead, then no further questions until the module is deployed and the demo-data question waits.

## 2. When a run is a yolo run

**The switch.** The user turns it on by saying "yolo mode" (`.interaction_level: yolo`); "standard mode" or "advanced mode" replaces it. A bare "yolo", "just do it", "don't ask me", "quick", or "simple" changes nothing. Switching to it narrates: *"Switched to yolo mode (experimental)."*

**The scope.** The saved switch is the org's preference, not a per-run fact. The admin decides the level for each run:

| Run | Level |
|---|---|
| New build from an idea (`Architect mode: create`), switch `yolo` | `yolo` |
| Anything that starts from an existing design: clone, deploying a blueprint or spec, customize, extend, audit | `standard`; the admin narrates once: *"Yolo mode covers new builds only; this run uses standard mode."* |
| Rebuild | `advanced` (reopening every decision is its purpose) |

**The two signals.** A sub-skill is in yolo only when one of these says so; the saved switch on its own never makes a sub-skill skip a question.

1. **The run context line** `Interaction level: yolo`, passed by the admin to every sub-skill (`semantius-admin/SKILL.md`, Step 7.3).
2. **The task marker.** The admin writes the state into the description of its pipeline tasks (read it with `TaskGet`): `yolo: awaiting go-ahead` when the run starts, `yolo: go-ahead given` when the user says yes, `yolo: standard for this build` when the user picks "Ask me as usual".

| Skill | Yolo before the go-ahead | Yolo after the go-ahead |
|---|---|---|
| Architect | Signal 1, or the marker says `yolo: awaiting go-ahead` | The marker says `yolo: go-ahead given` |
| Analyst, modeler | never (they run after it) | Signal 1, or the marker says `yolo: go-ahead given` |

Check both signals at Step 0 and again after a context reset. When neither is present, run as standard. **That is the safe direction:** a lost signal means the user is asked questions again, never that a question is answered for them by mistake.

**Direct calls.** The architect called directly on a new idea while the switch is `yolo` hands the run to `semantius-admin` (load it with the Skill tool, passing the user's request) before it creates any task; the admin re-enters the architect with the run context. The analyst or modeler called directly runs as standard, whatever the switch says.

**Questions before the go-ahead still fire:** the admin's Step 0 clarifying question and the Step 1.3 match widget. If the user picks "Deploy the existing…", the run starts from a blueprint and therefore runs as standard.

**Yolo includes standard.** The five questions standard mode skips ([`interaction-level.md`](./interaction-level.md), section 3) take their standard defaults in yolo too.

## 3. Before the go-ahead (architect)

The detail lives in the architect's stage files; this is the map.

- **Baseline** (`stage-1-capture.md`). Pick 1 to 3 products whose data model fits the request and that pass the **four-object test**: you can name at least four of the product's headline objects, spelled the way the product spells them. A product that fails the test is not a baseline. With none, fall back to the discovery interview and modern names.
- **Interview** (`stage-1-capture.md`, the interview templates). Zero to four questions, only about what the request leaves open; skip "Closest to" when the user named a product. The must-haves question replaces Stage 3's "Also track".
- **Naming** (`stage-2-naming.md`). A saved `.naming.mode` wins. Otherwise the baseline's own names (`template:<baseline>`), with no widget and nothing saved. No baseline: modern names, and the design is described as "inspired by <Product>" at most.
- **Entities** (`stage-3-entities.md`). Drafted from the baseline's object model and trimmed to the interview answers; the family question takes its Recommended option; the entity-list question is not asked (the go-ahead covers it).
- **The go-ahead** (below), at the end of Stage 3.

### The go-ahead

**Exact matches first.** Read the deployed tables once (read-only): `semantius call crud read_entity '{}' | jq -r '.[] | "\(.table_name)\t\(.module_name)"'`. An **exact match** is a drafted table whose table name equals a deployed table's name. This is the same definition the analyst uses for "exact" (`../../semantius-analyst/references/stage-2-inspect.md`, cross-module exact match and the link-target exact match).

**The summary**, one message, in plain language (Writing Convention 8):

1. The name and one-line scope.
2. The baseline: *"Based on how <Product> models this. Names follow <Product>; say "modern names" to switch."*
3. The entity table (Plural Label, one-line purpose, and the Vendor object column when naming follows a product).
4. The 2 to 4 best-practice points (Stage 1 aside).
5. The exact matches, one line, left out when there are none: *"Organizations already exist in Sales; I'll use them."*
6. What happens next: *"After your go-ahead I build and deploy without more questions. I only connect to records your instance already has when the name matches exactly, and that may share or reshape them; anything that only looks similar is kept separate. Everything I decide is listed at the end."*

**The question**, one `AskUserQuestion`, alone in its response:

- question: `"Build and deploy <System Name> now?"`
- header: `"Go-ahead"`
- options:
  1. `"Yes, build and deploy it (Recommended)"`, description `"I finish the design, match it against your live model, and deploy it without more questions. You get the list of what I decided at the end."`
  2. `"Change something first"`, description `"Tell me what to change. I update the design and show it to you again."`
  3. `"Ask me as usual for this build"`, description `"I ask each question as it comes up, like standard mode. Yolo mode stays on for later builds."`

**Recording the answer.** Before anything else, the admin updates the marker in its pipeline tasks' descriptions (`TaskList`, then `TaskUpdate` each):

- **Yes:** `yolo: go-ahead given`.
- **Change something first:** stays `yolo: awaiting go-ahead`; take the change in prose, update the draft, show the summary again, ask again.
- **Ask me as usual:** `yolo: standard for this build`, and the rest of this run is standard (the admin passes `Interaction level: standard` to the analyst and modeler). The switch stays `yolo`.

## 4. After the go-ahead

### 4.1 The turn rule

After the go-ahead, only a stop condition (4.2) or the modeler's Closing Contract may end the turn.

- Never call `AskUserQuestion`.
- Never end a message with a question, and never print a template that ends in one ("Look right?", "Add, drop, or rename any?", "Proceed with execution?"). A message that ends in a question ends the turn, which stops the run exactly as a widget would.
- Don't render stage proposals, plan summaries, or "Picked for you" lines. Log one line per decision instead (section 5); the task list shows progress.

### 4.2 What still stops the run

These behave exactly as in standard mode: a loud halt, no success footer.

- Halts, errors, and refusals, including version gates and the analyst or modeler refusing an input.
- Catalog drift found by the modeler since the analyst ran.
- A 🔴 blocker. Never waive one, never answer a "waive and proceed at your own risk" prompt.
- Deploy errors.
- A pre-save check that fails with no proposed fix. A failure that comes with a proposed fix ("Want me to add a hire-candidate permission and proceed?") gets the fix applied and logged, and the save continues.

### 4.3 The pick procedure

**Never remove anything; this comes before every rule below.** Yolo never removes or destructively changes anything already deployed: a field, an enum value, a rule, or a format change that would lose data. When a pick or a planned change would do that, don't do it and don't ask: keep what is deployed, log it, and continue.

At every other question point, take the first rule that applies:

| # | Situation | What yolo does |
|---|---|---|
| 1 | A saved answer exists in `customizations.yaml` | Use it, as in every mode. |
| 2 | One of standard's five skipped questions | Use its standard default. |
| 3 | A question about linking to, sharing, or reusing a deployed entity whose table name is **not** an exact match (section 3) | Take the option that keeps this module's own copy and changes nothing outside it, even when mapping is recommended. |
| 4 | The question has a "(Recommended)" option | Take it, even when it changes another module. After rule 3 this only happens for exact matches. |
| 5 | No option is recommended | Take the option that changes nothing outside this module. |
| 6 | A multi-select with nothing recommended | Select none. The skills word multi-selects so that choosing none is the safe outcome. |
| 7 | A question that asks the user for facts ("two or three example entity names") | Take the most conservative assumption and log it. |
| 8 | A prose gate ("Look right?", "Add or drop any?", the analyst's plan confirmation, the Stage 10 rules scan, "Proceed with execution?") | Accept the draft as proposed. |
| 9 | Anything else | Take the first option that isn't Cancel, Stop, or Skip. |

### 4.4 Fixed picks at known gates

The concrete pick at the main known gates, from rules 1 to 9. Every gate's own yolo line names its pick, including gates not listed here.

| Skill | Gate | Pick |
|---|---|---|
| Architect | Stages 6, 7, 9, 10 confirmations | Accept the draft. |
| Architect | Stage 10, gates but no admin tier (option 1 or 2) | Option 1. |
| Architect | "Unsure of the vendor object" offer (`stage-3-entities.md`) | Option (c): mark the entity "inspired-by, not canonical". |
| Architect | Stage 13 catalog text | The standard default (drafts written). |
| Architect | Pre-save failure with a proposed fix | Apply the fix. |
| Analyst | 3b, same table name in another module (3b.0, 3b.1, 3b.2 and its follow-ups) | The Recommended option: these are exact matches. Where to host, Case D (no Recommended option): the first module listed. |
| Analyst | 3c similar name | Option 3, "Different concept, keep both names": this module keeps the name shown at the go-ahead. |
| Analyst | 3c.1 / N8 Case A | "Keep them separate" (rule 3 overrides the Recommended option). |
| Analyst | 3c.1 / N8 Case B | "Keep our own <Plural Label>" (rule 3 overrides the Recommended option). |
| Analyst | 3c.1 / N8 Case C, and one entity with several candidate bases | "Keep them separate". |
| Analyst | 3d missing owner module | The standard default, "Set up <Plural Label> in this module for now"; the name-clash follow-up takes its Recommended option. |
| Analyst | 3e several candidate link targets | The candidate whose table name matches exactly; if none does, "Create our own here under a different name". |
| Analyst | 3e single candidate in an unexpected module | The Recommended option. |
| Analyst | Entity moved by hand since the last run (`stage-3-placement.md`, 2g drift) | Neither option: leave the entity where it is now and continue. |
| Analyst | 3f drift questions | The Recommended option; for the multi-select batch, select none (keep the live values). A cross-primitive format change (no widget, normally a 🔴 blocker): keep the live format (never remove). |
| Analyst | 4.N N7 | The Recommended option. |
| Analyst | 3g plan confirmation, Stage 10 rules scan | Accept. |
| Modeler | "Proceed with execution?" | Proceed: the go-ahead was the write gate. |
| Modeler | Ambiguous link target | The exact-name candidate; otherwise "Skip this link". |
| Modeler | Link proposals (1 to 3 or 4 or more) | Apply all: they are exact matches already. |
| Modeler | Access-control prompt (2.5) | The Recommended option. |
| Modeler | Rule clash on a shared entity (4e) | Keep the live rule (never remove). |
| Modeler | Extra fields on users, a tier change, a row visibility rule, a shared entity with no manager (Gate B) | Proceed as the spec says, but never remove a live row visibility rule (keep it). |
| Modeler | A change that removes or retypes live data (an enum value removal, a field deletion, a cross-primitive format change) | Skip it and keep what is deployed (never remove). |
| Modeler | A live rule the spec does not have | Keep the live rule. |
| Modeler | A required field on a table that already has records, required enums with no default included | Add the column as optional (nullable). |
| Modeler | Diagram disagrees with the relationships | Log it. |
| Modeler | Sample data | **Always asked.** It is the last question of the run and it waits. |

### 4.5 What yolo never saves, and how its tasks complete

- **Nothing auto-picked is written to `customizations.yaml`.** It is a default, not the user's decision, so it must not become standing policy (the same rule as standard mode's defaults). Answers the user actually gave before the go-ahead (the must-haves) are saved as usual.
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

`TaskList` first, as always, then `TaskGet` the admin pipeline task to read the marker. `yolo: go-ahead given`: re-read this file and continue from the current stage without asking anything, and never ask the go-ahead again. `yolo: awaiting go-ahead`: show the go-ahead summary again and ask it. `yolo: standard for this build`, or no marker: the run is standard.
