# Interaction level: standard, advanced, yolo (shared across Semantius skills)

*Canonical copy. `semantius-architect` and `semantius-analyst` each keep a short resident "Advanced mode" section (how to read the switch and their own table of skipped questions); `semantius-admin` handles the on / off instruction in orchestrated runs. Yolo mode has its own canonical file, [`yolo-mode.md`](./yolo-mode.md). Keep the resident sections and these files in sync.*

## 1. What it is

The interaction level is a **persisted switch**, stored as `.interaction_level` in `$CUSTOMIZATIONS_FILE` (`semantius/<org>/customizations.yaml`). It stays as set, across runs and conversations, until the user changes it. The file is per org, so everyone working in that org's folder shares the switch. It has three values, each a different promise to the user:

- **`standard` or absent (the default): guidance.** For users who want help getting it right.
  - Architect Stage 1 brings domain knowledge up front. When a well-known product matches the request, a short aside names the products the design draws on and a few best-practice points, with no question. When nothing similar is known, a short discovery interview (1 to 4 questions) comes first (`../../semantius-architect/references/stage-1-capture.md`). An unclear category is settled by the interview's "Closest to" question.
  - The questions in section 3 are skipped and answered with a fixed default.
- **`advanced`: control.** For users who know what they want. Every question is asked, exactly as before the switch existed; there is no guidance aside, and an unclear category gets one clarifying question.
- **`yolo` (experimental): autonomy.** For a new build only: a baseline product, a short interview, one go-ahead, then no further questions until the module is deployed and the demo-data question waits. An unclear category is settled by the yolo interview. Everything else runs as standard. The rules are in [`yolo-mode.md`](./yolo-mode.md).

Advanced mode is **not** the same as advanced access control. Access control is a separate choice (basic vs advanced) that advanced mode asks and standard resolves from the instance.

## 2. Turning it on and off

| The user says | Effect |
|---|---|
| "advanced mode" (e.g. "turn on advanced mode", "use advanced mode") | write `.interaction_level: advanced`, narrate *"Switched to advanced mode."* |
| "standard mode" (e.g. "turn off advanced mode", "back to standard mode") | write `.interaction_level: standard`, narrate *"Switched to standard mode."* |
| "yolo mode" (e.g. "turn on yolo mode", "use yolo mode") | write `.interaction_level: yolo`, narrate the one line in [`yolo-mode.md`](./yolo-mode.md), section 2 |
| anything else, including a bare "advanced", "yolo", "advanced access control", "quick", "simple", "just do it", or "don't ask me" | no change |

The skill that receives the instruction writes the switch (the admin in orchestrated runs; the architect or analyst when called directly), with the usual provenance comment (customizations-protocol.md 7.5, step 4a), then continues with the rest of the request. No widget ever writes it.

**Reading it.** The architect and analyst read `.interaction_level` at Step 0 (after any switch instruction in the same request has been written), and read it again after a context reset. When it is `advanced`, narrate once at the start of the run: *"Running in advanced mode."* Under the admin, the admin says this line once and the sub-skills do not repeat it. **Mode D (Rebuild) always runs as advanced**, whatever the switch says: reopening every prior decision is its purpose. **A saved `yolo` on its own is read as `standard`:** a run is a yolo run only when the admin says so for that run (the run-context line or the task marker; [`yolo-mode.md`](./yolo-mode.md), section 2).

**Switching during a run** writes the switch and applies from the next question on; answers and defaults already applied stay.

## 3. The questions skipped while advanced mode is off (standard or yolo)

| Skill | Question | Default in standard mode |
|---|---|---|
| Architect | Stage 1 system name and scope | Taken from the request |
| Architect | Stage 13 tagline / description / `module_kind` confirmation | The drafts are written |
| Analyst | Basic or advanced access control | An existing module keeps its own; a new module follows the instance (advanced when another module already uses it, else basic) |
| Analyst | First 3d question: a module that is not deployed yet | Set the records up in this module |
| Analyst | 4.N N2: numbered fields (phone 1, phone 2) as a list of their own | Keep the fixed fields; a list only when the request asked for one |

**Every other question is asked in standard and advanced mode, unchanged.** No other question may be skipped without the owner of these skills approving it. Yolo mode is the one approved exception: after the user's go-ahead it answers every question by its pick procedure ([`yolo-mode.md`](./yolo-mode.md), section 4).

Each of the five opens, in its stage file, with an "Interaction level" block naming its literal default. Rules:

- **A saved answer wins in every mode.** Where the question has a path in `$CUSTOMIZATIONS_FILE` (customizations-protocol.md 7.4) and it holds a value, use it, exactly as before. Answers the user gave with advanced mode on are saved as usual, so they are reused after it is turned off.
- **A default is never written to `$CUSTOMIZATIONS_FILE`.** It is not the user's decision; when advanced mode is turned on later, the question is asked.
- **A skipped question creates no `Q:` task and fires no widget.** In the ledger it is treated like a policy hit at the enumerate step (task-tracking.md, E), except that nothing is written.

## 4. Telling the user what was picked

- **Architect, Stage 3:** at most one line before the entity list: *"**Picked for you:** <system name and one-line scope>."* Parts the user stated themselves are left out; the line is dropped when nothing is left (stage-3-entities.md).
- **Architect, close-out:** *"Wrote `<path>`, with a catalog tagline and description written without asking (ask me to change them anytime). Tell me when you want to deploy it."*
- **Analyst, 3g plan summary:** one line after the Fields block for the access-control and not-deployed-yet defaults: *"⚙️ Picked for you: <one plain-English clause per choice, semicolon-separated>. Say "advanced mode" to be asked these instead."* Left out when neither default was applied (stage-3-confirm.md, authoring rule 12). The N2 default is not named: keeping the drafted fields changes nothing.
- **Yolo:** no "Picked for you" lines, and the architect's close-out is only *"Wrote `<path>`."* The go-ahead summary names the system, and after the go-ahead every pick goes to the "Decided for you" list at the end ([`yolo-mode.md`](./yolo-mode.md), section 6).
