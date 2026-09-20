# Stage 3g: Confirm the plan and fields

*Reference for `semantius-analyst`. Before rendering, this gate runs drift resolution ([`stage-3f-drift.md`](stage-3f-drift.md)) then field drafting ([`stage-4-fields.md`](stage-4-fields.md)); its revise-plan path re-enters the 3a-3e widgets in [`stage-3-collisions.md`](stage-3-collisions.md).*

### 3g. Confirm the plan and fields (the final gate, after drift resolution and field drafting)

This is the **single final confirmation gate**: it runs after every other Stage 3 decision. Before rendering the summary, complete two procedures (detailed below) so the summary reflects what will actually be built, then do not repeat them after the user confirms:

1. **Resolve adopted-entity drift** (3f) for every `reuse-from` / `rename-incoming-from` / `promote-to-master` entity.
2. **Draft the fields** (Stage 4) for every owned entity (`create-new` / `rename-incoming-from` / `promote-to-master`).

Then render a plan summary as **markdown prose** (NOT inside a triple-backtick code block — that would make the runtime mimic the fence and emit a monospaced wall of text). Use bold headings, bullet lists, and inline backticks for slugs only. The summary now includes the drafted fields (see the Fields block in the render shape) so the user can spot anything they want to change before the file is written.

**Render shape** — substitute the actual module, entities, row-scope / lifecycle decisions, and link decisions:

> 📦 **Module:** `ats-candidate-crm` (♻️ exists, will update metadata)
>
> 🔑 **Permissions:** 3 baseline (`:read`, `:manage`, `:admin`) plus workflow gates derived from the lifecycle states (rebased onto `ats-candidate-crm:*` since the catalog owner modules aren't deployed).
>
> 🗂 **Entities** (6 from your design, plus 1 built-in):
>
> | | Entity | Outcome | Behavior |
> |---|---|---|---|
> | ✨ | Candidates | set up new | Per-user records |
> | ✨ | Job Postings | set up new | (none) |
> | ✨ | Applications | set up new | Per-user records |
> | ✨ | Interview Scorecards | set up new | Per-user records, Locks once submitted |
> | ✨ | Offers | set up new | Per-user records, One approver |
> | ✨ | Recruitment Sources | set up new | Reference list |
> | 🟢 | Skill Profiles | use the existing one from `lms-skills` | (read inclusion auto-wired) |
> | 🔒 | Users | use the Semantius built-in | (none) |
> | ❌ | Career Aspirations | skipped (you opted out) | (none) |
>
> 🧩 **Fields** (drafted for the entities being set up, names and types only; full detail, descriptions, and rules land in the file):
> - **Candidates** (9): Full Name *(text, label)*, Email *(email, unique)*, Phone *(text)*, Workflow State *(stages: New → Screening → Interview → Offer → Hired)*, Source *(→ Recruitment Sources)*, Owner *(→ Users)*, …
> - **Offers** (7): Offer Title *(text, label)*, Workflow State *(stages: Draft → Approved → Sent → Accepted)*, Salary *(number)*, Candidate *(→ Candidates)*, …
> - *(one line per entity being set up; reused, built-in, and skipped entities have no field line)*
>
> 🔗 **Cross-module links:** all currently dormant. None of `job_profiles`, `skill_profiles`, `job_requisitions`, `candidate_referrals`, `recruitment_agencies`, `recruitment_events`, `talent_pools`, `candidate_assessments`, `background_checks`, `onboarding_journeys`, `benefit_enrollments`, `compensation_statements`, `employees`, `pre_employees` are in your semantic model yet. Recorded as future links; no link columns are created this run.
>
> 🔁 **Lifecycle gates** (rebased onto this module's slug):
> - `ats-candidate-crm:hire_candidate`, `ats-candidate-crm:flag_do_not_hire` (Candidates)
> - `ats-candidate-crm:submitted_interview_scorecard` (Interview Scorecards)
> - `ats-candidate-crm:approve_offer`, `ats-candidate-crm:rescind_offer` (Offers)
> - `ats-candidate-crm:publish_posting` (Job Postings)
>
> 🛡 **Owner-scoped visibility** added for Candidates, Applications, Interview Scorecards, Offers: each gets a `view_all_*` plus `manage_all_*` permission pair so users see only their own rows by default, with managers able to broaden (the row-scope playbook's owner + oversight shape).

**Plan-summary authoring rules:**

1. **No `§N` references** in user-facing text. Use plain English ("the lifecycle states", "the cross-module section").
2. **No annotation values as words** in the Outcome column. Translate using the table below.
3. **No internal flag / mechanism names.** Describe row-scope, locks, and approvals in plain user language (the behavior-phrasing table below); never surface `select_rule` / `validation_rule` / permission codes.
4. **No em-dashes** (`—`). Use commas, parens, or sentence splits.
5. **No "live catalog"** — say "your semantic model".
6. **No "FK columns"** / "FK emitted" — say "link columns".
7. **Render as prose**, not as a code-fenced block.
8. **Echo applied Additional Requirements.** When the blueprint carried an `## Additional Requirements Specification` section, add one line to the plan summary, in plain English (Convention 8 applies, this is user-facing chat, so no backticks, use Labels): summarize each requirement and name where it landed (a field you added, an open question you recorded). Example: *"📐 Extra requirements applied: added an annual cost figure and a currency code to Asset Contracts and SaaS Subscriptions; recorded the standalone-vs-full-module dedup rule as an open question."* Omit the line entirely when the blueprint had no such section.
9. **Keep the Fields block compact.** One line per owned entity: its Plural Label, a field count, then field Labels with their format (and FK target as a Plural Label) only. Never paste full field tables, descriptions, validation rules, or full enum value lists into the summary, those live in the file and in the per-entity Adjust view. Reused, built-in, and skipped entities get no field line.
10. **Name every blocker.** When drift resolution (3f) produced any blocker the deployer cannot clear on its own (a cross-primitive format change, a field-name or enum-value migration the user chose to keep, a destructive precision or uniqueness change), add one line after the Fields block: *"🔴 Needs a manual step before deploy: <one plain-English clause per blocker, naming the entity and field by Label>"*. Omit the line entirely when there is no blocker. This is the only place such a blocker reaches the user before the file is written, so never skip it.

**Outcome-column translation:**

| Internal annotation | Outcome cell text |
|---|---|
| `create-new` | `set up new` |
| `reuse-from <module>.<entity>` | `use the existing one from \`<module>\`` (or `use the Semantius built-in` for `semantius_builtin.*`) |
| `rename-incoming-from <existing>.<entity> as <new_name>` | `keep our own as \`<new_name>\`` |
| `promote-to-master <host>.<entity>` | `share via \`<host>\` master module` |
| `dropped (optional, user declined)` | `skipped (you opted out)` |
| `dropped (out of scope)` | `skipped (out of scope)` |

**Behavior phrasing** (the analyst derives these behaviors itself — there are no blueprint flags; this table is the plain-language vocabulary for the plan summary):

| Behavior the analyst applied | Plan-summary text |
|---|---|
| Owner-scoped rows (row-scope playbook: private or owner + oversight) | `Per-user records` |
| Submit-then-lock `validation_rule` | `Locks once submitted` |
| Single approval gate (§7 gated transition + RACI Accountable) | `One approver` |
| Multi-party approval `validation_rule` | `Multiple approvers` |
| Reference / catalog entity | `Reference list` |
| Terminal-state lock `validation_rule` | `Locks at final state` |
| (no special behavior) | `(none)` or empty cell |

Combine multiple behaviors with a comma: `Per-user records, Locks once submitted`.

**Closing confirmation.** Precondition: `TaskList` shows no `Q:` task pending or in progress (every 3a-3f decision recorded); an open one means back to the ledger, not to this widget. This confirmation and its follow-ups are standalone questions, not ledger tasks. After the plan summary, call `AskUserQuestion`:

- **question**: `"Does this plan look right?"`
- **header**: `"Confirm plan"`
- **multiSelect**: `false`
- **options**:
  1. label `"Yes, looks good (Recommended)"`, description `"Set up the entities and fields exactly as shown, then write the file."`
  2. label `"Adjust the fields for an entity"`, description `"Pick an entity and review or change its fields (names, types, required, choices) before anything is written."`
  3. label `"Revise the plan"`, description `"Change which entities are included, reused, renamed, or linked. The plan re-renders after the change."`
  4. label `"Cancel"`, description `"Stop without writing the file."`

On option 2 (adjust the fields), fire a follow-up `AskUserQuestion` picker over the owned entities: question `"Which entities do you want to adjust the fields for?"`, header `"Which entity"`, `multiSelect: true`, one option per owned entity (label = Plural Label, description = one line on what it holds). For each entity the user picks, show its full field table (the Stage 4 columns) and let them change field names, formats, required flags, labels, and enum values. Apply the edits, then re-render the plan summary, and only then fire this confirmation widget again, alone in its own response (never in the same response as the edit or re-render tool calls). On option 3 (revise the plan), fire a follow-up `AskUserQuestion` picker over the entities and links from the plan: question `"Which parts of the plan do you want to revise?"`, header `"Which parts"`, `multiSelect: true`, one option per entity or link (label = Plural Label, or `"<Plural Label> to <Plural Label> link"`; description = the plan's current decision for it in one line); the user picks one or more, and the analyst sets the corresponding completed `Q:` tasks back to `pending` (`TaskList`, then `TaskUpdate`; the tasks already carry the question text and policy path, so nothing is re-derived), re-enters the ledger loop for them, then re-runs drift resolution and field drafting for any affected entity. After all revisions, re-render the plan summary and fire the confirmation widget again. On option 4 (cancel), narrate one line ("Cancelled. Nothing was written.") and stop.

**Shaping both pickers** (SKILL.md → AskUserQuestion mechanics: 2 to 4 options per question object, never 1, never 5). Count the items (K):

| K | Shape |
|---|---|
| 1 | Skip the picker: the one item counts as chosen. Go straight to its field table (option 2) or set its `Q:` tasks back to `pending` (option 3). |
| 2, 3, or 4 | 1 question, K options |
| 5 to 16 | Several questions in the same call, same header, question text suffixed ` (<i> of <N>)`, filled in plan order in chunks of 4, the last item of the previous chunk moved into the last chunk when it would otherwise hold 1 (5 → 3 + 2, 6 → 4 + 2, 9 → 4 + 3 + 2, 13 → 4 + 4 + 3 + 2) |
| more than 16 | Same chunks, at most four question objects per call; fire the next call with the remaining chunks after the first answers arrive, then act on the union of all picks |

Never merge two items into one option, never pad with a filler option.

**Closing narration after the confirmation step** (only when the user said "Yes, looks good"): one short sentence stating the next action, in plain English. Example: *"Writing the file with the entities and fields as confirmed."* No "round-trip", no "single-pass", no internal flow vocabulary. After this, the remaining stages (governance authoring, the mechanical scans) run without further prompts: there is no downstream access-control widget, because the basic-vs-advanced decision was already made and the documentation-vs-living split is auto-derived (Stage 9.5 Step 0).
