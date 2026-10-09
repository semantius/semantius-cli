*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 10, Workflow-permission scan — W1 / W2 / W6 ONLY (architect scope)

> **Architect scope.** The architect runs only families **W1**, **W2**, and **W6** — these are detectable at the blueprint level (from §7 lifecycle states + §3 entity classifications, no field shapes needed). Families **W3 (submit-then-lock)**, **W4 (ownership-scoped edit)**, **W4n (narrow-tier external write)**, and **W5 (reassignment)** require field-level shapes and have moved to the analyst (analyst Stage 5).
>
> The architect's job is to identify process gates (W1: transition to terminal state; W2: lifecycle closure; W6: create-time gating on restricted entities): mark the `requires_permission? = ✓` flag on the relevant §7 lifecycle rows, and record each W6 gate as a §8.2 rule with source flag `create`. Whether a gate also gets its own `workflow-gate (lifecycle)` row in §8.1 depends on the access level the permission step below decides (only under `raci`). The deeper field-driven gates are the analyst's responsibility.

**Lifecycle state field name (fixed `workflow_state`).** Every §7 lifecycle state machine the architect emits is materialized downstream (by the analyst, deployed by the modeler) as a single required `enum` field named **exactly `workflow_state`** — its values are the §7 `state_name`s, its default the `initial?` state. This name is fixed platform-wide. The architect never refers to the state field as `status` / `state` / `lifecycle_state` anywhere (a §3 Description, a §7 cell, a §8.2 rule intent); name the concept in plain English ("the lifecycle state", "once the offer is approved") per Writing Convention 6, and know the field it lands in is `workflow_state`. The deployer FAILS LOUD on any module that stores lifecycle state under another field name, so this is a hard contract, not a preference.

Static `edit_permission` (Stage 9) and conditional lifecycle gates (Stage 10 W1/W2/W6) are two layers of the same RBAC stack: `edit_permission` decides *who can touch this entity at all*, while lifecycle gates decide *who can perform this specific terminal transition*. The architect captures both at the blueprint level; the analyst extends with W3/W4/W4n/W5 once field shapes are known.

This stage is mechanical: **the analyst must produce a structured workflow-permission scan table, one row per entity in §3 order, with one column per signal family.** Empty cells are visible misses, that's the point; a missing entity row is a Blocker.

#### Signal families (six)

Walk these six families against every entity:

| # | Family | Shape test in §3 / §5 | Permission shape when it fires |
|---|---|---|---|
| W1 | **Lifecycle approval / sign-off** | A §7 lifecycle `state_name` that is an authorization-terminal (`approved`, `signed`, `released`, `published`, `posted`, `committed`, `locked`, `executed`, `endorsed`, `ratified`, or a domain-specific equivalent like contract `executed`, invoice `posted`, budget `committed`). | `<slug>:approve_<noun>`, `<slug>:sign_<noun>`, `<slug>:release_<noun>`, `<slug>:publish_<noun>`, `<slug>:post_<noun>` |
| W2 | **Lifecycle terminal closure** | A §7 terminal `state_name` naming closure with audit/contractual weight: `closed`, `cancelled`, `void`, `voided`, `expired`, `archived`, `hired`, `rejected`, `withdrawn`, `lost`, `won`. Filter against the "policy-different" test below: a support-ticket close is usually normal `manage`-work; a contract void or candidate-hire usually isn't. | `<slug>:close_<noun>`, `<slug>:void_<noun>`, `<slug>:hire_<noun>` |
| W3 | **Submit-then-lock (recording-of-evidence)** | Boolean flag `is_submitted` / `is_locked` / `is_final` / `is_complete` OR a `*_at` timestamp acting as the lock (`submitted_at`, `locked_at`, `finalized_at`, `posted_at`). Entity records one user's input into an audit trail (scorecard, journal entry, vote, feedback, attestation, sign-off); the submitter is the one who's permitted to submit AND once submitted the record locks. **This shape is high-value** — `interview_feedback.is_submitted` in ATS is the canonical example. The signal often co-occurs with W5 (the submitter is also the owner). | `<slug>:submit_<noun>`, `<slug>:finalize_<noun>`, `<slug>:lock_<noun>` (or just family-W5 on the owner pattern when the submitter equals the owner) |
| W4 | **Ownership-scoped edit** | Entity carries `created_by` / `author_id` / `owner_id` / `assignee_id` / `interviewer_user_id` / `submitter_user_id` AND §3 framing is *personal / individual / private / their own / drafted by* (notes, comments, drafts, personal feedback, journal entries, individual scorecards). Same as Stage 8 family 13's default fire rule. | `<slug>:manage_all_<plural>` (the elevated override; the owner-equality check is the cheap path) |
| W4n | **External-participant write (narrow tier)** | Entity whose primary writers are *outside* the module's normal operational role: panel interviewers (engineers, PMs, AEs writing `interview_feedback` without recruiter access), external reviewers (a partner organization's reviewer writing performance feedback), vendor reps (a supplier writing into a procurement portal), guest contributors (an external author writing into a CMS draft). Detection signals: §3 prose explicitly names "external", "panel", "guest", "vendor rep", "outside the team"; OR the entity is the only table a class of users needs to write while the rest of the module is recruiter / agent / employee facing. Often co-fires with W3 (the external participant is also the submitter-of-evidence) and W4 elevated (manager-override on the same table). | `<slug>:<role_noun>` declared as a `narrow`-tier row in §8.1 (e.g. `ats:interview`, `perf:reviewer`, `procurement:vendor_rep`); a §8.2 `narrow_write` rule (`<entity>_write_restricted_to_<role>`) scopes writes to the row's owner |
| W5 | **Ownership reassignment** | Owner / assignee FK (`recruiter_id`, `account_owner_id`, `assignee_id`, `coordinator_id`, `manager_id`) where business policy is "this is rebalanced occasionally, but not by anyone". Often signaled by §3 prose mentioning "reassign", "transfer", "rebalance", "hand off". | `<slug>:reassign_<plural>` |
| W6 | **High-weight create / start** | A few entity shapes gate *creation* itself, not just transitions (issuing a new requisition, opening a new GL period, starting a new appraisal cycle). Signal: a §3 entity description that says opening / issuing / starting the entity is restricted to a specific role. Rare; only fire when the description explicitly names a restriction. | a §8.2 rule with source flag `create`; under `raci` also `<slug>:open_<noun>`, `<slug>:issue_<noun>` |

#### The scan-table artifact (mandatory)

Produce one table per model. **Every entity in §3 gets a row.** Reference / lookup entities (Stage 9 admin-tier) and pure junctions usually all-`none`, but they still get a row so the reviewer can see they were considered.

| Entity | W1 lifecycle approval | W2 lifecycle closure | W3 submit-then-lock | W4 ownership scope | W5 reassignment | W6 high-weight create | Proposed permissions |
|---|---|---|---|---|---|---|---|
| `<entity_1>` | `<value_fires_when_specific>` / `none — <reason>` | … | … | … | … | … | `<list of perm codes, or none>` |

For each cell:
- **`none — <one-line reason>`** if the family doesn't fire (no matching enum value, no `*_submitted` field, no owner FK, etc.). The reason is one short clause: *"no `*_submitted` field"*, *"no terminal-authorization value in enum"*, *"all transitions equally sensitive, covered by edit_permission"*, *"shared / collaborative per §3 prose"*. **Empty cell is a Blocker.**
- **`<enum_value> → <perm_code>`** or **`<field> → <perm_code>`** if the family fires. The cell names what specifically triggered it AND the permission code being proposed.
- **`<enum_value> → §7.2`** if the family looks like it should fire but the analyst is deliberately declining to gate it; the §7.2 entry documents the rationale (e.g. *"`tickets.workflow_state='closed'` is reversible and any agent may close; family-W2 declined"*).

The rightmost column is the union of permission codes proposed in this entity's row.

#### Mechanical fire rules (override "looks like" with "fires when")

The point of mechanical rules is to defeat under-detection. Default behavior is to **fire the family** unless the analyst can name a specific reason not to:

- **W1 fires by default** for every enum whose value list contains any of `approved`, `signed`, `released`, `published`, `posted`, `committed`, `locked`, `executed`, `endorsed`, `ratified`. Override only with a §7.2 entry naming a specific domain reason the transition is *not* gated (rare).
- **W2 fires by default** for `void`, `voided`, `cancelled`, `expired` on entities whose §3 description names financial or contractual weight (offers, contracts, invoices, purchase orders, budgets). It fires for `closed`, `archived`, `hired`, `rejected`, `withdrawn`, `lost`, `won` only when §3 prose explicitly says the transition is restricted (e.g. *"requisition closure is the recruiting director's call"*); otherwise mark `none — closure is operational per §3`.
- **W3 fires by default** for any boolean `is_*` lock flag OR any `*_at` timestamp that the §3 description treats as a lock point. The submitter is implicitly the entity's owner (`*_user_id` / `*_by`); the rule restricts the submission to that user AND optionally an elevated override.
- **W4 fires by default** when Stage 8 family 13 fired on the same entity. They are the same signal viewed from two angles (the JsonLogic in §3 vs the permission code in §8).
- **W4n fires** when the entity's primary writers are detectably outside the module's normal operational role — §3 prose names "external" / "panel" / "guest" / "vendor rep" framing, OR the analyst can identify a real class of users that should write this single table without holding `<slug>:manage`. Override with a §7.2 entry naming a domain reason every operational user genuinely needs full `manage`-tier access to write this table. The narrow tier proposed by W4n is declared as a `narrow`-tier row in §8.1 and consumed by a §8.2 `narrow_write` rule; in the §9.1 hierarchy it rolls up under `<slug>:manage` (so `manage` holders transitively pass the narrow check).
- **W5 fires** only when §3 prose explicitly names reassignment as a policy event ("recruiters can be rebalanced", "transferring ownership"). Otherwise mark `none — no reassignment policy in §3`.
- **W6 fires** only when §3 prose explicitly says creation is restricted. Otherwise mark `none — creation unrestricted per §3`. When it fires, record it as a §8.2 rule with source flag `create` (and, under `raci` only, its §8.1 `workflow-gate (lifecycle)` row `<slug>:open_<noun>` / `<slug>:issue_<noun>`, whose code the §8.2 rule's intent names so the analyst binds the insert rule to it).

#### Naming convention for proposed permissions

| Signal | Permission code shape | Examples |
|---|---|---|
| Approving a transition into a terminal-authorization value | `<slug>:approve_<noun>` | `ats:approve_offer`, `procurement:approve_po`, `expense:approve_report` |
| Signing / executing | `<slug>:sign_<noun>` | `contracts:sign_msa`, `hr:sign_offboarding` |
| Publishing / releasing | `<slug>:release_<noun>` / `<slug>:publish_<noun>` | `roadmap:release_train`, `cms:publish_article` |
| Posting / committing accounting-style records | `<slug>:post_<noun>` / `<slug>:commit_<noun>` | `gl:post_entry`, `budget:commit_plan` |
| Submitting evidence (W3) | `<slug>:submit_<noun>` / `<slug>:finalize_<noun>` | `ats:submit_interview_feedback`, `appraisals:finalize_review` |
| Closing / voiding a high-weight record | `<slug>:close_<noun>` / `<slug>:void_<noun>` / `<slug>:hire_<noun>` | `crm:close_opportunity`, `ar:void_invoice`, `ats:hire_candidate` |
| Editing/deleting another user's personal record | `<slug>:manage_all_<plural>` | `ats:manage_all_notes`, `crm:manage_all_activities` |
| Reassigning ownership of a personal/scoped record | `<slug>:reassign_<plural>` | `ats:reassign_candidates`, `crm:reassign_accounts` |
| Opening a high-weight record | `<slug>:open_<noun>` / `<slug>:issue_<noun>` | `procurement:issue_po`, `hr:open_requisition` |
| **Narrow-tier external-participant write** (`narrow` tier in §8.1) | `<slug>:<role_noun>` (bare role, not prefixed with `manage_` or `approve_`) | `ats:interview`, `perf:reviewer`, `procurement:vendor_rep`, `cms:guest_author` |

**Hold the bar high but not too high.** Only propose a workflow permission when the *transition is genuinely policy-different* from the rest of the entity's writes. If every user with `<slug>:manage` can perform every transition without business consequence, mark the cell `none — covered by edit_permission` and skip. The reasonable count of workflow permissions per non-trivial module is **2–6**; zero is a smell that the scan was perfunctory; ten is a smell that static gates were over-promoted.

#### Present the restricted steps to the user

The scan table above stays your working table (mandatory, one row per entity); it is not shown. Required in guided and expert flow; it is its own turn, never combined with another stage's confirmation. Show the gates that fired as restricted steps in plain words (Convention 8), then one plain line for every other entity:

> **Restricted steps.**
>
> | Restricted step | Why it's restricted |
> |---|---|
> | Approving a job offer | it commits the company to a salary |
> | Hiring a candidate | it starts an employment |
> | Publishing a job posting | it makes the posting public |
>
> - Interview notes: no restricted step, notes are routine.
> - Candidate sources: no restricted step, it is a setup list.
>
> Does this look right?

Before the permission step below has run, describe these only as restricted steps and never say who takes them: the access level is not decided yet. In expert flow, when the access-level question can follow, you may add "Who takes them is settled next."

> **Fast flow, after the go-ahead:** don't show the proposal and don't ask; accept the gates as scanned and log one line ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 4). Then run the permission step below with `--flow fast` and take its result.

Loop on feedback until confirmed. Then run the permission step below. The confirmed gates feed:

- §7: the `requires_permission? = ✓` mark on each gated state, and its `derived gate` cell per the body table below.
- §8.2: the matching business rules (`lifecycle` / `owner_edit` / `narrow_write` / `create` source flags); the analyst converts each rule's intent to JsonLogic at spec time.
- §8.1 and §9.1: per the body table below.

### Permission step: decide the access level

> **Interaction flow** (the `.interaction_flow` switch, read at Step 0). **Expert flow off:** pass `--flow guided`; the access-level question is never asked and the script's result stands (only the keep-or-replace question can still come up). Before the script has run, describe gates only as "restricted steps" and never say who takes them; in guided flow, don't name the result afterward either. **Expert flow on:** pass `--flow expert`; ask when the output carries `ask`. **Fast flow, after the go-ahead:** pass `--flow fast` and take the script's result; the keep-or-replace question is the one question asked anyway: it pauses the run, and with the answer the run continues. The answer is never written to `$CUSTOMIZATIONS_FILE`.

Runs as the last step of Stage 10, after the user confirmed the gate scan. The other architect paths run it at the points named in [modes-audit-extend-rebuild.md](modes-audit-extend-rebuild.md) (Customize, Extend, Rebuild) and in SKILL.md (Catalog-Clone). A deterministic script decides the module's access level, the frontmatter `access_scope`; never decide it yourself.

**The access levels:**

| `access_scope` | Permissions | Process gates |
|---|---|---|
| `custom` | set up by hand; the pipeline creates or changes no permission, role or access level | — |
| `basic` | `<slug>:read`, `<slug>:manage` | not enforced |
| `advanced` | `read`, `manage`, `admin` | not enforced |
| `gated` | `read`, `manage`, `admin` | enforced: entering a gated state (or a gated creation) requires `<slug>:admin` directly; no per-gate permission |
| `raci` | `read`, `manage`, `admin`, plus one `workflow-gate (lifecycle)` permission per gate | enforced: each gate's own permission, held **only** by the business roles the confirmed RACI matrix names; **not** included in `<slug>:admin` |

**Run the script:**

```bash
# <skill-folder> = the directory this skill's SKILL.md was read from (absolute path; works for plugin and workspace installs alike)
bun "<skill-folder>/references/decide-access-scope.ts" --slug <system_slug> --flow <guided|expert|fast> \
  --has-reference-data-entities <yes|no> --has-process-gate <yes|no> [--requested-level <basic|advanced|gated|raci>]
```

- `--flow`: the run's interaction flow: `expert` when expert flow is on, `fast` in a fast run, otherwise `guided`. Rebuild (Mode D) always passes `expert`. It never carries the access level.
- `--has-reference-data-entities yes`: the confirmed Stage 9 classification has at least one §3 entity with `entity_type = catalog` whose `role` is `master` or `embedded_master`, not a platform built-in (`users`, `roles`, `permissions`).
- `--has-process-gate yes`: the confirmed scan has at least one gate (a §7 state with `requires_permission? = ✓`, a W6 `create` rule, or a §8.1 `workflow-gate (lifecycle)` row).
- Only for the Customize / Extend first step on a blueprint whose frontmatter has no `access_scope` ([modes-audit-extend-rebuild.md](modes-audit-extend-rebuild.md) Step C1), pass `--blueprint <working copy>` instead of the two `--has-*` flags; the script reads both from the file. Every other run passes the two `--has-*` flags from the current draft, including edits not yet written to the file.
- `--requested-level`: only when the user's request explicitly asked for an access level; otherwise omit it. The script raises its result to it when the design supports it and ignores a lower one. Turning on expert flow is not a request for the access level `advanced`.
- Never pass live state. The script reads the instance itself with two read-only `read_module` calls (other modules using `raci`, and this module's current access level).

**Read the output** (one JSON object: `access_scope`, `ask`, `reason`, `facts`):

- `access_scope` set and `ask` null: that is the access level.
- `ask` set: ask the matching question below, then run the script again with the same flags plus `--keep-custom yes|no` (for `ask.kind = keep_or_replace`) or `--answer <option>` (for `ask.kind = level`). After `--keep-custom no` the script may return a `level` question; run it a third time with both flags.
- Exit 1 (a live read failed: CLI not logged in, instance unreachable): stop and tell the user in one plain sentence that the access level could not be checked against their Semantius instance. The design so far is kept; run this step again once the instance is reachable. Never decide without the script.
- Exit 2 (usage error): your call is wrong; fix the flags and run again.
- `reason` and `facts` are for logs only. In a fast run log the pick with `log_pick architect` ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 5); under the admin, `reason` also goes to `$DIAG_LOG`. Never show `reason`, `facts`, or a raw value to the user, and in guided flow do not tell the user which access level was picked.

**The questions.** Standalone `AskUserQuestion` calls, not ledger `Q:` tasks; never put two of them in one call. `<System name>` is the module's display name.

1. `ask.kind = keep_or_replace` (every flow; in a fast run it pauses the run, is asked, and the run continues). Header `Permissions`. Question: *"<System name> already exists and its permissions were set up by hand. Keep them, or set up access from this design?"* No Recommended marker.
   - `Keep as they are`: *"Nothing about access changes. New parts use the module's current view and edit permissions."* → `--keep-custom yes`
   - `Set up from this design`: *"Access is set up as this design needs it."* → `--keep-custom no`
2. `ask.kind = level`, options `basic` / `advanced` (expert flow). Header `Access level`. Question: *"How should access to <System name> be set up?"* The option matching `ask.recommended` leads, with " (Recommended)" appended to its label.
   - `View and edit`: *"Two levels: people who can view, and people who can also edit."* → `basic`
   - `View, edit and admin`: *"Adds an admin level that maintains the lookup lists and settings."* → `advanced`
3. `ask.kind = level`, options `gated` / `raci` (expert flow). Header `Approvals`. Question: *"Who should take the restricted steps, such as <first gate in plain words>?"* The recommended option leads.
   - `The admin`: *"Only admins can take these steps."* → `gated`
   - `Business roles`: *"Each step is assigned to a business role, such as a hiring manager. You confirm who does what next."* → `raci`
4. Existing module (`facts.current_access_scope` is one of `ask.options`; expert flow). Header and option texts as in question 2 (options `basic` / `advanced` only) or question 3 (otherwise), except the current level, which is labeled `Keep as it is` with a description naming the current level in plain words (→ `--answer <facts.current_access_scope>`). The question starts *"<System name> currently uses <current level in plain words>."*, followed by the question text of 2 or 3. The recommended option leads.

Plain level words (question 4 only): `basic` "view and edit"; `advanced` "view, edit and admin"; `gated` "the admin takes the restricted steps"; `raci` "business roles take the restricted steps".

**After the decision:**

- Result `raci`: Stage 11 drafts the RACI matrix (or shows the one the blueprint already carries) and the user confirms it. The access level is stamped only after the matrix is confirmed; if the user would rather have the admin take the steps, the access level is `gated`: set it directly without running the script again (the one result not taken from the script), and switch the body to the non-`raci` column of the body table below. When the live module already uses `raci` (`facts.current_access_scope` is `raci`), `gated` is not offered: the access level is never lowered, so the user edits the matrix until it is confirmed.
- Stage 13 writes `access_scope` into the frontmatter, and the body follows the access level:

| Part | `raci` | every other access level |
|---|---|---|
| §8.1 baseline rows | read, manage, admin | read, manage; plus admin when the design has reference data entities or a gate |
| §7 `derived gate` on a ✓ row | `<slug>:<verb>` (the naming table above) | `<slug>:admin` |
| §8.1 `workflow-gate (lifecycle)` rows | one per gate (state or `create`); `included in :admin?` = `-` | none |
| §8.2 `create` rule (restricted creation) | present; the analyst gates inserts on the gate's own permission | present; the analyst gates inserts on `<slug>:admin` |
| §9.1 hierarchy | admin→manage→read; no admin→gate rows | admin→manage→read when admin exists |
| RACI trio (realization + Processes wired + §9.2) | required; drafted and confirmed in Stage 11, following the RACI rule (each gate in exactly one process, each process with exactly one accountable row that holds its gates) | kept unchanged when inherited; never drafted |

**When the blueprint already has a body** (Customize first step, Clone, Extend, Rebuild), convert it to the access level. First, a §8.1 `workflow-gate (lifecycle)` row that no §7 ✓ row names (an older W6 creation gate) becomes a §8.2 rule with source flag `create`, so the gate is kept. Under every level except `raci`: set each ✓ row's `derived gate` to `<slug>:admin`, and delete every §8.1 `workflow-gate (lifecycle)` row and every §9.1 `<slug>:admin` → <that gate> row. Under `raci`: give each gate (state or `create`) one §8.1 `workflow-gate (lifecycle)` row with `included in :admin?` = `-`, set its §7 `derived gate` to that code, and delete every §9.1 `<slug>:admin` → <gate> row. Inherited RACI rows keep their gate codes at every level (outside `raci` they are documentation).
