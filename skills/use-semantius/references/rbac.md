# Semantius RBAC Reference

Role-based access control in Semantius flows: **Users → Roles → Permissions**, with optional permission inheritance through `permission_hierarchy`.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Permission** | Atomic capability, named `<module>:<action>` (e.g., `crm:read`, `crm:manage`) |
| **Bundle** | A permission that exists to include others through the hierarchy (e.g., `crm:manage`). Roles hold bundles; see *Per-entity permissions and bundles* |
| **Permission Hierarchy** | `manage` implicitly includes `read`, set up so users don't need both assigned separately; a row that would make a cycle is refused (`90210`), and so is a chain deeper than 11 levels (`90211`) |
| **Role** | Named bundle of permissions (e.g., `crm_viewer`, `crm_manager`) |
| **Role Permission** | M:N join: grants a permission to a role |
| **User Role** | M:N join: assigns a role to a user |
| **Entity gates** | `view_permission` gates reads of an entity (an entity with a `select_rule` uses the rule instead; see `select-rule.md`); `edit_permission` gates insert, update **and** delete together. There is no delete-permission column. To let only some users delete, close or approve a record, add a validation rule that tests `$mode` (or the changed field) and then an owner match or `has_permission`; see `jsonlogic.md` § *Detecting the operation* |

---

## Naming Convention

**Always use `<module>:<action>` format:**
- `crm:read`, read access to CRM entities
- `crm:manage`, full write access to CRM entities
- `leads:write`, specific write-only on leads
- `service_catalog:read`

Don't invent free-form names like `"can_edit"`; scope every permission to a module. A bare `admin` is also a valid name (it is the default `edit_permission`).

**The prefix names the module that owns the capability, which may not be installed yet.** `ats-candidate-crm:write_candidates` is a valid permission in a tenant that only has `hiring-starter`. The platform checks only the shape of the name: a permission's prefix does not have to match its `module_id`, a hierarchy row can cross modules, and `has_permission` compares names without looking at modules.

`permissions.module_id` says which module **holds** the row, which is not always the module the prefix names. A row is held by the module the prefix names once that module is installed, otherwise by the module where the entity lives, otherwise by the first module that needed it. Deleting the holding module deletes the row, its grants and its hierarchy rows, and is refused while an entity still names the permission. So `module_id=eq.<id>` does not list every permission a module uses: follow its hierarchy rows too.

---

## Per-entity permissions and bundles

A module deployed from a spec names each entity's permissions after the catalog, never after what is installed, and holds them through bundles:

| Permission | Name | Prefix |
|---|---|---|
| Entity read | `<owner>:read_<entity>` | The entity's master |
| Entity write | `<owner>:write_<entity>` | The entity's master |
| Workflow gate | `<owner>:<verb>` | The module that realizes the state, if the catalog names one; otherwise the entity's master |
| Override (`view_all_`, `manage_all_`, `submit_`, `bypass_submit_lock`) | `<owner>:<verb>` | The entity's master |
| Bundle (`read`, `manage`, `admin`, a narrow tier such as `interview`, and a role that takes gates such as `hiring_manager`) | `<unit>:<tier>` | The module that declares it |

An entity's `view_permission` and `edit_permission` point at its own read and write permissions, and never change. Roles hold bundles, and the bundles include the entity permissions through `permission_hierarchy`:

| Permission | Includes |
|---|---|
| `<unit>:read` | `read_<entity>` for every entity the module provisions, consumes or contributes to |
| `<unit>:manage` | `<unit>:read`, and `write_<entity>` for each entity written at the `manage` tier |
| `<unit>:admin` | `<unit>:manage`, `write_<entity>` for each entity written at the `admin` tier, plus gates and overrides |
| Narrow tier | `write_<entity>` for the entities it covers. `<unit>:manage` includes it |
| Role that takes gates | `<unit>:manage` and each gate its role takes ("Roles that take gates" below) |
| `write_<entity>` | `read_<entity>`, because a write without read is unusable under row-level security |

For example, `hiring-starter` embeds `candidates`, whose master is `ats-candidate-crm`:

```
candidates.view_permission = ats-candidate-crm:read_candidates
candidates.edit_permission = ats-candidate-crm:write_candidates

ats-candidate-crm:write_candidates includes ats-candidate-crm:read_candidates
hiring-starter:read                includes ats-candidate-crm:read_candidates
hiring-starter:manage              includes ats-candidate-crm:write_candidates
hiring-starter:admin               includes ats-candidate-crm:hire_candidate
```

The names are the same in every install order: when `ats-candidate-crm` installs later, the rows move to it, and nothing is renamed. A holder of `hiring-starter:manage` can write `candidates` and nothing else in the CRM module. Another module's access to one entity is one hierarchy row to that entity's permission, not a row to the owner's `read` or `manage`.

`access_scope: custom` keeps hand-made permissions and has no per-entity rows. A module created with `module-rbac-setup.ts` (a build, or `semantius-importer`) uses module-wide permissions as its entities' `view_permission` and `edit_permission`, as `crm:read` and `crm:manage` do below: both shapes are valid on the platform.

---

## Choosing an entity's permissions

An entity's `view_permission` and `edit_permission` follow from its class (`data-modeling.md` → "Classifying an entity"). The class gives the **write tier**, the permission level that gates INSERT, UPDATE and DELETE. Choose the class first, then take the permissions from this section, and send all three in the `create_entity` payload.

| Write tier | Entities | Hand-built module (module-wide) | Spec-deployed module (per entity) |
|---|---|---|---|
| `:read` | `computed` | `view_permission = <slug>:read`; omit `edit_permission` (it defaults to `admin`) | `view_permission = <owner>:read_<entity>`; omit `edit_permission` |
| `:manage` | `operational_record`, `operational_workflow`, `junction` | `view_permission = <slug>:read`, `edit_permission = <slug>:manage` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:manage` |
| `:admin` | `catalog`; a `junction` whose parent legs are all `catalog` | `view_permission = <slug>:read`, `edit_permission = <slug>:admin` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:admin` |

- **Hand-built modules** (created with `module-rbac-setup.ts`) have three module-wide permissions, `<slug>:read`, `<slug>:manage` and `<slug>:admin`, plus a permission per gate and a bundle per role that takes gates, and `access_scope: advanced`, or `gated` when the module has a gate (see "Restricted steps (gates)" below). `basic` has no admin level, so a module with a `catalog` entity is never `basic`. The entity's `edit_permission` must already exist when `create_entity` runs.
- **Modules deployed from a spec** keep the per-entity permissions above, derived from the same tier; the bundle table above lists what each bundle includes.
- **A `junction`** follows its parent legs: `:manage`, or `:admin` only when every leg is a `catalog` entity.
- **Entities with a restricted step** (`operational_workflow`) stay at `:manage`; the restriction is a gate, see "Restricted steps (gates)" below. A narrow tier (an external participant who writes one entity without `<slug>:manage`) exists only in the per-entity shape.
- **Direct creation acts as the master** of every entity it creates: it writes the entity's own read and write permissions and nothing for entities another module masters, except view access to an entity it reuses ("Viewing an entity of another module" below).
- **After a reclassification** (`update_entity` on `entity_type`), update the entity's `edit_permission` to the new tier in the same call (see "Update entity-level permission gates" below).

### Viewing an entity of another module

A module that reuses another module's entity gets view access to that entity and nothing more: never its `edit_permission`, and never the other module's whole `read` permission. Read the entity's `view_permission`, then which entities use it (`read_entity '{"filters": "view_permission=eq.<permission>", "select": "table_name"}'`):

| The entity's `view_permission` | What to write |
|---|---|
| `public:read` or `user:read` | Nothing: it is a platform-level permission |
| Used by this entity alone, and not the owner's `<owner>:read` | One hierarchy row: `<slug>:read` includes it |
| The owner's `<owner>:read`, or shared with other entities | Give the entity its own, in the order below, so no existing user loses access |

```bash
# 1. The entity's own view permission, in the owner's module
semantius call crud create_permission '{"data": {"permission_name": "procurement:read_vendors", "description": "View vendors", "module_id": <owner_module_id>}}'
# 2. The shared permission keeps its access through it; the reusing module gets it too
semantius call crud create_permission_hierarchy '{"data": [
  {"including_permission_name": "procurement:read", "included_permission_name": "procurement:read_vendors"},
  {"including_permission_name": "spend:read", "included_permission_name": "procurement:read_vendors"}
]}'
# 3. Find the rollups that would block step 4, and set include_hidden_rows on each
semantius call crud read_field '{"filters": "ctype=eq.rollup", "select": "id,title,rollup"}'
semantius call crud update_field '{"id": "<rollup id>", "data": {"rollup": {<its whole definition>, "include_hidden_rows": true}}}'
# 4. Only now point the entity at it
semantius call crud update_entity '{"table_name": "vendors", "data": {"view_permission": "procurement:read_vendors"}}'
```

Step 3 applies to each rollup whose `id` or `rollup.link_field` starts with `<entity>.` (here `vendors.`) and whose `rollup` does not have `include_hidden_rows: true`, one `update_field` call each; with none, skip it. Without it, step 4 fails with `90269`. Do not ask first: the entity's readers see the total, and the records behind it stay hidden. Name each such rollup in the final response.

The entity list the user confirms says when a reused entity gets its own view permission (`build-module.md` → "Confirm the entity list").

### Restricted steps (gates)

A **gate** is a step that only some users may take: the move into a state that a role other than the module's Manager role (`<slug with - as _>_manager`, the holder of `<slug>:manage`, who does the everyday work) usually takes. To find the gates, list each state with the role that usually moves a record into it, taken from how the leading products split the work (`build-module.md` → "Model it like the leading products"). Then:

- A state another role usually moves records into is a gate for that role.
- A step the request restricts ("only team leads close tickets") is a gate for the role it names.
- A record only some roles may create is a gate for those roles.
- A module where one role does all the work has no gate.
- `approved`, `signed`, `issued`, `released`, `posted`, `committed`, `hired`, and `void` or `terminated` on a financial or contractual record are where the role usually changes. They are examples, not the test: the test is who takes the step.

A gate is the move into one state, its to-state. An entity with a gate is an `operational_workflow`. Its `edit_permission` stays at its write tier (`<slug>:manage`), because everyone who edits the record still needs it; the gate is a separate permission plus a validation rule. A step that every holder of `<slug>:manage` may take is not a gate.

| Module situation | `access_scope` | Who takes a gated step |
|---|---|---|
| No gate | `advanced` | Nothing to enforce |
| One or more gates, no RACI matrix | `gated` | The role that takes the step, through its bundle ("Roles that take gates" below), and the admin role: `<slug>:admin` includes every gate |
| The module is already `raci` | stays `raci` | The module's RACI matrix: see "A gate in a `raci` module" below |

To add a gate to a module:

1. **Name it** `<slug>:<verb>_<noun>`: the verb names the step and the noun is the singular record (`spend:approve_purchase_request`, `spend:sign_contract`, `spend:release_budget`, `spend:post_invoice`, `spend:terminate_contract`, `spend:void_invoice`, `spend:open_period`, `spend:issue_purchase_order`). `create_permission` it after a `read_permission`.
2. **Hold it through bundles:** `create_permission_hierarchy` with `<slug>:admin` including the gate, and the bundle of each role that takes the step including it ("Roles that take gates" below). Roles hold bundles, never the gate itself.
3. **Set the access level:** `update_module` with `access_scope: gated`, unless it is already `raci`.
4. **Enforce it with a validation rule on the entity** (`validation_rules` on `create_entity` or `update_entity`), checked with `has_permission` so the rule's own `code` and `message` surface; the message names who may take the step ("Only a Buyer can order a purchase request"). A transition into a state, for a gate without controls:

   ```json
   {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "ordered"]}]},
     {"has_permission": "spend:order_purchase_request"},
     true]}
   ```

   A gate with controls (every approval gate, and a gate with a named person) puts the gate's check in place of `has_permission` ("Controls on a gate" below, with complete rules). A restricted create tests `$old` for `null` instead: `{"if": [{"==": [{"var": "$old"}, null]}, {"has_permission": "<gate>"}, true]}`. Operators and the rule shape (`code`, `name`, `message`, `jsonlogic`) are in `jsonlogic.md`.
5. **Stop a skip past the gate.** The states after the gate are the states a record reaches only after it was in the gated state (`received` and `closed` after `issued`; `ordered` after `approved`; `active`, `expired` and `terminated` after `signed`). When there are any, add a second validation rule with two lists: the states after the gate, and the gated state together with those states. A record enters a state of the first list only when its old state is in the second list, or when the user passes the gate's check, because a skip takes the step. A record created straight into a later state passes only with the gate's check, which on an approval gate means only an admin (imports and seed rows). The message names the step that cannot be skipped ("A purchase order must be issued before it is received"):

   ```json
   {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"in": [{"var": "workflow_state"}, ["received", "closed"]]}]},
     {"or": [{"in": [{"var": "$old.workflow_state"}, ["issued", "received", "closed"]]}, {"has_permission": "spend:issue_purchase_order"}]},
     true]}
   ```

   The `has_permission` branch is the gate's check, here for a gate without controls; an approval gate puts its whole check there ("Controls on a gate"), so a requester cannot skip past their own approval. A state the record can also reach without the gate (`rejected` beside `approved`, `canceled` before signing) is not in the lists. A state after the gate stays in the lists when it has a gate of its own (`terminated` after `signed`, `ordered` after `approved`): its own gate rule still decides who takes it.
6. **Name the gate in the summary:** the step and the roles that take it. When the user names another role for it, that role takes it through its bundle: add the hierarchy row to the bundle of a role the module has, or create the role as below. Naming the module's Manager role means every editor may take the step, so it is not a gate: drop it. Once it exists, drop it in this order: its gate rule, its sequence rule and its controls (below) first, then its permission and its hierarchy rows. When a role takes no other gate, move its users to the Manager role after the user agrees, then delete its grant, the role, its bundle and the bundle's hierarchy rows. The entity becomes `operational_record` when it has no gate left, and the module `advanced` when it has none.

Create the gate permission before the rule that names it: a `has_permission` argument must exist. The direct path marks no gate as high risk, so every gate it creates is included in `<slug>:admin`.

#### Roles that take gates

A role beyond the module's viewer, manager and admin exists to take gated steps: a Hiring Manager who approves offers, an Approver who approves purchase requests, a Buyer who issues orders. It does the everyday work too, so its bundle includes `<slug>:manage`. One role can take several gates, and two roles can take the same gate. Create all of them together, one call per kind:

1. **The bundle** `<slug>:<role_key>`, with `role_key` in snake_case (`recruiting:hiring_manager`), described by the steps it adds ("Manage Recruiting data and approve offers"), with `module_id`. It goes in the same `create_permission` as the gates.
2. **Its hierarchy rows:** the bundle includes `<slug>:manage` and each gate the role takes, in the same `create_permission_hierarchy` as the `<slug>:admin` rows.
3. **The role:** `role_name` "<Module Name> <Role Title>" ("Recruiting Hiring Manager"), `slug` `<module slug with - as _>_<role_key>`, and `module_id`, in one `create_role`.
4. **Its grant:** the role holds its bundle, in one `create_role_permission`. The role ids come from one `read_role` filtered by `slug`, never from the create response.

In the per-entity shape the bundle is `<unit>:<role_key>` and includes `<unit>:manage`. The module's default roles stay viewer, manager and admin. A user who takes a gated step is given the role for it.

#### The access line

A build's entity list and final response, and a review's access section, describe a module's access the same way, in plain words: its access level; what each role of the module can do (viewer, manager, admin, and each role that takes gates, with its steps); the entities only an admin can change; each gated step with who takes it, any named person and an approval gate's controls; and, when an entity has a lifecycle and no step is gated, "No step is gated: anyone who can edit a record can move it through every state."

#### Controls on a gate

Purchasing, finance and hiring products guard a step with more than a permission. Which controls a gate gets:

| Control | Goes with |
|---|---|
| 1. The requester may not approve | Every approval gate |
| 2. Lock while waiting and after approval | Every approval gate |
| 3. Approved stays approved | Every approval gate |
| 4. A named person | A gate the leading products assign to one person per record (the request's approver, the job opening's hiring manager) |
| 5. Named people see only their records | A named person whose role the leading products limit to its own records (hiring managers see only their own job openings). Not purchasing approvers, who see every request |

An **approval gate** is a gate into `approved`, `signed`, `posted`, `released` or `verified`: a step where one person authorizes what someone else prepared. `issued`, `ordered`, `hired`, `committed`, `void` and `terminated` are gates but not approval gates. The **waiting state** is the state a record sits in until the approval (`submitted`, `pending`, `in_review`). An approval gate also decides the rejection: the move from the waiting state into `rejected` takes the same check, with no permission of its own.

**The gate's check.** Every rule of a gate uses one check, so skipping the step, undoing it or changing what it covered takes the same check as the step itself. It has two parts:

- **Who may take it:** an admin, or a holder of the gate who, when the record names a person, is that person. Without a named person it is `{"has_permission": "<gate>"}`. With one:

  ```json
  {"or": [{"has_permission": "spend:admin"},
    {"and": [{"has_permission": "spend:approve_purchase_request"},
      {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]}
  ```

  The named person needs the gate too, so naming yourself or a colleague without it opens no way past the gate. A system write has no user (`$user_id` is null), so it never counts as the named person.
- **Not the requester,** on an approval gate only. A record created straight into the gated state or a state after it is an import or a seed, which only an admin may do. On any other write, the user who created the record may not take the step, admins included:

  ```json
  {"if": [{"==": [{"var": "$mode"}, "insert"]},
    {"has_permission": "spend:admin"},
    {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}
  ```

The check is who may take it; on an approval gate it is `{"and": [<who may take it>, <not the requester>]}`. In a `living` `raci` module, who may take it also admits `{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}` in its `or`.

**When the person is on a parent.** When the products keep the named person on a parent (the hiring manager on the job opening, the gate on the application), the rule reads the parent with `set_record` and uses `<binding>.<role_key>_user_id` in place of `$old.<role_key>_user_id`, where `<binding>` is the name `set_record` gives the parent (`job_opening`). Two levels up (an offer of an application of a job opening), nest one `set_record` in the other (`jsonlogic.md` → "Canonical patterns", Pattern 6). A parent the user cannot read binds as `null`, and then only an admin passes: `{"if": [{"==": [{"var": "job_opening"}, null]}, {"has_permission": "recruiting:admin"}, <the check>]}`.

1. **The requester may not approve.** Add `requested_by_user_id` (`reference` to `users`, `reference_delete_mode: clear`, title "Requested By") and stamp it on insert in `computed_fields`:

   ```json
   {"name": "requested_by_user_id", "jsonlogic": {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"var": "$user_id"}, {"var": "$old.requested_by_user_id"}]}}
   ```

   A seed run creates every row as one user, so this column is the same on every seeded row (`seed-data.md` → "Computed and rollup columns"), and the user who seeded cannot approve a sample record: say so in the seed report. The stamp keeps its value when the platform clears it, so a user who requested records may not be deletable: set the user's `is_disabled` instead.
2. **Lock while waiting and after approval.** The lock states are the waiting state, the gated state and the states after the gate (step 5). In a lock state, only an admin or someone who passes the gate's check may delete the record or change the fields the approval covers: the fields people type (amounts, quantities, prices, the counterparty, the dates of the request) and the named person's field. Never lock a rollup or a computed field (the lock on the lines covers a rollup total), nor a field a later step fills (a PO number, an order date, a received quantity). A record in the waiting state goes back to the state before it (`draft`) without a check, which ends the lock; to change it, move it back and submit it again.

   Lines the approval covers (purchase request lines, invoice lines) get the lock on the child entity. It fires when a line is added or deleted, moved to another parent, or a field people type on it changes (a quantity, a unit price; not a received quantity), and it reads each parent with `set_record`. It admits an admin, or someone who passes the gate's check read from the parent (`request.approver_user_id`, `request.requested_by_user_id`). A parent that reads as `null` on a delete is being deleted itself, which its own lock already checked; otherwise a `null` parent admits only an admin.
3. **Approved stays approved.** A move out of the gated state or a state after it, to a state outside the second list of step 5 (`approved` or `ordered` back to `draft` or to `rejected`), takes the gate's check. Moving a waiting record back is the only move back without a check.
4. **A named person.** Add `<role_key>_user_id` (`reference` to `users`, `reference_delete_mode: clear`) to the record, or to the parent where the products keep it, and use it in who may take the step (above). Control 2 locks it from the waiting state on.
5. **Named people see only their records.** A holder of the role (`<slug>:<role_key>`) sees only the records they are named on and the records nobody is named on; everyone else who holds the entity's `view_permission` sees every record. It is a `select_rule` (`select-rule.md`) on the entity that holds the field, and on each entity below it, which shows a record to a holder of the role when its parent is visible to them:

   ```json
   {"and": [{"has_permission": "recruiting:read"}, {"or": [
     {"!": [{"has_permission": "recruiting:hiring_manager"}]},
     {"has_permission": "recruiting:admin"},
     {"==": [{"var": "hiring_manager_user_id"}, {"var": "$user_id"}]},
     {"==": [{"var": "hiring_manager_user_id"}, null]}]}]}
   ```

   ```json
   {"and": [{"has_permission": "recruiting:read"}, {"or": [
     {"!": [{"has_permission": "recruiting:hiring_manager"}]},
     {"has_permission": "recruiting:admin"},
     {"set_record": ["job_opening", "job_openings", {"var": "job_opening_id"}, {"!=": [{"var": "job_opening"}, null]}]}]}]}
   ```

   - `recruiting:read` stands for the entity's `view_permission`.
   - When the entity has `requested_by_user_id`, add `{"==": [{"var": "requested_by_user_id"}, {"var": "$user_id"}]}` to the `or`, so a holder of the role still sees what they requested.
   - Each other bundle of the module whose holders must see every record gets its own `{"has_permission": "<slug>:<role_key>"}` in the `or`. Without one, holding the narrowed role narrows what a person sees even when they hold another role, so a person who must see every record and also take the step gets the admin role.
   - The rule also limits which records the role's holders may change, but not which they may create.
   - Reading the parent with `set_record` here is the case `select-rule.md` → "Performance note" reserves it for: one parent row by its id, in a module with light read traffic.
   - A rollup over an entity with this rule needs `include_hidden_rows: true` (`rollup-fields.md` → "Hidden child rows").

**Complete rules for a purchase request.** Its states are `draft`, `submitted`, `approved`, `rejected` and `ordered`. An Approver approves or rejects it, and a Buyer orders it. The products name an approver per request (`approver_user_id`). `total_amount` is a rollup of the lines, and `po_number` is filled when the request is ordered. The `validation_rules` of `purchase_requests`:

```json
[
  {"code": "99001", "name": "approve_purchase_request",
   "message": "Only the named approver, or an Approver when none is named, can approve a purchase request, and never the person who requested it.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "approved"]}]},
     {"and": [
       {"or": [{"has_permission": "spend:admin"},
         {"and": [{"has_permission": "spend:approve_purchase_request"},
           {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]},
       {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"has_permission": "spend:admin"}, {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}},
  {"code": "99002", "name": "reject_purchase_request",
   "message": "Only the named approver, or an Approver when none is named, can reject a submitted purchase request, and never the person who requested it.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "rejected"]}, {"==": [{"var": "$old.workflow_state"}, "submitted"]}]},
     {"and": [
       {"or": [{"has_permission": "spend:admin"},
         {"and": [{"has_permission": "spend:approve_purchase_request"},
           {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]},
       {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"has_permission": "spend:admin"}, {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}},
  {"code": "99003", "name": "order_purchase_request",
   "message": "Only a Buyer can order a purchase request.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "ordered"]}]},
     {"has_permission": "spend:order_purchase_request"},
     true]}},
  {"code": "99004", "name": "approve_before_order",
   "message": "A purchase request must be approved before it is ordered.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "ordered"]}]},
     {"or": [
       {"in": [{"var": "$old.workflow_state"}, ["approved", "ordered"]]},
       {"and": [
         {"or": [{"has_permission": "spend:admin"},
           {"and": [{"has_permission": "spend:approve_purchase_request"},
             {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]},
         {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"has_permission": "spend:admin"}, {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]}]},
     true]}},
  {"code": "99005", "name": "approved_stays_approved",
   "message": "Only the approver can move an approved or ordered purchase request back.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"},
       {"in": [{"var": "$old.workflow_state"}, ["approved", "ordered"]]},
       {"!": [{"in": [{"var": "workflow_state"}, ["approved", "ordered"]]}]}]},
     {"and": [
       {"or": [{"has_permission": "spend:admin"},
         {"and": [{"has_permission": "spend:approve_purchase_request"},
           {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]},
       {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"has_permission": "spend:admin"}, {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}},
  {"code": "99006", "name": "lock_submitted_purchase_request",
   "message": "Only its approver or an admin can change or delete a submitted, approved or ordered purchase request; move a submitted one back to draft to change it.",
   "jsonlogic": {"if": [
     {"and": [
       {"in": [{"var": "$old.workflow_state"}, ["submitted", "approved", "ordered"]]},
       {"or": [{"==": [{"var": "$mode"}, "delete"]}, {"value_changed": "supplier_id"}, {"value_changed": "needed_by_date"}, {"value_changed": "approver_user_id"}]}]},
     {"or": [{"has_permission": "spend:admin"},
       {"and": [
         {"and": [{"has_permission": "spend:approve_purchase_request"},
           {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]},
         {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}}
]
```

The `validation_rules` of `purchase_request_lines`:

```json
[
  {"code": "99007", "name": "lock_lines_of_submitted_request",
   "message": "Only the request's approver or an admin can change the lines of a submitted, approved or ordered purchase request.",
   "jsonlogic": {"and": [
     {"if": [
       {"or": [{"==": [{"var": "$mode"}, "insert"]}, {"==": [{"var": "$mode"}, "delete"]},
         {"value_changed": "purchase_request_id"}, {"value_changed": "quantity"}, {"value_changed": "unit_price"}]},
       {"set_record": ["request", "purchase_requests", {"var": "purchase_request_id"},
         {"if": [{"==": [{"var": "request"}, null]},
           {"or": [{"==": [{"var": "$mode"}, "delete"]}, {"has_permission": "spend:admin"}]},
           {"if": [{"in": [{"var": "request.workflow_state"}, ["submitted", "approved", "ordered"]]},
             {"or": [{"has_permission": "spend:admin"},
               {"and": [{"has_permission": "spend:approve_purchase_request"},
                 {"or": [{"==": [{"var": "request.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "request.approver_user_id"}]}]},
                 {"!=": [{"var": "request.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
             true]}]}]},
       true]},
     {"if": [{"and": [{"==": [{"var": "$mode"}, "update"]}, {"value_changed": "purchase_request_id"}]},
       {"set_record": ["old_request", "purchase_requests", {"var": "$old.purchase_request_id"},
         {"if": [{"==": [{"var": "old_request"}, null]},
           {"has_permission": "spend:admin"},
           {"if": [{"in": [{"var": "old_request.workflow_state"}, ["submitted", "approved", "ordered"]]},
             {"or": [{"has_permission": "spend:admin"},
               {"and": [{"has_permission": "spend:approve_purchase_request"},
                 {"or": [{"==": [{"var": "old_request.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "old_request.approver_user_id"}]}]},
                 {"!=": [{"var": "old_request.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
             true]}]}]},
       true]}]}}
]
```

**A step whose named person sits on the parent** (not an approval, so no requester part):

```json
{"code": "99008", "name": "hire_application",
 "message": "Only the job opening's hiring manager, or a Hiring Manager when none is named, can hire.",
 "jsonlogic": {"if": [
   {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "hired"]}]},
   {"set_record": ["job_opening", "job_openings", {"var": "job_opening_id"},
     {"if": [{"==": [{"var": "job_opening"}, null]},
       {"has_permission": "recruiting:admin"},
       {"or": [{"has_permission": "recruiting:admin"},
         {"and": [{"has_permission": "recruiting:hire_application"},
           {"or": [{"==": [{"var": "job_opening.hiring_manager_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "job_opening.hiring_manager_user_id"}]}]}]}]}]}]},
   true]}}
```

#### A gate in a `raci` module

The matrix is platform data: `processes`, `raci_assignments` and `process_gates` are ordinary entities, read and written with `postgrestRequest`. A new gate joins it like this:

1. **Read the mode.** `living` when the instance has any `processes` row or the module's `settings.raci_mode` is `living`; otherwise `documentation`.
2. **Ask once** which role is Accountable for the new step. Name the step in plain words and offer the module's existing roles. If the user cannot name one, include the gate only in `<slug>:admin`, with no role bundle, and say so in the summary.
3. **Create the gate permission** and its `<slug>:admin` hierarchy row, exactly as in steps 1 and 2 above; no role bundle includes it.
4. **Write the matrix for the mode.**
   - `living`: insert a `processes` row (`name`, `module_id`, `process_key` `<verb>_<noun>`); a `raci_assignments` row (`process_id`, `role_id` of the Accountable role, `raci: accountable`); and a `process_gates` row (`process_id`, `entity`, `gate_kind` `approval` for an approval gate ("Controls on a gate"), `create` for a restricted create, otherwise `transition`; `to_state`; `state_column` the name of the entity's state field, since the default is `status`). The Accountable role is not granted the gate: the rule resolves it live.
   - `documentation`: nothing is stored. Grant the gate permission to the Accountable role with `create_role_permission`.
5. **Write the rule for the mode.** `living`: the same rule as above with the permission check widened to `{"or": [{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}, {"has_permission": "<gate>"}]}`. `documentation`: `{"has_permission": "<gate>"}` as in step 4 above.

The Accountable role still needs the entity's write tier (`<slug>:manage`) to change the record at all; the gate only decides who may take the step.

---

## Adding permissions and roles to an existing module

A new module, or one that has none of this yet, never uses these calls for its viewer, manager and admin access; its gates and the roles that take them are created as "Restricted steps (gates)" says. Run the script instead (`data-modeling.md` → "Mandatory Creation Order", steps 1 to 5):

```bash
bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug>
```

The calls below add to a module that already has its setup. The one exception is a script run that ends in exit 3 because the platform keeps refusing a write: tell the user, then finish the setup with these calls (`create_module` first when the module does not exist yet). Every step below writes a **set** of records of one kind, so each is **one** call with an array in `data` (Golden Rule 7): both permissions in one `create_permission`, both roles in one `create_role`, both grants in one `create_role_permission`. Duplicate-check each set with one `read_*` using an `in.(...)` filter first (`read_permission '{"filters": "permission_name=in.(crm:read,crm:manage,crm:admin)"}'`). A permission is keyed by its `permission_name`, so every reference to it (hierarchy relationships, grants, module wiring) writes the name directly; only roles and users carry a numeric `id`, and those ids come from that read, never from the create response.

### 1. Create Permissions

```bash
# Several permissions — in ONE call
semantius call crud create_permission '{
  "data": [
    {
      "permission_name": "crm:read",
      "description": "Read CRM data",
      "module_id": 3
    },
    {
      "permission_name": "crm:manage",
      "description": "Create, update, and delete CRM data",
      "module_id": 3
    },
    {
      "permission_name": "crm:admin",
      "description": "Maintain CRM settings and reference data, and take every gated step",
      "module_id": 3
    }
  ]
}'
```

### 2. Set Up Permission Hierarchy (recommended)

Make `crm:admin` include `crm:manage` and `crm:manage` include `crm:read`, so assigning `admin` is sufficient (both relationships go in one call):

```bash
semantius call crud create_permission_hierarchy '{
  "data": [
    {"including_permission_name": "crm:manage", "included_permission_name": "crm:read"},
    {"including_permission_name": "crm:admin", "included_permission_name": "crm:manage"}
  ]
}'
```

### 3. Create Roles

The role fields are **`role_name`** (the human display name) and **`slug`** (snake_case handle, `^[a-z0-9_]+$` — **underscores only, NO hyphens**, unlike a `module_slug`, which DOES allow hyphens; the two formats differ, so when you build a role slug from a hyphenated module slug you must convert `-`→`_`, e.g. module `hvac-svc-mgmt` → role `hvac_svc_mgmt_viewer`, never `hvac-svc-mgmt_viewer`. A hyphen in the slug fails the regex. Derived from `role_name` if omitted: every run of characters outside `a-z`, `A-Z` and `0-9` becomes one `_`, leading and trailing `_` are removed, then it is lowercased; a name with no ASCII letter or digit derives an empty slug, and a second such role collides. Pass it explicitly so the handle is deploy-controlled and not left to the derivation). There is **no `name` and no `label` field** — those are a common mistake. For a role that belongs to a module you MUST also pass **`module_id`**, the owning module. Omit it and the role is an **orphan**: it exists but is invisible in the module's governance panel and not related to the module record's `default_*_role_id`.

**`origin`** records who provisioned a role or hierarchy relationship, and it cannot change after creation. Leave it unset when you create RBAC by hand; it defaults to `"user"`. `"model"` and `"model_master"` are set only by a spec deploy (a domain module and a master module respectively), and `"system"` only by the platform. `origin` is set on INSERT; a change is refused (`90203` on a role, `90205` on a `permission_hierarchy` row). The `system` roles are the platform built-ins seeded at database init (e.g. `Administrator`, `User`); the `slug` of a `system` role cannot be changed (`90204`), while roles of any other origin can be renamed.

**Module columns.** A module carries `module_type` (`"domain"`, the default, or `"master"` for a module promoted for sharing; its `input_type` is `readonly`, which the database does not enforce), `manage_permission` and `admin_permission` (the names of the module's manage and admin permissions), and `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` (the module's default roles). The last five are ordinary fields set with `create_module` or `update_module`; they are foreign keys, so the permissions and roles they name must already exist.

```bash
# Several roles — in ONE call
semantius call crud create_role '{
  "data": [
    {
      "role_name": "CRM Viewer",
      "slug": "crm_viewer",
      "description": "Can view CRM data",
      "module_id": 3
    },
    {
      "role_name": "CRM Manager",
      "slug": "crm_manager",
      "description": "Can manage all CRM data",
      "module_id": 3
    },
    {
      "role_name": "CRM Admin",
      "slug": "crm_admin",
      "description": "Can maintain CRM settings and reference data, and take every gated step",
      "module_id": 3
    }
  ]
}'
```

### 4. Grant Permissions to Roles

```bash
# crm:read → crm_viewer, crm:manage → crm_manager, crm:admin → crm_admin (each inherits the lower levels via hierarchy) — in ONE call
semantius call crud create_role_permission '{
  "data": [
    {
      "role_id": <crm_viewer id>,
      "permission_name": "crm:read"
    },
    {
      "role_id": <crm_manager id>,
      "permission_name": "crm:manage"
    },
    {
      "role_id": <crm_admin id>,
      "permission_name": "crm:admin"
    }
  ]
}'
```

The three role ids come from one `read_role` with `"filters": "slug=in.(crm_viewer,crm_manager,crm_admin)"`, matched by `slug`, never by the position of a row in the `create_role` response.

The built-in `Administrator` role already holds every permission of a new module, granted by the platform, so grant only to the module's own roles.

### 5. Assign Roles to Users

```bash
# Find the user first
semantius call crud read_user '{"filters": "email=eq.alice@example.com"}'

# Assign role
semantius call crud create_user_role '{
  "data": {
    "user_id": <user id>,
    "role_id": <crm_manager id>
  }
}'
```

---

## Checking Existing RBAC State

```bash
# All permissions
semantius call crud read_permission '{}'

# Permissions for a specific module
semantius call crud read_permission '{"filters": "permission_name=ilike.crm:*"}'

# All roles
semantius call crud read_role '{}'

# What permissions does a role have?
semantius call crud read_role_permission '{"filters": "role_id=eq.<id>"}'

# What roles does a user have?
semantius call crud read_user_role '{"filters": "user_id=eq.<id>"}'

# Current user's full profile + effective permissions
semantius call crud getCurrentUser '{}'
```

---

## Diagnosing Access Issues

When a user gets "permission denied":

1. **Get their effective permissions:**
   ```bash
   semantius call crud getCurrentUser '{}'
   ```

2. **Check what the entity requires:**
   ```bash
   semantius call crud read_entity '{"filters": "table_name=eq.<table>"}'
   # Look at view_permission and edit_permission
   ```

3. **Trace the chain:**
   ```
   user → user_roles → roles → role_permissions → permissions
                                                ↓
                                    permission_hierarchy (inherited)
   ```

4. **Fix:** Grant the missing permission to one of the user's roles, or assign a role that already has it.

---

## Updating RBAC

### Add permissions to an existing role
```bash
# One permission
semantius call crud create_role_permission '{
  "data": {"role_id": 5, "permission_name": "crm:read"}
}'
# Several permissions (or several roles) — ONE call
semantius call crud create_role_permission '{
  "data": [{"role_id": 5, "permission_name": "crm:read"}, {"role_id": 5, "permission_name": "crm:export"}, {"role_id": 6, "permission_name": "crm:read"}]
}'
```

### Remove permissions from a role
```bash
# The id is "<role_id>.<permission_name>"; read first to confirm the grants exist
semantius call crud read_role_permission '{"filters": "role_id=eq.5&permission_name=in.(crm:read,crm:export)"}'
# Then delete by id — several ids in one call
semantius call crud delete_role_permission '{"id": ["5.crm:read", "5.crm:export"]}'
```

### Assign several users to a role (or several roles to a user) — one `create_user_role` call
```bash
semantius call crud create_user_role '{
  "data": [{"user_id": 17, "role_id": <crm_manager id>}, {"user_id": 18, "role_id": <crm_manager id>}]
}'
```

> ⚠️ Removing permissions from roles may revoke access for all users in that role. Check impact before proceeding.

### Update entity-level permission gates
```bash
semantius call crud update_entity '{
  "table_name": "products",
  "data": {
    "view_permission": "catalog:read",
    "edit_permission": "catalog:manage"
  }
}'
```

After `update_entity` on `entity_type`, set `edit_permission` to the new write tier in the same call (see "Choosing an entity's permissions" above).

`edit_permission` covers insert, update and delete alike. A gate on one operation (only some roles may delete) is a validation rule on the entity, not a third permission column; see `jsonlogic.md` § *Detecting the operation*.
