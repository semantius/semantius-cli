# Plan shapes, authoring rules, and worked examples

Referenced by `semantius-admin/SKILL.md` Step 3 ("Presenting the plan") and Step 6.5 ("Build the checklist"). Load this when rendering a plan to the user.

Two core invariants govern every shape here, stated once so the examples below need not repeat them:

- **INV-1 (single write gate):** after printing a plan you run it; the admin fires no up-front "Proceed?" widget. The modeler shows its own summary and asks the only yes/no before each live-model write (verified in the modeler SKILL, section "The only confirmation the modeler asks").
- **INV-5 (rendering):** render every plan as markdown prose (a short heading, a numbered list, one trailing sentence), never inside a triple-backtick code block. The example blocks below use `> ` blockquotes precisely so you don't mimic a code fence at runtime; emit plain prose, not the `> `.

---

## Plan-line authoring rules

Apply to every example here and every plan line you generate:

1. **Lead with the action in plain English**, not with the skill name. The user is deciding whether to proceed, not which agent to fire. `"Match `ats-candidate-crm` against your semantic model"` is right; `"Run semantius-analyst to reconcile..."` leaks internal routing.
2. **Use "your semantic model"** (or "the live semantic model") in user-facing prose, never "the catalog". Internal SKILL.md body and architecture docs can still say "catalog"; user-facing chat cannot.
3. **Surface filenames in the close-out, not in plan lines.** Plan lines are about deciding; close-outs are about confirming what was produced. Path noise in a plan line slows the read.
4. **Cue the interaction shape** when the step is interactive (analyst's merge/reuse questions). The user wants to know whether they'll be asked things or just watch.
5. **State the writes** in one trailing sentence. The user needs to know which step touches the live model (the modeler asks its own yes/no right before that write).
6. **Render as markdown prose, never code-fenced (INV-5).** The example blocks here use `> ` blockquotes so you don't accidentally mimic a code-fence at runtime; emit plain prose. Inline backticks for `slugs` are fine; the outer fence is not.
7. **No up-front confirmation gate (INV-1).** Print the plan and run; never emit a `Proceed? [y / change / cancel]` line or an `AskUserQuestion` "Proceed?" widget. The only write confirmation is the modeler's own pre-execute yes/no, fired after the spec exists. If the user wants to change scope or stop, they say so in chat before the pipeline reaches the modeler.
8. **Be precise about what each step produces; never describe the system as if this step builds it.** Across the whole pipeline there are exactly three things a step can produce: a **design** (the design step), a **deployable spec** (the matching step), and changes to the **live semantic model** (the apply step). Write every plan line around the thing that step actually produces, and never invent a fourth object or a framing the platform doesn't have, inventing concepts confuses the user about what semantius is doing. Specific traps to avoid:
   - The first step of a from-scratch build is a **design** step. Its line is `"Design the data model for your <system>, mapping out its entities and how they relate (interactive)."` Do NOT write `"Design the <planner / CRM / tracker>"` as step one: the system itself is not built until the apply step, and that phrasing makes the user think step one produces a working system.
   - Do NOT say `"...into a blueprint"` or otherwise name the file format. `blueprint` and `frontmatter` are internal terms; say "design" or "design document". (`spec` is acceptable in admin prose, as the existing examples use it.)
   - Do NOT conflate the system being built (the planner, the CRM) with the design artifact that describes it. They are different things; a plan line that turns one into the other ("design the planner into a blueprint") is the exact sloppiness this rule exists to prevent.

---

## The four plan patterns (Step 3)

**Pattern 1 — Read-only plan.** The plan includes only `semantius-analyst` (which is read-only against the live semantic model and asks its own interactive reuse/merge/promote questions during reconciliation) or admin-only operations (status, backup, health, audit).

**Just announce and run.** Do NOT fire the confirmation widget. The analyst itself will surface plenty of decisions; adding a redundant pre-confirmation is friction. Example announcement (one paragraph, no list, no gate):

> Found `ats-candidate-crm-semantic-blueprint.md` in the workspace (no matching spec yet). Building the deployable spec now by matching it against your live semantic model; you'll be asked a few merge / reuse / promote questions along the way. This produces a spec file but doesn't change your live model.

Then invoke the analyst immediately.

**Pattern 2 — Write-bound plan.** The plan includes `semantius-modeler` (which updates the live semantic model). Render as a numbered list (informational):

> **Plan:**
>
> 1. Match `ats-candidate-crm` against your live semantic model and write the spec.
> 2. Apply `ats-candidate-crm` to your live semantic model.
>
> Step 1 is the spec-building step: it produces the deployable spec file and asks you a few merge / reuse / promote questions; it doesn't touch your live model. Step 2 applies that spec; the modeler shows what it will change and asks a final yes/no before it updates the live model.

**Pattern 3 — Network-fetch plan.** The input is a URL: fetch the artifact first (Step 2 / Step 6.1), then route through Step 6 like any other deploy.

**Print the URL** you're about to fetch, then proceed without firing a widget for the fetch itself: the fetch is harmless, the user can see the URL is right, and if the fetched artifact is unexpected the analyst's parser will catch it. **The fetch is not the plan.** Once the artifact lands, resolve the scope flags (the `customize` question fires here whenever the user only said "deploy this"); only THEN is the plan rendered (in Step 6.6) from the resolved flags. Do NOT render a fetch → match → apply plan and run it directly from this pattern: that skips the customize question.

Example, where the user said only "deploy the model at `<URL>`". First the fetch result:

> Fetching `https://example.com/blueprints/ats.md` ...
>
> Fetched `real-estate-agent-semantic-blueprint.md` (slug: `real-estate-agent`, 7 entities). No matching spec in the workspace.

Because the prompt carried no edit-first or as-is qualifier, the `customize` question fires next (exact wording in 6.4). Suppose the user picks "Deploy as designed"; the plan then renders in Step 6.6:

> **Plan:**
>
> 1. Match `real-estate-agent` against your live semantic model and write the spec.
> 2. Apply `real-estate-agent` to your live semantic model.
>
> Step 1 is the spec-building step: it produces the deployable spec file and asks you a few merge / reuse / promote questions; it doesn't touch your live model. Step 2 applies that spec; the modeler shows what it will change and asks a final yes/no before it updates the live model.

Had the user picked "Edit the design first," the plan would carry a leading "Review and edit `real-estate-agent`" line instead.

**Pattern 4 — Greenfield build plan (and catalog clone).** No artifact exists; the architect creates it. **No scope-flag questions fire** (no `customize`, no `review`, no `deploy` ask) — see INV-3. Render the plan and run:

> **Plan:**
>
> 1. Design the data model for your task list, mapping out its entities and how they relate (interactive).
> 2. Match the design against your live semantic model and write the spec.
> 3. Apply it to your live semantic model.
>
> Step 1 is interactive: I'll walk the entities and relationships with you. Step 2 builds the deployable spec and asks a few merge / reuse / promote questions; it doesn't touch your live model. Step 3 applies it; the modeler shows what it will change and asks a final yes/no before writing.

The architect's interactive creation handles every design decision, so there is no separate customize step and no deploy question. A catalog clone uses the same three-line shape with step 1 reading *"Clone the `<source>` design as a starting point (interactive)."*

**Changing scope or cancelling.** If the user wants to adjust the customize / review / deploy choices or stop after seeing the plan, they say so in chat. Re-resolve the flags (Step 6.4) and re-render the plan, or stop cleanly with one line ("Cancelled. No changes made."). No widget is needed: nothing has run, and the modeler still refuses to write without its own yes/no, so an unintended write cannot slip through.

**Rule of thumb:** confirmation protects the user from unintended writes, and that protection already lives at the modeler (it shows its plan and asks yes/no before every write). A second admin-level gate adds friction without adding protection, so the admin does not fire one.

---

## Worked examples — multi-item and spec runs (Step 6.5)

Render the checklist as a numbered list using each file's `system_slug` (or filename if slug is missing). For multi-item runs, numbering is continuous across items (item one is lines 1..k; item two is lines k+1..m; ...). Each line stands alone; don't compress repeated phrases.

**3 blueprints with `customize=no`, `deploy=yes` (each item is analyst → modeler, so 6 lines total):**

> **Plan (3 items):**
>
> 1. Match `hcm-core` against your live semantic model and write the spec.
> 2. Apply `hcm-core` to your live semantic model.
> 3. Match `ats-candidate-crm` against your live semantic model and write the spec.
> 4. Apply `ats-candidate-crm` to your live semantic model.
> 5. Match `itsm-helpdesk` against your live semantic model and write the spec.
> 6. Apply `itsm-helpdesk` to your live semantic model.
>
> Each item runs its full pipeline before the next starts. Decisions you make for one item (such as how to handle a name clash on `vendors`) are reused for later items without re-asking. Lines 2, 4, and 6 update the live model.

**2 blueprints with `customize=no`, `deploy=no` (analyst-only / dry run, one line per item):**

> **Plan (2 items):**
>
> 1. Match `hcm-core` against your live semantic model and write the spec.
> 2. Match `ats-candidate-crm` against your live semantic model and write the spec.
>
> Each item runs to spec completion before the next starts. Decisions you make for one item (such as how to handle a name clash on `vendors`) are reused for later items without re-asking. Nothing is applied to your semantic model; specs are written to `semantius/specs/`.

**1 blueprint with `customize=yes`, `deploy=yes` (architect → analyst → modeler, 3 lines):**

> **Plan (1 item):**
>
> 1. Review and edit `real-estate-agent`.
> 2. Match `real-estate-agent` against your live semantic model and write the spec.
> 3. Apply `real-estate-agent` to your live semantic model.
>
> The customize step is interactive; the matching step then asks the usual merge / reuse / promote questions. Line 3 updates the live model.

**1 spec with `review=no`, `deploy=yes` (direct deploy, 1 line):**

> **Plan (1 item):**
>
> 1. Apply `ats-candidate-crm` to your live semantic model.
>
> Line 1 updates the live model.

**1 spec with `review=yes`, `deploy=yes` (review then deploy, 2 lines):**

> **Plan (1 item):**
>
> 1. Review `ats-candidate-crm` against your live semantic model.
> 2. Apply `ats-candidate-crm` to your live semantic model.
>
> The review step compares the spec against the current state of your live semantic model and surfaces any drift. Line 2 updates the live model.
