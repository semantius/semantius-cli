# Task tracking and the question ledger (shared across Semantius skills)

*Canonical copy. Each pipeline skill (`semantius-admin`, `semantius-architect`, `semantius-analyst`, `semantius-modeler`, `semantius-importer`) keeps a short resident "Task tracking" section: its stage table, its ledger-stage list, and its `Q:` subject templates. The rules below are the single statement of HOW tasks and the ledger work; the skills only say WHAT their tasks are. Keep the resident sections and this file in sync.*

## Why

Two failure modes this file closes: (1) `AskUserQuestion` holds at most 4 questions per call (2-4 options each), and a stage that has more open decisions than that has no durable record of which ones were asked and answered, so a weaker model forgets one or proceeds with an unanswered one; (2) a run that spans several skills (design, match, apply) or many stages gives the user no view of where it is, so the skills narrate progress in chat, which costs tokens and breaks the narration-restraint rules. The harness task list solves both: it is rendered UI, not chat prose, and it survives across turns.

## 1. Tool contract (cross-agent)

The skills use four tools and only these fields, so the same text works in every harness whose tools mirror Claude Code's:

| Tool | Fields used | Returns |
|---|---|---|
| `TaskCreate` | `subject`, `description`, `activeForm` | the new task's id |
| `TaskUpdate` | `taskId`, `status` (`pending` / `in_progress` / `completed` / `deleted`), `addBlockedBy` (ids this task waits for), `addBlocks` (ids that wait for this task), optionally `subject`, `description` — **several fields in one call; both id arrays take many ids** | the updated task |
| `TaskList` | none | every task: id, subject, status, `blockedBy` (still-open blockers only) |
| `TaskGet` | `taskId` | the full task including its description |

A task is `{id, subject, description, activeForm, status, blocks[], blockedBy[]}` (plus `owner` / `metadata`, which the skills never set). The harness's tool description is authoritative; when it names a field differently, follow it. If `TaskUpdate` has no `deleted` status, use `completed` with `skipped: <reason>` appended to the description. `activeForm` is always the subject verbatim; never invent a second wording.

**Ordering is expressed with `blocks` / `blockedBy`, never by numbering or by prose.** Three relations, all built from those two arrays; set them with `TaskUpdate` immediately after the `TaskCreate` calls of the same response — **one `TaskUpdate` per task, carrying every edge and the status that task needs; never one call per field** (the harness mirrors an edge onto the other task, and both id arrays take several ids):

- **Chain:** a task that must run after another is `blockedBy` it (`addBlockedBy: [prevId]`). Pipeline tasks form one chain; a skill's stage tasks form one chain.
- **Parent / child:** a sub-skill's stage tasks each `addBlocks: [pipelineTaskId]` the admin pipeline task they belong to, so the parent cannot complete before its children (there is no separate parent field; the edge is the nesting).
- **Question gate:** the stage task is `blockedBy` every one of its `Q:` tasks — one call, `TaskUpdate` the stage task with `addBlockedBy: [<all the Q: ids just created>]` — so the stage visibly cannot complete while a question is open.

`Q:` tasks are not chained among themselves (that is what makes them batchable). A skill sets edges only on its own tasks; an edge may point at another skill's task (the child → parent edge is set by the sub-skill on its own stage task).

**Fallback when the harness has no task tools at all (or only a whole-list `TodoWrite`):** keep the same ledger as a checklist file in the run's scratch folder (`.tmp_import/run-<ts>/open-questions.md`, `.tmp_admin/<run_id>/open-questions.md`, `.tmp_deploy/open-questions.md`) holding **open questions and their status only**. Answers never go into that file: they live only in the artifact of record (below). The file is diagnostics-class, like the per-run diagnostic log, gitignored and ephemeral; it is not a decision log.

## 2. Pattern A: stage tracking

Every skill has a fixed **stage table** in its SKILL.md: one row per user-visible stage, with the exact task subject. Rules:

1. **Create at entry, then chain.** At the skill's Step 0 (or mode selection), call `TaskList` first, then `TaskCreate` one task per row of the stage table, in table order, all `pending`; then, in the same response, **one `TaskUpdate` per task** carrying everything it needs: `addBlockedBy: [<previous task id>]` for every task after the first (the chain), `addBlocks: [<the admin pipeline task id for this step>]` when running under the admin (parent / child; the pipeline task is the one currently `in_progress` with no prefix, read from `TaskList`), and `status: in_progress` for the first. Never one call per field. A row whose stage is already known to be skipped when the tasks are created (compare-only run, dry run, `basic` access scope, a mode that never reaches that stage) is **not created**. A stage that is skipped by a decision taken later (declined sample data, an item refused mid-run) is set to `deleted`, never `completed`; a deleted task no longer blocks anything. A task added later (a second script pass, the sample-data task) is chained onto the last existing stage task the same way.
2. **Duplicate guard.** Before any `TaskCreate`, `TaskList`. A task with the same subject already in `pending` or `in_progress` is reused, not re-created. Tasks in `completed` or `deleted` never block: the second item of a multi-item run legitimately re-creates the same `Match ›` and `Apply ›` subjects.
3. **One `in_progress` stage task per skill level.** In an orchestrated run the admin's pipeline task for the current step and the sub-skill's current stage task are both `in_progress`; that is the only nesting. The current ledger batch (section 3) may also be `in_progress`. Mark a stage `completed` when its mandatory commands have run, not before. A stage that halts stays `in_progress` with `halted: <verbatim reason>` appended to its description.
4. **Ids are never carried in memory.** Every response that calls `TaskUpdate` starts with `TaskList` and reads the ids off it. Never reuse an id remembered from an earlier turn.
5. **Each skill owns only its tasks.** The admin creates the pipeline tasks (one per plan line, chained). A sub-skill creates its own `Design › / Match › / Apply › / Import ›` tasks when it enters, whether it was invoked by the admin or standalone, chains them, and (under the admin) points them at the pipeline task with `addBlocks`. Never rewrite, complete, or delete another skill's tasks; edges are set on your own tasks only. The admin marks its pipeline task `completed` after the sub-skill's output artifact is verified, which the harness allows only once every child stage task is `completed` or `deleted`.
6. **Internal mechanics never become tasks.** Preflight, the org probe, tool installs, URL fetches, file staging, the copy into the convention folder, diagnostic-log setup: none of these is a task (the user would see the machinery). Only stages from the table.
7. **Resume after a context reset.** The first action is `TaskList`. A stage task `in_progress` means: restart that stage at its first mandatory command (every stage is idempotent). A `Q:` task `in_progress` means: look in the artifact of record for its answer; if present, `completed`; if absent, `pending` and re-ask.

## 3. Pattern B: the question ledger

Applies **only inside a skill's declared ledger stages** (each SKILL.md lists them). Every other question a skill asks is a standalone question and is unchanged: it fires as today, alone in its own response, with no ledger task. Inside a ledger stage, never fire `AskUserQuestion` for a decision that has no `Q:` task.

**Unit.** One ledger task = one `AskUserQuestion` **question object**. A question may decide several items (all reserved-column clashes in one question); a multiSelect with more than 4 choices becomes several tasks with the same header, subjects suffixed `(1 of 3)`, `(2 of 3)`, and so on. Every question object holds **2 to 4 options**: the tool rejects 1 as firmly as 5, and a rejected question voids the whole call. So 5 choices split 3 + 2 (never 4 + 1), 9 split 4 + 3 + 2; when filling chunks of 4 would leave a last chunk of 1, move the last choice of the previous chunk into it. Never merge two independent choices into one option to fit the 4-option cap, and never pad a question with a meaningless filler (`Other`, `All of the above`) to reach 2; a question whose data yields only one choice (K = 1) is asked as a 2-option single-select (the choice, or a "None" / "Skip" option), as the skill's stage text prescribes.

**Subject.** `Q: ` followed by the exact `question` string that will be sent. This is what maps the answer back: `<user_answers>` is keyed by question text, so `TaskList` alone is enough to match; no `TaskGet` is needed in the loop. Question strings inside one call must be distinct. Every skill's resident section carries its `Q:` templates; use them verbatim, filling the placeholders.

**Description.** The header; the options with the Recommended one marked; `Decides: <item list>`; `Recorded in: <the artifact path or key(s) the answer lands in>` (a `mapping.json` path, a `customizations.yaml` yq path per item, a section of the file being authored); optionally `own call: yes` when a skill rule requires that question to be asked without siblings.

**The response sequence.** Each letter is one assistant response. Do not merge letters, do not skip one.

- **E, enumerate (once per ledger stage).** Consult standing policy (`customizations.yaml` where the skill uses it, the run's earlier answers) for every candidate decision. Write the enumeration list into the stage task's description. `TaskCreate` one `Q:` task per open question object, then **one** `TaskUpdate` on this stage's task with `addBlockedBy: [<every Q: id just created>]` (the question gate: the stage task shows as blocked until every `Q:` task is completed or deleted). Self-check before leaving this response: the number of `Q:` tasks created equals the enumeration length. Nothing else happens in this response.
- **B, batch.** `TaskList`. For each pending `Q:` task, re-consult policy (an answer may have been recorded since E, by an earlier batch or an earlier item): on a hit, `TaskUpdate` it `completed` with `Answer: policy` and narrate the one plain-English line the skill prescribes ("Using your rule for ...: ..."); it is never asked. Then take the first four remaining pending tasks in id order (a task marked `own call: yes` is taken alone). Headers may differ inside a batch. `TaskUpdate` each of them `in_progress`. Any edits, re-renders, or helper runs that must precede the widget (the importer's `render-plan.ts`, a re-rendered plan summary) also happen in this response.
- **A, ask.** `AskUserQuestion` with those questions, and nothing else in the response. A sibling tool call cancels the pause; a `TaskUpdate` beside the widget is that bug.
- **R, record.** The answers arrive as a `<user_answers>` input block. For each entry: match it to its task by the exact question string; write the answer into the artifact of record **first**; then `TaskList`, then `TaskUpdate` the task `completed` with `Answer: <value>` appended. When one task decides several items, record every item, including the negative verdicts of unselected multiSelect options where the skill's policy registry records both directions. A chosen "Cancel" / "Stop" option is an answer: `completed`, `Answer: cancel`, the stage task gets `halted: user cancelled`, and the run stops per the skill's cancel rule. A dismissed widget (no answer) sets its tasks back to `pending`; they are re-asked at most once; a second dismissal halts the stage cleanly ("Stopped; nothing written"). A new decision revealed by an answer becomes a new `Q:` task in this response. Finally `TaskList` again: if any `Q:` task is `pending` or `in_progress`, this response doubles as the next **B** (mark the next batch `in_progress` here); if none, continue to the stage's next mandatory command.

**The gate.** Every ledger stage lists `TaskList (no Q: task pending or in_progress)` among its mandatory commands, immediately before its next mechanical step (rendering a plan, a dry run, the first write). An open `Q:` task means back to **B**. Because every `Q:` task blocks its stage task, the same fact is visible in the list (`blockedBy` on the stage task is non-empty) and the harness will not let the stage task complete early. This check is what makes "did I ask everything?" mechanical instead of remembered. A new `Q:` task created at **R** is added to the gate the same way: `TaskUpdate` the stage task with `addBlockedBy: [<the new Q: id(s)>]`.

**Cost.** One ledger round is three responses (B, A, R) and the R response is also the next B, so a stage with 9 open questions costs E + 3 rounds. That is the price of never losing an answer; do not shortcut it by asking questions that have no task or by answering on the user's behalf.

## 4. Wording

- `subject` and `activeForm` are user-facing surfaces. Writing Convention 8 applies in full: plain language, no stage numbers, no section references, no pipeline vocabulary (`blueprint`, `reconcile`, `annotation`, `frontmatter`), Plural Labels instead of `table_name`, module display names instead of slugs. The admin's pipeline subjects may say `spec` (the existing admin exception); sub-skill subjects may not.
- Fixed prefixes make the flat list read as nested: `Design ›` (architect), `Match ›` (analyst), `Apply ›` (modeler), `Import ›` (importer). Admin pipeline tasks carry no prefix.
- `description` is working memory: decision keys, yq paths, mandatory commands, answers, a one-line step summary. Never diagnostic detail (that stays in the per-run log), never secrets.
- Never invent a label. Stage subjects and `Q:` templates come from the skill's tables verbatim; a subject that is not in a table is a bug.

## 5. What tasks do not replace

The modeler's pre-execute yes/no, the modeler's sample-data consent question, the importer's single pre-write gate, every MUST-FIRE widget in the analyst, and the chat final reports (admin final report and close-out, modeler verification report and Closing Contract, importer final report). Tasks track those; they do not stand in for them. Creating tasks is never a pause and never a "Proceed?" prompt: create them, then continue in the same response.
