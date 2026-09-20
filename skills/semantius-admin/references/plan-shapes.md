# Plan shapes, authoring rules, and worked examples

Referenced by `semantius-admin/SKILL.md` Step 3 ("Presenting the plan") and Step 6.5 ("Build the checklist"). Load this when building a plan for the user.

Two core invariants govern every shape here (stated in full in SKILL.md, "Core invariants"; only reminders below):

- **Single write gate:** after building a plan you run it; the admin fires no up-front "Proceed?" widget. The modeler shows its own summary and asks the only yes/no before each live-model write.
- **The plan is the task list:** one task per pipeline step (`TaskCreate`, subjects from the Step 6.5 table), plus ONE lead-in sentence in chat. Never a numbered list in chat, never a code fence. Task mechanics live in [`task-tracking.md`](./task-tracking.md).

The examples below show the tasks as bullet lists so you can read them; at runtime they are `TaskCreate` calls followed by `TaskUpdate ... addBlockedBy: [<previous task id>]` on every task after the first (the chain is the order), and only the "Chat:" line is emitted as prose.

---

## Plan-line authoring rules

Apply to every task subject you create:

1. **Lead with the action in plain English**, not with the skill name. The user is deciding whether to proceed, not which agent to fire. `"Match \`ats-candidate-crm\` against your semantic model"` is right; `"Run semantius-analyst to reconcile..."` leaks internal routing.
2. **Use "your semantic model"** (or "the live semantic model") in user-facing prose, never "the catalog". Internal SKILL.md body and architecture docs can still say "catalog"; user-facing chat and task subjects cannot.
3. **Surface filenames in the close-out, not in task subjects.** Subjects are about deciding; close-outs are about confirming what was produced. Path noise in a subject slows the read.
4. **Cue the interaction shape in the lead-in sentence** (the matching step asks merge / reuse questions; the editing step is interactive). The user wants to know whether they'll be asked things or just watch.
5. **State the writes in the lead-in sentence.** The user needs to know which step touches the live model (the modeler asks its own yes/no right before that write). Name steps by what they do ("the apply step"), never by number: task ids interleave with the sub-skills' own stage tasks and with `Q:` ledger tasks, so "step 2" points at nothing reliable.
6. **Subjects come from the Step 6.5 table verbatim** (slug or display name filled in). Inline backticks around a slug are fine in a subject.
7. **No up-front confirmation gate.** Create the tasks and run; never emit a `Proceed? [y / change / cancel]` line or an `AskUserQuestion` "Proceed?" widget. The only write confirmation is the modeler's own pre-execute yes/no, fired after the spec exists. If the user wants to change scope or stop, they say so in chat before the pipeline reaches the modeler; then set the obsolete tasks `deleted` and create the new ones.
8. **Be precise about what each step produces; never describe the system as if this step builds it.** Across the whole pipeline there are exactly three things a step can produce: a **design** (the design step), a **deployable spec** (the matching step), and changes to the **live semantic model** (the apply step). Write every subject and the lead-in around the thing that step actually produces, and never invent a fourth object or a framing the platform doesn't have. Specific traps to avoid:
   - The first step of a from-scratch build is a **design** step. Its subject is `"Design the data model for your <system>, mapping out its entities and how they relate (interactive)."` Do NOT write `"Design the <planner / CRM / tracker>"`: the system itself is not built until the apply step, and that phrasing makes the user think step one produces a working system.
   - Do NOT say `"...into a blueprint"` or otherwise name the file format. `blueprint` and `frontmatter` are internal terms; say "design" or "design document". (`spec` is acceptable in admin subjects and prose, as the examples use it.)
   - Do NOT conflate the system being built (the planner, the CRM) with the design artifact that describes it. They are different things; a subject that turns one into the other ("design the planner into a blueprint") is the exact sloppiness this rule exists to prevent.

---

## The four plan patterns (Step 3)

All four produce the same shape: tasks + one lead-in sentence. They differ only in what precedes the tasks and what the lead-in says.

**Pattern 1 — Read-only plan.** The plan includes only `semantius-analyst` (read-only against the live semantic model; it asks its own reuse / merge / promote questions) or an audit. Fold the discovery fact into the lead-in; do NOT fire a confirmation widget:

- Task: `Match \`ats-candidate-crm\` against your live semantic model and write the spec.`
- Chat: *"Found the ATS Candidate CRM design in your workspace with no matching spec yet. Here is the plan. The matching step asks you a few merge / reuse questions; nothing is applied to your semantic model, and the spec is written to `semantius/specs/`."*

Then enter the analyst immediately.

**Pattern 2 — Write-bound plan.** The plan includes `semantius-modeler` (which updates the live semantic model):

- Task: `Match \`ats-candidate-crm\` against your live semantic model and write the spec.`
- Task: `Apply \`ats-candidate-crm\` to your live semantic model.`
- Chat: *"Here is the plan. The matching step asks you a few merge / reuse questions and writes nothing; the apply step updates your live model after it shows you what changes and you say yes."*

**Pattern 3 — Network-fetch plan.** The input is a URL: fetch the artifact first (Step 2 / Step 6.1), then route through Step 6 like any other deploy.

Fetch without a widget and without a pre-announcement (the URL is already in the user's own message; echoing it back adds nothing): the fetch is harmless, and if the fetched artifact is unexpected the front-matter validation or the analyst's parser will catch it. **The fetch is not the plan and is never a task** (it is internal staging). Its *result* is the one download milestone line (Output discipline, Step 2): the design's `system_name` and the source host, nothing about paths, folders, or validation. Once the artifact lands, resolve the scope flags (the `customize` question fires here whenever the user only said "deploy this"); only THEN are the tasks created (in Step 6.6) from the resolved flags. Do NOT create fetch → match → apply tasks and run them directly from this pattern: that skips the customize question.

Example, where the user said only "deploy the model at `<URL>`". First the milestone, in chat, once the front-matter has validated:

> Downloaded the Real Estate Agent blueprint from example.com.

Nothing else is said about the fetch: not the staging folder, not where the file landed, not whether a matching spec sits in the workspace (that is 1.3 material and either fires its widget or stays in `$DIAG_LOG`). Because the prompt carried no edit-first or as-is qualifier, the `customize` question fires next (exact wording in 6.4, through the ledger). Suppose the user picks "Deploy as designed"; the tasks are then created in Step 6.6:

- Task: `Match \`real-estate-agent\` against your live semantic model and write the spec.`
- Task: `Apply \`real-estate-agent\` to your live semantic model.`
- Chat: *"Here is the plan. The matching step asks you a few merge / reuse questions and writes nothing; the apply step updates your live model after it shows you what changes and you say yes."*

Had the user picked "Edit the design first," a leading `Review and edit \`real-estate-agent\`.` task comes first and the lead-in adds *"The editing step is interactive and ends when you say you are done."*

**Pattern 4 — Greenfield build plan (and catalog clone).** No artifact exists; the architect creates it. **No scope-flag questions fire** (no `customize`, no `review`, no `deploy` ask; see "Scope flags before the plan" in the core invariants). Create the tasks and run:

- Task: `Design the data model for your task list, mapping out its entities and how they relate (interactive).`
- Task: `Match the design against your live semantic model and write the spec.`
- Task: `Apply it to your live semantic model.`
- Chat: *"Here is the plan. The design step is interactive: I'll walk the entities and relationships with you. The matching step builds the deployable spec and asks a few merge / reuse questions; it doesn't touch your live model. The apply step updates your live model after it shows you what changes and you say yes."*

The architect's interactive creation handles every design decision, so there is no separate customize step and no deploy question. A catalog clone uses the same three-task shape with the first subject reading `Clone the \`<source>\` design as a starting point (interactive).`

**Changing scope or cancelling.** If the user wants to adjust the customize / review / deploy choices or stop after seeing the plan, they say so in chat. Re-resolve the flags (Step 6.4), set the obsolete tasks `deleted` and create the new ones, or stop cleanly with one line ("Cancelled. No changes made."). No widget is needed: nothing has run, and the modeler still refuses to write without its own yes/no, so an unintended write cannot slip through.

**Rule of thumb:** confirmation protects the user from unintended writes, and that protection already lives at the modeler (it shows its plan and asks yes/no before every write). A second admin-level gate adds friction without adding protection, so the admin does not fire one.

---

## Worked examples — multi-item and spec runs (Step 6.5)

Create the tasks item by item using each file's `system_slug` (or filename if slug is missing). Each subject stands alone; don't compress repeated phrases; never number them.

**3 blueprints with `customize=no`, `deploy=yes` (each item is analyst → modeler, so 6 tasks):**

- Task: `Match \`hcm-core\` against your live semantic model and write the spec.`
- Task: `Apply \`hcm-core\` to your live semantic model.`
- Task: `Match \`ats-candidate-crm\` against your live semantic model and write the spec.`
- Task: `Apply \`ats-candidate-crm\` to your live semantic model.`
- Task: `Match \`itsm-helpdesk\` against your live semantic model and write the spec.`
- Task: `Apply \`itsm-helpdesk\` to your live semantic model.`
- Chat: *"Here is the plan for the three systems. Each runs its full pipeline before the next starts, and decisions you make for one (such as how to handle a name clash on vendors) are reused for the others without re-asking. Each matching step asks a few merge / reuse questions and writes nothing; each apply step updates your live model after it shows you what changes and you say yes."*

**2 blueprints with `customize=no`, `deploy=no` (analyst-only / dry run, one task per item):**

- Task: `Match \`hcm-core\` against your live semantic model and write the spec.`
- Task: `Match \`ats-candidate-crm\` against your live semantic model and write the spec.`
- Chat: *"Here is the plan for the two systems. Each matching step asks a few merge / reuse questions; decisions you make for one are reused for the other. Nothing is applied to your semantic model; the specs are written to `semantius/specs/`."*

**1 blueprint with `customize=yes`, `deploy=yes` (architect → analyst → modeler, 3 tasks):**

- Task: `Review and edit \`real-estate-agent\`.`
- Task: `Match \`real-estate-agent\` against your live semantic model and write the spec.`
- Task: `Apply \`real-estate-agent\` to your live semantic model.`
- Chat: *"Here is the plan. The editing step is interactive and ends when you say you are done; the matching step then asks a few merge / reuse questions and writes nothing; the apply step updates your live model after it shows you what changes and you say yes."*

**1 spec with `review=no`, `deploy=yes` (direct deploy, 1 task):**

- Task: `Apply \`ats-candidate-crm\` to your live semantic model.`
- Chat: *"Here is the plan. The apply step updates your live model after it shows you what changes and you say yes."*

**1 spec with `review=yes`, `deploy=yes` (review then deploy, 2 tasks):**

- Task: `Review \`ats-candidate-crm\` against your live semantic model.`
- Task: `Apply \`ats-candidate-crm\` to your live semantic model.`
- Chat: *"Here is the plan. The review step compares the spec with your live semantic model and surfaces any drift without writing; the apply step updates your live model after it shows you what changes and you say yes."*
