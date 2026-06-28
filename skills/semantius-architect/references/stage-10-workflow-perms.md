*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 10, Workflow-permission scan — W1 / W2 / W6 ONLY (architect scope)

> **Architect scope.** The architect runs only families **W1**, **W2**, and **W6** — these are detectable at the blueprint level (from §7 lifecycle states + §3 entity classifications, no field shapes needed). Families **W3 (submit-then-lock)**, **W4 (ownership-scoped edit)**, **W4n (narrow-tier external write)**, and **W5 (reassignment)** require field-level shapes and have moved to the analyst (analyst Stage 5).
>
> The architect's job is to identify lifecycle-terminal gates (W1: transition to terminal state; W2: lifecycle closure; W6: create-time gating on restricted entities) and emit the corresponding `workflow-gate (lifecycle)` rows in blueprint §8.1, plus mark the `requires_permission? = ✓` flag on the relevant §7 lifecycle rows. The deeper field-driven gates are the analyst's responsibility.

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
| W6 | **High-weight create / start** | A few entity shapes gate *creation* itself, not just transitions (issuing a new requisition, opening a new GL period, starting a new appraisal cycle). Signal: a §3 entity description that says opening / issuing / starting the entity is restricted to a specific role. Rare; only fire when the description explicitly names a restriction. | `<slug>:open_<noun>`, `<slug>:issue_<noun>` |

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
- **W6 fires** only when §3 prose explicitly says creation is restricted. Otherwise mark `none — creation unrestricted per §3`.

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

#### Present the scan table to the user

After the table, present a compact proposal of just the permissions that fired:

> **Workflow-permission scan for `<slug>`, proposed permissions:**
>
> | Permission | Lifecycle transition gated (§7) | Included in `:admin`? |
> |---|---|---|
> | `ats:approve_offer` | `job_offers` → `approved` | ✓ |
> | `ats:hire_candidate` | `candidates` → `hired` | ✓ |
> | `ats:publish_posting` | `job_postings` → `published` | ✓ |
>
> Show the full scan table too (one row per entity), so a reviewer can confirm each cell. Each permission proposed will be created as its own permission and included in `<slug>:admin`. Look right?

Loop on feedback until confirmed. The result feeds:

- The matching §8.2 business rules (`lifecycle` / `owner_edit` / `narrow_write` source flags); the analyst converts each rule's intent to JsonLogic at spec time, referencing the permission codes this stage produces.
- §8.1's permission enumeration (each workflow gate is an additional permission row, created at deploy time).
- §9.1's permission hierarchy (each workflow gate gets an `<slug>:admin` *includes* `<workflow-perm>` row so admins inherit it; the §8.1 `included in :admin?` column carries the same flag).

**Two-permission and purely-reference fallbacks need a different inclusion story.** A workflow permission's whole purpose is to gate a transition that a regular `<slug>:manage` user shouldn't be able to perform; including it in `<slug>:manage` defeats the gate (every manager would inherit approval authority transitively). The two options for a model with workflow permissions but no admin-tier entities:

1. **Promote to three-permission baseline.** Workflow permissions are themselves evidence of an admin tier, the role that holds approval / override authority. If the model gains any workflow permissions, default to declaring `<slug>:admin` and the matching hierarchy chain `admin includes manage`, `manage includes read`, even when Stage 9 classified zero entities as admin-tier. The workflow gates are then rolled up under `<slug>:admin` cleanly in §9.1. No §3 row carries `write tier: :admin`, but the `baseline-admin` permission still exists as the broader includer. State the reason in §8.1 ("three-permission baseline because the model declares workflow gates; no entity is admin-tier so every entity's `write tier` is `:manage`").

2. **Skip the inclusion entirely.** Each workflow permission stands alone with no hierarchy row. Holders are granted the workflow permission directly through `role_permissions`. This is the right shape when there is genuinely no "module admin" role, just a few users with specific workflow authority.

Most models pick option 1 (the admin role exists in spirit even when no admin-tier entity exists); option 2 is the right shape for small / single-purpose modules where the workflow gate is the only privileged step. Show the user both options in the proposal table and let them pick. Do **not** include a workflow permission in `<slug>:manage`; that's a Blocker the audit catches.

A purely-reference model (zero operational entities) almost never needs workflow permissions; if the analyst sees one anyway, treat it as a 🟡 Warning to revisit the classification.
