# Interaction flow: guided, expert, fast (shared across Semantius skills)

*Canonical copy. `semantius-architect` and `semantius-analyst` each keep a short resident "Expert flow" section (how to read the switch and their own table of skipped questions); `semantius-admin` handles the on / off instruction in orchestrated runs. Fast flow has its own canonical file, [`fast-flow.md`](./fast-flow.md). Keep the resident sections and these files in sync.*

## 1. What it is

The interaction flow is a **persisted switch**, stored as `.interaction_flow` in `$CUSTOMIZATIONS_FILE` (`semantius/<org>/customizations.yaml`). It stays as set, across runs and conversations, until the user changes it. The file is per org, so everyone working in that org's folder shares the switch. It has three values, each a different promise to the user:

- **`guided`: guidance.** For users who want help getting it right. The agent leads with the domain's best practices, written for a domain expert. It shows each draft the skills confirm, in plain language, and each architect confirmation is its own turn (the architect names two shared turns); the analyst's question batches (task-tracking.md) are unchanged. It skips only the questions in section 3. One line of why per point, no tutorials. Used when it is saved, for one new build whose request asks to be guided (section 2), and for every run that starts from an existing design unless expert flow is saved.
  - Architect Stage 1 brings domain knowledge up front. When a well-known product matches the request, a short aside names the products the design draws on and a few best-practice points, in the same turn as the design question. When nothing similar is known, a short discovery interview (closest product, who uses it, what it replaces; only what the request leaves open) comes first (`../../semantius-architect/references/stage-1-capture.md`). An unclear category is settled by the interview's "Closest to" question.
  - The questions in section 3 are skipped and answered with a fixed default.
- **`expert`: control.** For users who know what they want. Everything guided flow asks, plus every question in section 3. Stage 1 gives the guided-flow aside and interview, and keeps only products that pass the four-object test.
- **`fast` or absent (the default): autonomy.** Any saved value other than `guided` or `expert` reads as absent. For a new build only: a short interview (which design to follow, the modern one by default, and the must-haves), one go-ahead, then no further questions until the module is deployed and the demo-data question waits. An unclear category is settled by the fast-flow interview. Everything else runs as in guided flow. The rules are in [`fast-flow.md`](./fast-flow.md).

## 2. Turning it on and off

| The user says | Effect |
|---|---|
| "expert flow" (e.g. "turn on expert flow", "use expert flow") | write `.interaction_flow: expert`, narrate *"Switched to expert flow."* |
| "guided flow" (e.g. "turn off expert flow", "back to guided flow") | write `.interaction_flow: guided`, narrate *"Switched to guided flow."* |
| "fast flow" (e.g. "turn on fast flow", "use fast flow") | write `.interaction_flow: fast`, narrate the one line in [`fast-flow.md`](./fast-flow.md), section 2 |
| a request for a new build that asks to be guided: "guide me", "walk me through", "step by step", "assist me", "help me design", "help me decide", "help me think through", "ask me as we go", or the like | this build only runs in guided flow; nothing is written; narrate *"Using guided flow for this one."* Not when expert or guided flow is saved |
| anything else, including a bare "fast", "guided", "expert", "guided mode", "fast mode", "quick", "simple", "just do it", "don't ask me", or a plain "help me build / set up / get" | no change |

**A hint is not a switch.** A turn of phrase in one request is not a standing preference, so it applies to that build only and is never saved. A plain "help me build…" is how most people ask for a system they want done, so it is not a hint.

The skill that receives the instruction writes the switch (the admin in orchestrated runs; the architect or analyst when called directly), with the usual provenance comment (customizations-protocol.md 7.5, step 4a), then continues with the rest of the request. No widget ever writes it.

**Reading it.** The architect and analyst read `.interaction_flow` at Step 0 (after any switch instruction in the same request has been written), and read it again after a context reset. When it is `expert`, narrate once at the start of the run: *"Running in expert flow."* Under the admin, the admin says this line once and the sub-skills do not repeat it. **Mode D (Rebuild) always runs in expert flow**, whatever the switch says: reopening every prior decision is its purpose. **A saved `fast`, or no saved value, is read as `guided` by the architect and analyst on their own, with one exception:** the architect called directly on a new build whose request does not ask to be guided hands the run to the admin first, which runs it fast ([`fast-flow.md`](./fast-flow.md), section 2, "Direct calls"). A run is a fast run only when the admin says so for that run (the run-context line or the task marker; [`fast-flow.md`](./fast-flow.md), section 2).

**Switching during a run** writes the switch and applies from the next question on; answers and defaults already applied stay.

## 3. The questions skipped while expert flow is off (guided or fast flow)

| Skill | Question | Default in guided flow |
|---|---|---|
| Architect | Stage 1 system name and scope | Taken from the request |
| Architect | Stage 13 tagline / description / `module_kind` confirmation | The drafts are written |
| Architect | Access level (Stage 10 permission step) | The script's result |
| Architect | Stage 6 related-modules confirmation | The list is built and accepted as drafted, without being shown |
| Architect | Stage 7 handoffs confirmation, and the question on a handoff triggered by a state the source lifecycle doesn't have | The handoffs are drafted and accepted without any output, and written to §6; a handoff to a missing state is dropped |
| Analyst | First 3d question: a module that is not deployed yet | Set the records up in this module |
| Analyst | 4.N N2: numbered fields (phone 1, phone 2) as a list of their own | Keep the fixed fields; a list only when the request asked for one |

**Every other question is asked in guided and expert flow, unchanged.** Convention 8 controls how a required table or proposal is worded, never whether it is shown. Translate identifiers in a stage template into plain words; never drop the artifact. No other question may be skipped without the owner of these skills approving it. Fast flow is the one approved exception: after the user's go-ahead it answers every question by its pick procedure ([`fast-flow.md`](./fast-flow.md), section 4).

Each skipped question opens, in its stage file, with an "Interaction flow" block naming its literal default. Rules:

- **A saved answer wins in every flow.** Where the question has a path in `$CUSTOMIZATIONS_FILE` (customizations-protocol.md 7.4) and it holds a value, use it, exactly as before. Answers the user gave with expert flow on are saved as usual, so they are reused after it is turned off.
- **A default is never written to `$CUSTOMIZATIONS_FILE`.** It is not the user's decision; when expert flow is turned on later, the question is asked.
- **A skipped question creates no `Q:` task and fires no widget.** In the ledger it is treated like a policy hit at the enumerate step (task-tracking.md, E), except that nothing is written.

## 4. Telling the user what was picked

- **Architect:** nothing. The tagline, description and `module_kind` drafts are written silently and never mentioned; the close-out is the plain *"Wrote `<path>`."*, with no deploy question (expert flow asks *"Deploy it now?"*). Run standalone (no `Run context:` block), the line adds one clause naming the next step, still with no question.
- **Analyst, 3g plan summary:** one line after the Fields block for the not-deployed-yet default: *"⚙️ Picked for you: <one plain-English clause per choice, semicolon-separated>. Say "expert flow" to be asked these instead."* Left out when the default was not applied (stage-3-confirm.md, authoring rule 12). The access level is never named: the user is not told which access level was picked. The N2 default is not named: keeping the drafted fields changes nothing.
- **File names, guided and expert flow:** the architect's and the analyst's close-outs each name the file just written (*"Wrote `<path>`…"*), under the admin too. Hiding the file names is fast flow only.
- **Fast flow:** no "Picked for you" lines, and no close-out line naming the blueprint or spec file. After the go-ahead every pick goes to the "Decided for you" list at the end ([`fast-flow.md`](./fast-flow.md), section 6).
