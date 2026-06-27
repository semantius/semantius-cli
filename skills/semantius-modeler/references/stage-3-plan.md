# Stage 3: Plan and present (modeler reference)

_Read this when the workflow reaches Stage 3. The stage map is in SKILL.md._

## Stage 3: Plan and Present (and resolve ambiguity)

Before running any writes, show the user a clear plan. The plan must have two parts: (1) the normal module/permission/entity summary, and (2) **an ambiguity-decisions section if any 🛑 buckets were raised in Stage 2**. No writes happen until every 🛑 has an explicit decision.

### Normal plan (example)

```
📦 Module: saas_expense_tracker
  ✨ Will create (new module)
  🔑 Permissions: ✨ saas_expense_tracker:read, ✨ saas_expense_tracker:manage, ✨ saas_expense_tracker:admin
  🔗 Permission hierarchy: ✨ admin → manage, ✨ manage → read
  🛠 Admin-tier entities (edit_permission = saas_expense_tracker:admin): departments, budget_periods
  🛠 Operational entities (edit_permission = saas_expense_tracker:manage): every other entity below

🗂 Entities (7 total):
  🔒 users (Semantius built-in, reusing; model declares 3 extra fields: `department_id`, `job_title`, `employee_id`, will add additively with user confirmation)
  ✨ vendors: will create + 6 fields
  ✨ subscriptions: will create + 26 fields
  ✨ departments: will create + 5 fields
  ✨ budget_periods: will create + 6 fields
  ✨ budget_lines: will create + 8 fields
  ✨ license_assignments: will create + 7 fields

Total to create: 1 module, 3 permissions, 2 hierarchy rows, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🧠 Entity-level rules (calculated values and save-time checks):
  ✨ `subscriptions`: 1 computed_fields, 3 validation_rules
  ✨ `budget_lines`: 2 validation_rules

👁 Entity-level read rules (who can see which records):
  ⚠️ `license_assignments`: ✨ select_rule, will scope per-row visibility to the row's `assignee_user_id` (medium-risk visibility change, pending confirmation)

🎛 Field-level UI rules (how fields behave on the form):
  ✨ `subscriptions.renewal_date`: input_type_rule (hidden until workflow_state=`renewed`)
  ✨ `subscriptions.cancelled_at`: input_type_rule (hidden until workflow_state=`cancelled`, then readonly)
  ✨ `budget_lines.approved_at`: input_type_rule (readonly once workflow_state=`approved`)

🔗 Connections to other modules:
  ✨ Propose on `subscriptions`: + `contract_id → contracts` (governs, clear); pending confirmation
  ✨ Propose on `subscriptions`: + `project_id → projects` (charged to, clear); pending confirmation
  💤 Skipped (target not in catalog): `subscriptions → cost_allocation_rules`
```

The read-side and UI-rule sub-sections only appear when the model declares them (most models omit them; the sub-sections are omitted from the plan too — don't render empty bullets). The `select_rule` row carries the `⚠️` marker because applying it changes who can see which rows (medium-risk visibility shift); the deployer pauses for explicit confirmation on every `select_rule` create / modify / remove, same posture as a tier flip on `edit_permission`.

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12), will update module metadata from the new model and diff entities to apply only changes`. Render the field-level deltas inline under each ♻️ entity so the user sees exactly what's about to change, not just a vague "will diff" promise:

```
🗂 Entities (7 total):
  ♻️ subscriptions: 26 fields, 4 drifted, 1 new
     ~ vendor_name.description: "Vendor" → "Legal name of the contracting vendor"
     ~ workflow_state.enum_values: + "renewed", + "expired"
     ~ amount.searchable: false → true
     ~ contract_url.format: text → html (same primitive, accepted)
     + renewal_date (date, optional)
     ⚠️ select_rule: new (model adds row-level visibility scope on `created_by_user_id`)
     + renewal_date.input_type_rule: hidden-until-renewed
  ♻️ vendors: 6 fields, no drift
  ✨ budget_lines: will create + 8 fields
```

Use `~` for drifted properties (with `old → new`), `+` for additions, and surface `🛑` separately for anything that blocks the fast-path (enum removals, cross-primitive format changes, field deletions, tier flips). The 🛑 deltas route through the normal Stage 3 ambiguity dialog; the `~` and `+` deltas are informational and apply automatically once the plan is approved (or under the clean re-run fast-path, immediately). The `⚠️ select_rule` line is **not** auto-applied even under the fast-path — read-visibility changes always pause for explicit user confirmation (same rule as `edit_permission` tier flips).

### Plan-summary lines for master-data flows

The Stage 3 plan emits these standardized line types when master-data operations are in play. They appear alongside the normal `📦 ✨ ♻️ 🔑 🔗 🛠 🗂 🔒 🧠 👁 🎛 💤` vocabulary; each is a discrete decision the user sees before approval.

| Line | Meaning |
|---|---|
| `🟢 <entity> → already shared in <master_module>` | Branch A wire-up. Entity exists in a master module; this consumer is being added. Includes the read inclusion (always) and notes whether manage inclusion is also planned (depends on the per-consumer manage prompt). |
| `🔗 Permission inclusions (cross-module, new)` block | Lists every `permission_hierarchy` row this deploy will create across module boundaries, with `[origin=model_master]` annotations and the manage-option label from Stage 2d's follow-up. |
| `🆕 Master module created: <slug>` | A new `module_type = "master"` module will be created (either by promotion at Stage 2d Branch B, or by an upfront master-model deploy). |
| `🔁 Renaming master module:` block | A master-model deploy is renaming an existing master in place (cascade per Stage 4b-rename: module slug + per-tier permission codes + per-tier role slugs). Old → new on each line. |
| `📥 Merging master modules:` block | A master-model deploy is consolidating multiple single-entity masters into one domain cluster (Path 2, plan §5.4.5). Lists each source master being merged in and the target. Source masters are left as quiet orphans (never deleted per "No auto-deletion"). |
| `✨ <slug>:admin / <slug>_admin role` | Three-permission upgrade case: the model now needs `:admin` where the live module only had `:read` / `:manage`. Adds the missing permission, role, hierarchy row, and module FK columns. |
| `🌱 Seeded <master>_manager with N members from <original>_manager` | Branch B promotion seeds the master's manager role from the original module's manager-role members. Snapshot-time copy; new `<original>_manager` members added later don't auto-inherit master stewardship. |
| `💡 Cluster hint: <entity> → <cluster>` | An entity in this deploy carries an analyst-emitted `**Shared master cluster:**` annotation, and the hint is shaping a Stage 2d follow-up 1 default (existing-master match or new-module name suggestion). Informational; the user can override at the prompt. |
| `🏷 module_kind = <kind>` | Informational label from frontmatter (`domain` / `master` / `starter` / etc.). No behavior switch. |
| `🔐 Access control: Basic (read + edit)` | The Stage 2.5 resolved scope is `basic`. The plan shows the two-permission shape: `<slug>:read` + `<slug>:manage`, viewer + manager roles, no admin tier / gates / personas / RACI. When the spec was full-shaped and projected, add `(projected; N permissions, M roles, K lifecycle gates skipped)` so the user sees what was suppressed. |
| `🔐 Access control: Full RBAC (<N> permissions, <M> roles, lifecycle gates)` | The Stage 2.5 resolved scope is `full`. The plan shows the complete governance surface (current behavior). |
| `👥 Personas to provision: <list>` | Per-persona summary from §9 RACI + frontmatter `persona`. Stage 4k creates each named persona as a tenant role and grants its RACI permissions. Each line names the persona slug and the count of grants. **Omitted under `🔐 Access control: Basic`.** |
| `🏢 Functional ownership: owner = <function>.<role>, contributor = <function>.<role>` | Summary from §9.2 functional ownership table. Stage 4l grants the named default-tier permission to the named default role for each row. |
| `🔁 Re-prefix: <slug>:<verb> (catalog <module> not installed)` | The permission row in §8.1 carries a `re-prefixed-from <catalog-module>.<verb>` annotation AND the catalog module isn't installed. Stage 4a-scaffold mints the permission under the installing-unit slug; Stage 2i has queued it for future reconciliation. |
| `🔁 Master-install reconciliation: rename <slug>:<verb> → <catalog-module>:<verb>; migrate <N> grants` | The catalog module IS installed AND a Branch-B promotion will move the entity. Stage 4n will mint the catalog-prefixed sibling permission, create sibling `role_permissions` rows for every grant on every accumulated non-catalog prefix, and re-emit matching `permission_hierarchy` edges. No deletes. |
| `⚠️ Skipping <entity>.<state> — ⚠ <annotation kind>` | Per §7 lifecycle row carrying a `⚠ state-machine shape` or `⚠ unresolved gate` annotation. The deployer SKIPS the row (does NOT silently provision). The line is informational + halt-on-execute. |
| `💤 Skipping FK <from>.<target_id> → <target_entity> — target not installed (presence-conditional)` | Per §5 edge with `delete_mode: none (required-if-present)` AND target absent from live catalog. Stage 4d skips the FK column emission entirely (no broken non-null restrict). |

Example master-data plan block (Branch B promotion + Branch A wire-up + cluster hint):

```
🗂 Master-data operations:
  🛑 vendors — cross-module collision with `itsm.vendors` (domain module)
     💡 Cluster hint: vendors → parties
     ⚠️ Will request: 4-option resolution (promote / rename incoming / use existing / abort) + follow-ups (host module, manage decision)
  🟢 cost_centers → already shared in `finance` master (auto-wire)
  💡 Cluster hint: cost_centers → finance (matched existing master `finance`, recommended)
  🌱 (planned) Seed `parties_manager` with 3 members from `itsm_manager` if option 1 picked
🔗 Permission inclusions (cross-module, new):
   itam:read    → parties:read         [origin=model_master, always]
   itam:manage  → parties:manage       [origin=model_master, pending manage-option pick]
   itsm:read    → parties:read         [origin=model_master, always]
   itsm:manage  → parties:manage       [origin=model_master, pending manage-option pick]
   itam:read    → finance:read         [origin=model_master, Branch A read inclusion]
```

### Cross-model link suggestions (additive, reversible)

§6 link proposals are **additive and reversible**: adding an optional cross-module FK never breaks the local module, never deletes data, and can be removed later by editing the model and redeploying. Because of that the deployer's posture is *err toward implementing*. Don't drag the user through individual confirmation when the analyst has already drafted a hint and the target exists in the catalog.

**Print the link-proposal summary as prose first** (the same `🔗 Connections to other modules` block from the normal plan), so the user has the list in front of them before any widget appears.

**Resolve Ambiguous rows first.** Any rows marked 🟡 Ambiguous in Stage 2g (multiple plausible targets matched the `To` concept) gate which proposals are even askable. Batch one question per ambiguous row into a single `AskUserQuestion` call. Each question's options list the candidate target tables (with their owning module for context) plus a "skip this row" option. After the user picks, the Ambiguous rows that resolved promote into the ✨ Proposed list and the rest drop out.

**Resolve Field-name collisions next.** Any row marked 🛑 Field-name collision in Stage 2g (the auto-generated `<target_singular>_id` already exists on `from_table`) is also batched into the same `AskUserQuestion` call. Options: provide an alternative field name (the runtime's "Other" slot accepts free text) or skip the row. Unresolved-source rows are also surfaced here for the user to fix the model via the analyst skill before this stage retries.

**Then approve the Proposed list.**

- **0 proposals**, skip this section entirely; nothing to ask.
- **1–3 proposals**, present inline with one combined confirmation: *"Apply these N cross-model link suggestions? [yes / review each / skip all]"*. Default branch on `yes` is "apply all".
- **4 or more proposals**, call `AskUserQuestion`:

  - **question**: `"Found N possible connections between this module and other modules already deployed. How should we handle them?"`
  - **header**: `"Module connections"`
  - **multiSelect**: `false`
  - **options** (in this order, recommended first):
    1. label `"Connect all (Recommended)"`, description `"Add every connection in one pass. Each is an optional link, removable later if you change your mind. Best when the other modules are familiar."`
    2. label `"Review each one"`, description `"Walk through each connection individually. Use when you're unsure about any of the targets, or when a connection touches a sensitive shared module."`
    3. label `"Skip them all"`, description `"Deploy the module without any of these connections. They'll come back next deploy unless you remove them from the design first."`

**On `Apply all`**, Stage 4h executes every Proposed row without further prompts.

**On `Review each one`**, fall back to one batched `AskUserQuestion` with one question per proposal (yes / skip), then Stage 4h executes only the accepted ones.

**On `Skip all`**, Stage 4h is a no-op. The dormant rows and the explicitly-skipped ones are noted in the verification summary so the user knows nothing was wired up.

This flow is **distinct from the 🛑 ambiguity protocol below for entity name collisions**. Entity-name ambiguity gates are blockers; the deploy cannot proceed until the user picks merge / rename / etc. Link proposals are not blockers; skipping them lets the deploy proceed unchanged. Keep the two flows separate.

### No ambiguity widgets at the modeler layer

The modeler does NOT drive `AskUserQuestion` widgets for cross-module collisions, similar-name flags, master promotions, or merge / rename decisions. Every such decision is already encoded in the spec as a `**Reconciliation:**` annotation. If Stage 2 detected drift (an annotated `reuse-from` target is missing, a `rename-incoming-from` target name now exists, a `promote-to-master` host module is missing or wrong type), the modeler halts and routes the user back to the analyst — it does not try to re-decide.

**The only confirmation the modeler asks** is the final pre-execute yes/no after the plan summary:

> *"Plan shown above. Proceed with execution?"*

A `select_rule` create / modify or an `edit_permission` tier flip still pauses for explicit confirmation (medium-risk: read-visibility or write-tier change). The **Stage 2.5 access-control prompt** is the one other permitted mid-flow prompt, and it is bounded the same way: it fires **only** when the access-control choice is genuinely undecided (no `access_scope` in the spec frontmatter, no `access_scope` on the module). When the spec encodes the choice — the hybrid path — no prompt fires; the modeler obeys, exactly as it obeys a `**Reconciliation:**` annotation. The prompt is a deploy-time decision the spec deliberately left open (same category as the §6 cross-model-link prompt), not a re-litigation of a decision the spec already made. These are the only mid-flow prompts.

### Merge / rename rules (informational)

When the spec carries `rename-incoming-from <existing_module>.<existing_entity> as <new_name>`, the modeler creates `<new_name>` as a brand-new entity in this module. There is no `update_entity` rename — the existing entity stays where it is, untouched. The user has decided (via the analyst) that the two concepts are different and should silo.

When the spec carries `promote-to-master <master_module>.<entity>`, the modeler **reassigns the existing entity to `<master_module>`** via `update_entity` (changes `module_id` only — the entity's `slug`, underlying Postgres table, data, and every `reference_table` pointer at it across the catalog stay byte-for-byte unchanged). Creates `<master_module>` if missing per the spec's `promotion_decisions` frontmatter. Seeds the master's `<master>_manager` role from the original module's `<original>_manager` members, and adds cross-module permission inclusions per the recorded `manage_option`. The original module gets a `permission_hierarchy` row `<original>:read → <master>:read` (always) and `<original>:manage → <master>:manage` (conditional on `manage_option`). **No data migration, no FK rewires, no orphan tables** — this is a metadata-only operation in the catalog.

When the spec carries `reuse-from <module>.<entity>` for a master/shared entity, the modeler adds a `permission_hierarchy` row `<consumer>:read → <master>:read` (always, idempotent) and `<consumer>:manage → <master>:manage` (if the spec's `promotion_decisions` says so).

---

## Gate A: pre-write planned-state integrity check (fires here, in Stage 3)

**Gate A: pre-write planned-state integrity check.** Fires in Stage 3, before any Stage 4 writes. Build the full intended end-state object graph in memory and verify internal consistency:

- Every planned FK target exists or is being created in this run.
- Every role member is a real user.
- No circular permission hierarchy. (Load-bearing: today's design only adds rows shaped `<consumer>:read → <master>:read` and `<consumer>:manage → <master>:manage`, which can't cycle. But a future feature that adds inclusions in the other direction, e.g. `<master>:read → <consumer>:read`, could form a cycle. The check stays in place to catch that.)
- Every default-role slot in every module's scaffold has a planned role.
- Every cross-module inclusion has both parent and child planned or live.
- Every merged JSON entry has a `source_module` value.

If any check fails, surface as a 🛑 with the broken reference quoted. Catches design bugs before they touch the catalog.

> Gloss: a `merged JSON entry` and its `source_module` tag are defined in `references/stage-4-execute.md` (sub-stage 4e-merge). This gate only asserts the planned end-state graph carries a `source_module` value; it does not need the merge mechanics, which run later in Stage 4.

