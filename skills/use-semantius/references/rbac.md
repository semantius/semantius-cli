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
| Bundle (`read`, `manage`, `admin`, a role that does part of the work such as `requester`, and a role that takes gates such as `hiring_manager`) | `<unit>:<tier>` | The module that declares it |

An entity's `view_permission` and `edit_permission` point at its own read and write permissions, and never change. Roles hold bundles, and the bundles include the entity permissions through `permission_hierarchy`:

| Permission | Includes |
|---|---|
| `<unit>:read` | `read_<entity>` for every entity the module provisions, consumes or contributes to |
| `<unit>:manage` | `<unit>:read`, and `write_<entity>` for each entity written at the `manage` tier |
| `<unit>:admin` | `<unit>:manage`, `write_<entity>` for each entity written at the `admin` tier, plus gates and overrides |
| Role that does part of the work | `<unit>:read`, and `write_<entity>` for each entity it writes ("Roles that do part of the work" below). `<unit>:manage` includes each of those |
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

An entity's `view_permission` and `edit_permission` follow from its class (`data-modeling.md` → "Classifying an entity"). The class gives the **write tier**, the permission level that gates INSERT, UPDATE and DELETE. Choose the class first, then take the permissions from this section, and send all three in the `create_entity` payload. `writeModel` and `call-file.ts` refuse a payload whose `edit_permission` is `<slug>:read`, `<slug>:manage` or `<slug>:admin` but not the tier of its `entity_type` (a `catalog` at `:admin`, an `operational_record` or `operational_workflow` at `:manage`); a `junction`, a `computed` entity and a `<slug>:write_<entity>` are not checked.

| Write tier | Entities | Hand-built module (module-wide) | Spec-deployed module (per entity) |
|---|---|---|---|
| `:read` | `computed` | `view_permission = <slug>:read`; omit `edit_permission` (it defaults to `admin`) | `view_permission = <owner>:read_<entity>`; omit `edit_permission` |
| `:manage` | `operational_record`, `operational_workflow`, `junction` | `view_permission = <slug>:read`, `edit_permission = <slug>:manage` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:manage` |
| `:admin` | `catalog`; a `junction` whose related entities are all `catalog` | `view_permission = <slug>:read`, `edit_permission = <slug>:admin` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:admin` |

- **Hand-built modules** (created with `module-rbac-setup.ts`) have three module-wide permissions, `<slug>:read`, `<slug>:manage` and `<slug>:admin`, plus a permission per gate, a bundle per role that takes gates or does part of the work, and a write permission per entity such a role writes, and `access_scope: advanced`, or `gated` when the module has a gate (see "Restricted steps (gates)" below). `basic` has no admin level, so a module with a `catalog` entity is never `basic`. The entity's `edit_permission` must already exist when `create_entity` runs.
- **Modules deployed from a spec** keep the per-entity permissions above, derived from the same tier; the bundle table above lists what each bundle includes.
- **A `junction`** follows the entities it relates: `:manage`, or `:admin` only when every one of them is a `catalog` entity.
- **Entities with a restricted step** (`operational_workflow`) stay at `:manage`; the restriction is a gate, see "Restricted steps (gates)" below.
- **An entity a role that does part of the work writes** (a requester's tickets) takes `edit_permission = <slug>:write_<entity>` in place of `<slug>:manage`. `<slug>:manage` includes it, so the write tier is unchanged ("Roles that do part of the work" below). It is created with `<slug>:manage` like any other entity, because `<slug>:write_<entity>` does not exist yet: `module-rbac-setup.ts --access` creates that permission and switches the entity to it. `writeModel` and `call-file.ts` refuse a `create_entity` payload that names it.
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

#### The access record

Who does what is written down before any lifecycle exists, and the gates and roles are written from it by a script, never by hand. The record is `access.json` in `.tmp_deploy`: a build passes it to `writeModel` as `access` (`data-modeling.md` → "A payload with rules is built, not typed"), and a module that already has its entities writes it with `writeAccess(".tmp_deploy", access)` from `jsonlogic-kit.ts`. `writeModel` and `call-file.ts` refuse a `workflow_state` field whose states the record does not cover, so no lifecycle is created without the decision. It answers three questions from how the leading products split the work, each for every case, never from a default:

1. **Who does the everyday work?** `"everyday"`, a person in snake_case. That person holds the module's Manager role.
2. **Who else uses the module?** `"products"` names the leading products the module follows, and `"people"` lists every kind of person who uses them, as the products do (their user types and seats), each with who they are here: the everyday person, a key of `"roles"`, or `"outside"`. Each role has a `"title"`: a person who takes some steps ("Roles that take gates" below), or a person who does only part of the work ("Roles that do part of the work" below). A person who never signs in (a candidate, an outside customer) is `"outside"` and no role: the person who records what they did is. A kind of person of its own counts as the everyday person only with a `because`.
3. **Who moves a record into each state?** For each entity with a `workflow_state`, every one of its states with the person who changes the record into it in the leading products: `"everyday"`'s person, or a key of `"roles"`. A state another person moves records into is a gate for that person's role; the script applies this test, so the record only says who.

The record of a purchase request that an employee prepares, an Approver approves and a Buyer orders:

```json
{
  "products": ["Coupa", "SAP Ariba"],
  "people": { "employee": "employee", "approver": "approver", "buyer": "buyer", "supplier": "outside" },
  "everyday": "employee",
  "roles": {
    "approver": { "title": "Approver" },
    "buyer": { "title": "Buyer" }
  },
  "nobodyDoesPart": "every employee who uses it prepares requests, which is its everyday work",
  "entities": {
    "purchase_requests": {
      "states": {
        "draft": "employee",
        "submitted": "employee",
        "approved": { "by": "approver", "after": ["ordered"], "namedPerson": true, "filledLater": ["po_number"], "covers": ["purchase_request_lines"] },
        "rejected": "approver",
        "ordered": "buyer"
      }
    }
  }
}
```

A state is the person's key, or `{ "by": "<person>", … }` when the gate needs more. A gate that other states follow in the `workflow_state` order always needs more: `after` or `notAfter` places each of them.

The record of a purchase order that an employee prepares and a Buyer issues. The gate is not an approval, so it has no waiting state, and every state after `issued` is placed: `received` and `closed` are reached only once the order was issued, `canceled` also from a draft. `suppliers`, which has no `workflow_state`, has no entry in `entities`:

```json
{
  "products": ["Coupa", "SAP Ariba"],
  "people": { "employee": "employee", "buyer": "buyer", "supplier": "outside" },
  "everyday": "employee",
  "roles": {
    "buyer": { "title": "Buyer" }
  },
  "nobodyDoesPart": "every employee who uses it prepares orders, which is its everyday work",
  "entities": {
    "purchase_orders": {
      "states": {
        "draft": "employee",
        "issued": { "by": "buyer", "after": ["received", "closed"], "notAfter": ["canceled"] },
        "received": "employee",
        "closed": "employee",
        "canceled": "employee"
      }
    }
  }
}
```

`issued` names its step, so the gate is `spend:issue_purchase_order` and the record writes no `verb`. A state that does not name its step (`on_hold`, `in_review`) takes one: `{ "by": "<person>", "verb": "hold" }`.

| Key | Meaning |
|---|---|
| `by` | The person, or a list of people, who move a record into the state; `"admin"` when only an admin does |
| `verb` | Names the gate `<slug>:<verb>_<noun>` (step 1 below); derived from the state when it says the step (`approved` → `approve`, `hired` → `hire`), asked for otherwise |
| `after` | The states a record reaches only after this one (step 5 below) |
| `notAfter` | The states after this one in the `workflow_state` order that a record can also reach without it (step 5 below); no rule is written from them |
| `waiting` | An approval gate's waiting state ("Controls on a gate"); the state before the gated one when left out |
| `namedPerson` | The step's named person (control 6): `true` puts `<role_key>_user_id`, of the first person in `by`, on the record; `{ "via": "<relationship field>" }`, or a list of them, reads it from a parent; either form takes `"field"` to use an existing user field |
| `filledLater` | Fields a later step fills, which the locks leave out (control 3) |
| `covers` | The child entities whose rows an approval covers (control 3) |
| `because` | Why the everyday person takes a state where the role usually changes (below) |

The script refuses a record that leaves a decision open:

- **A state where the role usually changes** (`approved`, `signed`, `issued`, `released`, `posted`, `committed`, `hired`, `void` and `terminated`, `paid`, `reimbursed`, `disbursed`, `verified`) given to the everyday person needs `{ "by": "<everyday>", "because": "<who takes this step in the leading products, and why it is the everyday work here>" }`. These states are examples, not the test; the `because` is where the test is run.
- **Every state after a gate** in the `workflow_state` order is in that gate's `after` or `notAfter`, except an approval gate's own `rejected`, which its controls already decide. The order alone cannot tell the two apart, so each is a decision (step 5 below), and the refusal names each state left out.
- **Every user field that names a person** (a `reference` to `users`) is accounted for: a gate's `namedPerson`, a role's `limitedTo` field, a stamp the gates write, or an entry of `"userFields"`, `{ "<table>.<field>": "<person>" }`, saying whom the field names, not who fills it in. A field named for a kind of person (`interviewer_user_id`, `hiring_manager_user_id`) names that person, so it goes to that person's role; a role that does part of the work is limited by it (`limitedTo`). A field that says what someone did or holds (`created_by_user_id`, `assigned_user_id`, `owner_user_id`) may name the everyday person, with `{ "by": "<everyday>", "because": "…" }`.
- **Who else uses the module** is always answered: `"roles"` names each other kind of person, or is empty with `"onlyEveryday": "<why nobody else uses it in the leading products>"`. When no role does part of the work, `"nobodyDoesPart": "<why>"` says why nobody uses the module only to write their own records (a requester, a technician, an employee, an interviewer).
- **A field named for a kind of person** goes to the role of that name: `interviewer_user_id` to `"interviewer"`, never to another role.
- **A lifecycle under another name**: an enum named `status`, `state` or `stage`, or `<a word of its entity's name>_status`, `_state` or `_stage` (`job_status` on job openings), is refused, and so is a label column with such a name; the lifecycle is `workflow_state`.
- **A role that does part of the work** says what the products let it see and fill in: `"sees"` (the entities it sees besides what it writes; every other entity of the module is hidden from it) and `"fills"` (`{ "<table>": ["<field>", …] }`, the fields it fills in on each entity it writes; every other field it could enter stays with the everyday workers). A record may say `"hidden"` and `"leaves"` instead, as the requester below does; an empty one is no answer, and `"sees"` and `"fills"` are asked for.

`call-file.ts` runs the same check on every `create_field` payload with a lifecycle or a user field, so a payload written without `writeModel` meets the same refusals.

An entity may also have `"create": ["<role>"]`: a record only those roles create. A state an approval gate's rejection enters (`rejected`), given to the approval's own people, is no gate of its own: its move from the waiting state takes the gate's check (control 2). A role that takes gates adds `"seesOnlyNamed": true` when the products limit it to the records it is named on (control 7); a role that does part of the work has `"writes"`, `"limitedTo"`, `"hidden"` and `"leaves"` ("Roles that do part of the work" below).

Once the entities exist, one command writes the module's access from the record:

```bash
bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug> --access .tmp_deploy/access.json
```

It writes only what is missing or different, and names each write: permissions, hierarchy rows, roles and grants, the access level, the fields the gates need, the validation rules, computed stamps and `select_rule`s, `include_hidden_rows` on the rollups those affect, and each entity's class and `edit_permission`. A generated rule is recognized by its name and replaced when it differs; any other rule is kept. Run again, it is the verification: it ends `Nothing created or changed.` when the module matches the record, and `Not verified: <n> problem(s) above; fix them and run this again.` (exit 4) after any `warning:`. A problem in the record stops it before any write (exit 2). Its access summary, between `access summary:` and `end of access summary`, is the module's access in plain words ("The access summary" below). It refuses a `raci` module ("A gate in a `raci` module" below).

For each gate of the record it writes:

1. **The gate** `<slug>:<verb>_<noun>`: the verb names the step and the noun is the singular record (`spend:approve_purchase_request`, `spend:sign_contract`, `spend:release_budget`, `spend:post_invoice`, `spend:terminate_contract`, `spend:void_invoice`, `spend:open_period`, `spend:issue_purchase_order`). A restricted create is `<slug>:create_<noun>`.
2. **Its bundles:** `<slug>:admin` includes the gate, and so does the bundle of each role whose person moves records into the state ("Roles that take gates" below). Roles hold bundles, never the gate itself.
3. **The access level:** `access_scope: gated`.
4. **A validation rule on the entity**, checked with `has_permission` so the rule's own `code` and `message` surface; the message names who may take the step ("Only a Buyer can order a purchase request."). A transition into a state, for a gate without controls:

   ```json
   {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "ordered"]}]},
     {"has_permission": "spend:order_purchase_request"},
     true]}
   ```

   A gate with controls (every approval gate, and a gate with a named person) puts the gate's check in place of `has_permission` ("Controls on a gate" below, with complete rules). A restricted create tests `$mode` instead: `{"if": [{"==": [{"var": "$mode"}, "insert"]}, {"has_permission": "<slug>:create_<noun>"}, true]}`. Operators and the rule shape (`code`, `name`, `message`, `jsonlogic`) are in `jsonlogic.md`; codes continue after the highest code the module already uses.
5. **No skip past the gate.** The states after the gate are the states a record reaches only after it was in the gated state (`received` and `closed` after `issued`; `ordered` after `approved`; `active`, `expired` and `terminated` after `signed`): the gate's `after`. When there are any, a second validation rule holds two lists: the states after the gate, and the gated state together with those states. A record enters a state of the first list only when its old state is in the second list, or when the user passes the gate's check, because a skip takes the step. A record created straight into a later state passes only with the gate's check, which on an approval gate means only an admin (imports and seed rows). The message names the step that cannot be skipped ("A purchase order must be issued before it is received or closed."):

   ```json
   {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"in": [{"var": "workflow_state"}, ["received", "closed"]]}]},
     {"or": [{"in": [{"var": "$old.workflow_state"}, ["issued", "received", "closed"]]}, {"has_permission": "spend:issue_purchase_order"}]},
     true]}
   ```

   The `has_permission` branch is the gate's check, here for a gate without controls; an approval gate puts its whole check there ("Controls on a gate"), so a requester cannot skip past their own approval. A state the record can also reach without the gate (`rejected` beside `approved`, `canceled` before signing) is not in `after`, even when it can be reached after the gate too; when it comes after the gate in the `workflow_state` order, it goes in `notAfter`. Every state after the gate in that order is in one of the two lists, and the script refuses a record that leaves one out, because a state missing from `after` loses the gate's sequence rule and, on an approval gate, its locks and stamps, and the move into it then counts as moving an approved record back. For an offer whose gate is `approved`, with `draft`, `submitted`, `approved`, `rejected`, `sent`, `accepted` and `declined`: an offer is sent only once approved, and accepted or declined only once sent, so `after` is `sent`, `accepted`, `declined`; `rejected` is reached instead of `approved`, so it is not, and as the approval's own rejection it needs no `notAfter` either. For a purchase order whose gate is `issued`, with `draft`, `issued`, `received`, `closed` and `canceled`: `after` is `received` and `closed`, and `notAfter` is `canceled`, which a draft can reach too. A state after the gate stays in `after` when it has a gate of its own (`terminated` after `signed`, `ordered` after `approved`): its own gate rule still decides who takes it.
6. **The entity's class:** `operational_workflow`. An entity with a lifecycle and no gate is `operational_record`, and a module with no gate is `advanced`.

**Another role for a step, or none.** The access summary names each gated step and the roles that take it. When the user names another role for a step, change the record (give the state to that role's person, adding the role to `roles` when it is new) and run the command again. Naming the module's Manager role means every editor may take the step, so it is not a gate: give the state to the everyday person in the record, with the user's choice as its `because`, then drop the gate in this order: its gate rule, its sequence rule and its controls (below) first, then its permission and its hierarchy rows. When a role takes no other gate, move its users to the Manager role after the user agrees, then delete its grant, the role, its bundle and the bundle's hierarchy rows, and take it out of the record. Running the command then sets the entity's class and the module's access level.

The platform saves a rule that names a permission that does not exist, and that check is then false for every caller, admins included, so the step is closed to everyone; inside a `!` a misspelled name fails open instead, and the clause admits everyone. The command creates every permission before a rule that names it. A rule written by hand (a `select_rule` of its own, a rule outside the record) is checked the same way: collect every `has_permission` and `require_permission` name in it and read them in one `read_permission` with `permission_name=in.(…)`; `call-file.ts` does this for every payload it sends. The module's tier permissions are `<slug>:read`, `<slug>:manage` and `<slug>:admin`; viewer, manager and admin are role names, so `recruiting:manager` and `recruiting:viewer` are never permissions. The direct path marks no gate as high risk, so every gate is included in `<slug>:admin`.

#### Roles that take gates

A role beyond the module's viewer, manager and admin either takes gated steps while it does the everyday work, as in this section, or does only part of the work ("Roles that do part of the work" below). A role that takes gates is a Hiring Manager who approves offers, an Approver who approves purchase requests, a Buyer who issues orders. It does the everyday work too, so its bundle includes `<slug>:manage`. One role can take several gates, and two roles can take the same gate. The record lists it in `roles` and gives it each state it moves records into, and the command creates:

1. **The bundle** `<slug>:<role_key>`, with `role_key` in snake_case (`recruiting:hiring_manager`), described by the steps it adds ("Manage Recruiting data and approve offers"), with `module_id`.
2. **Its hierarchy rows:** the bundle includes `<slug>:manage` and each gate the role takes.
3. **The role:** `role_name` "<Module Name> <Role Title>" ("Recruiting Hiring Manager"), `slug` `<module slug with - as _>_<role_key>`, and `module_id`.
4. **Its grant:** the role holds its bundle.

In the per-entity shape the bundle is `<unit>:<role_key>` and includes `<unit>:manage`. The module's default roles stay viewer, manager and admin. A user who takes a gated step is given the role for it.

#### Roles that do part of the work

Some people use a module without doing its everyday work: they write only some entities and, where the leading products limit them, see only the records that name them. Most domains have such a role:

| Domain | Role | Writes | Sees only |
|---|---|---|---|
| Service desk | Requester | tickets, comments on them | the tickets they requested |
| Field service | Technician | service reports, time entries | the work orders assigned to them |
| Expenses | Employee | expense reports and their lines | their own reports |
| Recruiting | Interviewer | scorecards | the interviews they are on |

Such a role never gets `<slug>:manage`, which writes every entity of the module. It has five parts:

1. **Reads.** Its bundle includes `<slug>:read`, so its holders see the module and its catalog data.
2. **Writes.** Each entity it writes takes `edit_permission = <slug>:write_<entity>`. `<slug>:manage` includes it, so the module's managers lose nothing, and so does the role's bundle.
3. **Rows.** On each entity the products limit the role to, its holders see the records a user field names them in, and the records below those. The field names the person who requested the record (`requested_by_user_id`, stamped on insert as in "Controls on a gate", control 1) or the person assigned to it (`technician_user_id`, `interviewer_user_id`: a `reference` to `users` with `reference_delete_mode: clear`). The `select_rule` has the shape of control 7, with this role's bundle in its `!` and `<slug>:manage` in place of `<slug>:admin`, so a person who also does the everyday work sees every record. An entity the products hide from the role (offers from an interviewer, internal notes from a requester) gets a `select_rule` that hides it from the role's holders.
4. **Writes stay within those rows.** A `select_rule` limits which records the role's holders change, not which they create, and the platform checks a new row only against `edit_permission`. A validation rule on each entity the role writes therefore refuses a write by a holder without `<slug>:manage` unless the record, or its parent read with `set_record`, names them after the write.
5. **Fields it may not change.** A field the products leave to the everyday workers (a ticket's priority and its assignee) gets a validation rule that, for a holder without `<slug>:manage`, refuses any value but the default on insert and any change on update.

The records above the one that names the person (the application and candidate above an interview, the customer above a ticket) cannot be narrowed to the role's records: `set_record` reads one row by id, so no rule can look for the rows below it that name the user. They stay visible to the role's holders, and the access summary says so. An entity above that the products hide from the role is hidden whole, as in part 3.

A role of this kind can also take a gate (a customer who accepts a quote). Its bundle then includes that gate, still without `<slug>:manage`, and `<slug>:admin` includes the gate as it includes every gate.

In the record, such a role has `"writes"` (the entities it writes), `"limitedTo"` (each entity the products limit it to, with the user field that names its holders), `"sees"` (the entities it sees besides those; all others are hidden from it) and `"fills"` (the fields it fills in on each entity it writes; all others stay with the everyday workers), or `"hidden"` and `"leaves"` named directly. The requester of a service desk whose agents do the everyday work:

```json
{
  "products": ["Zendesk", "Freshdesk"],
  "people": { "agent": "agent", "requester": "requester" },
  "everyday": "agent",
  "roles": {
    "requester": { "title": "Requester", "writes": ["tickets", "ticket_comments"], "limitedTo": { "tickets": "requested_by_user_id" },
                   "hidden": ["internal_notes"], "leaves": { "tickets": ["assigned_user_id", "priority"] } }
  },
  "entities": {},
  "userFields": { "tickets.assigned_user_id": { "by": "agent", "because": "a ticket is assigned to the agent who works it" } }
}
```

From it the command creates:

1. **The permissions:** each `<slug>:write_<entity>` ("Write tickets") and the bundle `<slug>:<role_key>`, described by what it does ("Write your own tickets and ticket comments"), each with `module_id`.
2. **The hierarchy rows:** `<slug>:manage` includes each `<slug>:write_<entity>`; each `<slug>:write_<entity>` includes `<slug>:read`, because a write without read is unusable under row-level security; the bundle includes `<slug>:read`, each `<slug>:write_<entity>` the role writes and each gate it takes.
3. **The role and its grant,** as for a role that takes gates: `role_name` "<Module Name> <Role Title>" ("Service Desk Requester"), `slug` `<module slug with - as _>_<role_key>`, `module_id`.
4. **The entities:** each written entity's `edit_permission`; the field that names the holders (`requested_by_user_id`, stamped on insert, or the assigned field, such as `interviewer_user_id`) when it is missing; the write and field rules; and the `select_rule`s on each limited entity, on each entity below it (one whose `parent` field, or required `reference`, points at it) and on each hidden entity. A rollup over an entity with such a `select_rule` needs `include_hidden_rows: true` before the rule is set (`90269` otherwise). The command sets it on each such rollup, without asking, and names it (`rollup-fields.md` → "Hidden child rows").

In the per-entity shape the bundle is `<unit>:<role_key>` and includes `<unit>:read` and the role's `write_<entity>` permissions, and `<unit>:manage` includes each of those.

**Complete rules for a requester.** What the command writes for the requester above, in a Service Desk module (`service_desk`) whose tickets already carry rules up to code `99009`. A requester files tickets, comments on their own tickets, and never sees the agents' internal notes. Each ticket names its requester in `requested_by_user_id`, stamped on insert in `computed_fields` as in "Controls on a gate", control 1. The role is `service_desk:requester`; its bundle includes `service_desk:read`, `service_desk:write_tickets` and `service_desk:write_ticket_comments`, which are the `edit_permission` of `tickets` and of `ticket_comments`.

The `select_rule` of `tickets`, which holds the field:

```json
{"and": [{"has_permission": "service_desk:read"}, {"or": [
  {"!": [{"has_permission": "service_desk:requester"}]},
  {"has_permission": "service_desk:manage"},
  {"and": [{"!=": [{"var": "requested_by_user_id"}, null]}, {"==": [{"var": "requested_by_user_id"}, {"var": "$user_id"}]}]}]}]}
```

The `validation_rules` of `tickets`, which keep a requester's writes to their own tickets (part 4):

```json
[
  {"code": "99010", "name": "requester_own_tickets",
   "message": "A requester can only write their own tickets.",
   "jsonlogic": {"if": [{"has_permission": "service_desk:manage"}, true,
     {"and": [{"!=": [{"var": "requested_by_user_id"}, null]}, {"==": [{"var": "requested_by_user_id"}, {"var": "$user_id"}]}]}]}}
]
```

The `select_rule` of `ticket_comments`, which shows a comment when its ticket is visible:

```json
{"and": [{"has_permission": "service_desk:read"}, {"or": [
  {"!": [{"has_permission": "service_desk:requester"}]},
  {"has_permission": "service_desk:manage"},
  {"set_record": ["ticket", "tickets", {"var": "ticket_id"}, {"!=": [{"var": "ticket"}, null]}]}]}]}
```

The `validation_rules` of `ticket_comments`:

```json
[
  {"code": "99012", "name": "requester_own_ticket_comments",
   "message": "A requester can only write the ticket comments of their own tickets.",
   "jsonlogic": {"if": [{"has_permission": "service_desk:manage"}, true,
     {"set_record": ["ticket", "tickets", {"var": "ticket_id"},
       {"and": [{"!=": [{"var": "ticket"}, null]}, {"!=": [{"var": "ticket.requested_by_user_id"}, null]},
         {"==": [{"var": "ticket.requested_by_user_id"}, {"var": "$user_id"}]}]}]}]}}
]
```

The `select_rule` of `internal_notes`, which the role does not see:

```json
{"and": [{"has_permission": "service_desk:read"}, {"or": [
  {"!": [{"has_permission": "service_desk:requester"}]},
  {"has_permission": "service_desk:manage"}]}]}
```

Where control 7 also narrows an entity, its `select_rule` is one `and` of the entity's `view_permission`, control 7's `or` and this `or`.

**A field the role may not change.** The requester leaves a ticket's assignee and priority (`"leaves"`, fields titled "Assignee" and "Priority", the priority's default `medium`) to the agents, the module's Manager role:

```json
{"code": "99011", "name": "requester_leaves_ticket_fields",
 "message": "Only a Manager can set a ticket's assignee or priority.",
 "jsonlogic": {"if": [{"has_permission": "service_desk:manage"}, true,
   {"if": [{"==": [{"var": "$mode"}, "insert"]},
     {"and": [{"==": [{"var": "assigned_user_id"}, null]}, {"==": [{"var": "priority"}, "medium"]}]},
     {"!": [{"or": [{"value_changed": "assigned_user_id"}, {"value_changed": "priority"}]}]}]}]}}
```

On a delete `value_changed` is `false` for every field, so the rule passes, and the ticket's own write rule (part 4) decides.

#### The access summary

`module-rbac-setup.ts --access` prints the module's access as markdown, between the lines `access summary:` and `end of access summary`, from the live module and the record; the final response uses the lines between them, unchanged. A review's access section writes a module's access in the same form, in plain words:

1. **The access level**, in bold ("**Access: gated.** Some steps are restricted to a role." or "**Access: advanced.** No step is restricted to a role."), and that the module's role names start with the module's name, so the table names roles by their title alone.
2. **A table, Role | Does | Sees,** one row per role: viewer, manager and admin, then each role that takes gates, with each step it takes ("marks applications Hired") or the records it alone creates, and each role that does part of the work, with what it writes. Sees names the records the role is limited to and those below them, what is hidden from it, and "all other records" when the rest stay visible to it, as the records above the ones that name it do ("Roles that do part of the work").
3. **"Only an admin can change \<plural labels\>."**, when any entity's write tier is the admin tier.
4. **Restricted steps:** one bullet per gate, "\<Plural label\> → \<State\>: \<roles that take it\>.", then the named person, an approval gate's controls and a payout gate's requester check; and one bullet per restricted create, "\<Plural label\>: created only by \<roles\>."
5. **No restricted step** on each entity with a `workflow_state` and no gate: "anyone who can edit one can move it through every state."

The summary of the purchase request's record ("The access record"):

```markdown
**Access: gated.** Some steps are restricted to a role. Role names start with "Spend".

| Role | Does | Sees |
|---|---|---|
| Viewer | reads only | everything |
| Manager | the everyday work | everything |
| Admin | the everyday work and every restricted step | everything |
| Approver | the everyday work; marks purchase requests Approved | everything |
| Buyer | the everyday work; marks purchase requests Ordered | everything |

**Restricted steps**
- Purchase Requests → Approved: Approver. When the purchase request names an approver, only that person or an admin. The requester may not approve it; only a submitted one is approved; what it covers is locked from submitted on; only the requester recalls it; only the approver rejects it or moves it back; who approved it and when is recorded.
- Purchase Requests → Ordered: Buyer.
```

#### Controls on a gate

Purchasing, finance and hiring products guard a step with more than a permission. Which controls a gate gets:

| Control | Goes with |
|---|---|
| 1. The requester may not approve or pay out | Every approval gate and every payout gate |
| 2. Approve only a waiting record | Every approval gate |
| 3. Lock while waiting and after approval | Every approval gate |
| 4. Approved stays approved | Every approval gate |
| 5. Record who approved | Every approval gate |
| 6. A named person | A gate the leading products assign to one person per record (the request's approver, the job opening's hiring manager) |
| 7. Named people see only their records | A named person whose role the leading products limit to its own records (hiring managers see only the job openings they are named on). Not purchasing approvers, who see every request |

An **approval gate** is a gate into `approved`, `signed`, `posted`, `released` or `verified`: a step where one person authorizes what someone else prepared. `issued`, `ordered`, `hired`, `committed`, `void` and `terminated` are gates but not approval gates. A **payout gate** is a gate into `paid`, `reimbursed` or `disbursed`: a step that releases money. It takes control 1 and none of the other approval controls. The **waiting state** is the state a record sits in until the approval (`submitted`, `pending`, `in_review`), and the state before it is where the record was prepared (`draft`). An approval gate also decides the rejection: the move from the waiting state into `rejected` takes the same check, with no permission of its own.

**The gate's check.** Every rule of a gate uses one check, so skipping the step, undoing it or changing what it covered takes the same check as the step itself. The locks (control 3) also admit any admin, so an admin can correct or clear a locked record, as an admin can in the products. The check has two parts:

- **Who may take it:** an admin, or a holder of the gate who, when the record names a person, is that person. Without a named person it is `{"has_permission": "<gate>"}`. With one:

  ```json
  {"or": [{"has_permission": "spend:admin"},
    {"and": [{"has_permission": "spend:approve_purchase_request"},
      {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]}]}]}
  ```

  The named person needs the gate too, so naming yourself or a colleague without it opens no way past the gate. A system write has no user (`$user_id` is null), so it never counts as the named person.
- **Not the requester,** on an approval or payout gate only. A record created straight into the gated state or a state after it is an import or a seed, which only an admin may do. On any other write, the user who created the record may not take the step, admins included:

  ```json
  {"if": [{"==": [{"var": "$mode"}, "insert"]},
    {"has_permission": "spend:admin"},
    {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}
  ```

The check is who may take it; on an approval or payout gate it is `{"and": [<who may take it>, <not the requester>]}`. In a `living` `raci` module, who may take it also admits `{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}` in its `or`.

**When the person is on a parent.** When the products keep the named person on a parent (the hiring manager on the job opening, the gate on the application), the rule reads the parent with `set_record` and uses `<binding>.<role_key>_user_id` in place of `$old.<role_key>_user_id`, where `<binding>` is the name `set_record` gives the parent (`job_opening`). Two levels up (an offer of an application of a job opening), nest one `set_record` in the other (`jsonlogic.md` → "Canonical patterns", Pattern 6). A parent the user cannot read binds as `null`, and then only an admin passes: `{"if": [{"==": [{"var": "job_opening"}, null]}, {"has_permission": "recruiting:admin"}, <the check>]}`.

1. **The requester may not approve or pay out.** Add `requested_by_user_id` (`reference` to `users`, `reference_delete_mode: clear`, title "Requested By") and stamp it on insert in `computed_fields` (the complete rules below). It keeps its value when the platform clears it, so a user who requested records may not be deletable: set the user's `is_disabled` instead. Added to an entity that already has records, it leaves those records with no requester, which the check cannot protect: a review's fix says so.
2. **Approve only a waiting record.** A record enters the gated state only from the waiting state, or back from a state after the gate (rule `approve_purchase_request` below). Only its requester or an admin moves a waiting or rejected record back to the state before the waiting state (`draft`), which ends the lock; to change it, move it back and submit it again.
3. **Lock while waiting and after approval.** The lock states are the waiting state, the gated state and the states after the gate (step 5). In a lock state, only an admin or someone who passes the gate's check may delete the record or change its fields. List every field of the entity except `workflow_state`, rollups, computed fields and fields a later step fills (a PO number, an order date, a received quantity); the complete rules name only some. The named person's field is locked too.

   Lines the approval covers (purchase request lines, invoice lines) get the lock on the child entity. It fires when a line is added or deleted, moved to another parent, or any of its fields changes except a field a later step fills, and it reads each parent with `set_record`. It admits an admin, or someone who passes the gate's check read from the parent (`purchase_request.approver_user_id`, `purchase_request.requested_by_user_id`). A parent that reads as `null` on a delete is being deleted itself, which its own lock already checked; otherwise a `null` parent admits only an admin.
4. **Approved stays approved.** A move out of the gated state or a state after it, to a state outside the second list of step 5 (`approved` or `ordered` back to `draft` or to `rejected`), takes the gate's check. Recalling a waiting or rejected record (control 2) is the only move back without it.
5. **Record who approved.** Stamp `<step>_by_user_id` (`reference` to `users`, `reference_delete_mode: clear`) and `<step>_at` (`date-time`), named for the step (`approved_by_user_id` and `approved_at`, `signed_by_user_id` and `signed_at`), in `computed_fields` when the record enters the gated state from outside the second list of step 5. They keep the last approval when a record moves back. A record created straight into the gated state or a state after it (an import or a seed, which only an admin may do) never passes that move, so each stamp first keeps what such an insert sends: `{"if": [{"and": [{"==": [{"var": "$mode"}, "insert"]}, {"in": [{"var": "workflow_state"}, [<the second list of step 5>]]}, {"!=": [{"var": "<stamp>"}, null]}]}, {"var": "<stamp>"}, <the stamp rule>]}`. Every other write ignores a value sent for a stamp.
6. **A named person.** Add `<role_key>_user_id` (`reference` to `users`, `reference_delete_mode: clear`) to the record, or to the parent where the products keep it, and use it in who may take the step (above). Control 3 locks it from the waiting state on.
7. **Named people see only their records.** A holder of the role (`<slug>:<role_key>`, `"seesOnlyNamed": true` in the record) sees only the records they are named on; a record nobody is named on stays hidden from them until someone is named. Everyone else who holds the entity's `view_permission` sees every record. It is a `select_rule` (`select-rule.md`) on the entity that holds the field, and on each entity below it (one whose `parent` field, or required `reference`, points at it), which shows a record to a holder of the role when its parent is visible to them. For a Hiring Manager named on each job opening (`hiring_manager_user_id`), on `job_openings` and on `applications`:

   ```json
   {"and": [{"has_permission": "recruiting:read"}, {"or": [
     {"!": [{"has_permission": "recruiting:hiring_manager"}]},
     {"has_permission": "recruiting:admin"},
     {"and": [{"!=": [{"var": "hiring_manager_user_id"}, null]}, {"==": [{"var": "hiring_manager_user_id"}, {"var": "$user_id"}]}]}]}]}
   ```

   ```json
   {"and": [{"has_permission": "recruiting:read"}, {"or": [
     {"!": [{"has_permission": "recruiting:hiring_manager"}]},
     {"has_permission": "recruiting:admin"},
     {"set_record": ["job_opening", "job_openings", {"var": "job_opening_id"}, {"!=": [{"var": "job_opening"}, null]}]}]}]}
   ```

   - Managers, and everyone else without the narrowed role, see every record through the first clause (`{"!": [{"has_permission": "recruiting:hiring_manager"}]}`), so they need no clause of their own. `recruiting:admin` admits a person who holds the narrowed role too. The clause is never `recruiting:manage`: the narrowed role's bundle includes it, so every holder of the role would see every record. (A role that does part of the work is different: its bundle never includes `<slug>:manage`, so there `<slug>:manage` is the clause; see "Roles that do part of the work".)
   - `recruiting:read` stands for the entity's `view_permission`.
   - When the entity has `requested_by_user_id`, add `{"==": [{"var": "requested_by_user_id"}, {"var": "$user_id"}]}` to the `or`, so a holder of the role still sees what they requested.
   - Each other bundle of a role that takes gates and is not narrowed gets its own `{"has_permission": "<slug>:<role_key>"}` in the `or`, after `<slug>:admin`; never `<slug>:read` or `<slug>:manage`, which the narrowed role's bundle includes. Without one, holding the narrowed role narrows what a person sees even when they hold another role, so a person who must see every record and also take the step gets the admin role.
   - The rule also limits which records the role's holders may change, but not which they may create.
   - Reading the parent with `set_record` here is the case `select-rule.md` → "Performance note" reserves it for: one parent row by its id, in a module with light read traffic.
   - A rollup over these entities needs `include_hidden_rows: true`. The command sets it without asking and names it; the final response names it too (`rollup-fields.md` → "Hidden child rows").
   - A role that does part of the work narrows rows with the same rule ("Roles that do part of the work"). Where both narrow one entity, its `select_rule` is one `and` of the entity's `view_permission` and both `or`s.

**Complete rules for a purchase request.** What the command writes for the record in "The access record" above, in a Spend module (`spend`). Its states are `draft`, `submitted`, `approved`, `rejected` and `ordered`. An Approver approves or rejects it, and a Buyer orders it. The products name an approver per request (`approver_user_id`). Its fields are `supplier_id`, `needed_by_date`, `po_number`, filled when the request is ordered, and `total_amount`, a rollup of its lines (`quantity`, `unit_price`); both labels are composed. The `computed_fields` of `purchase_requests`, after its label rule:

```json
[
  {"name": "requested_by_user_id", "jsonlogic": {"if": [{"==": [{"var": "$mode"}, "insert"]}, {"var": "$user_id"}, {"var": "$old.requested_by_user_id"}]}},
  {"name": "approved_by_user_id", "jsonlogic": {"if": [
    {"and": [{"==": [{"var": "$mode"}, "insert"]}, {"in": [{"var": "workflow_state"}, ["approved", "ordered"]]}, {"!=": [{"var": "approved_by_user_id"}, null]}]},
    {"var": "approved_by_user_id"},
    {"if": [
      {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "approved"]}, {"!": [{"in": [{"var": "$old.workflow_state"}, ["approved", "ordered"]]}]}]},
      {"var": "$user_id"}, {"var": "$old.approved_by_user_id"}]}]}},
  {"name": "approved_at", "jsonlogic": {"if": [
    {"and": [{"==": [{"var": "$mode"}, "insert"]}, {"in": [{"var": "workflow_state"}, ["approved", "ordered"]]}, {"!=": [{"var": "approved_at"}, null]}]},
    {"var": "approved_at"},
    {"if": [
      {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "approved"]}, {"!": [{"in": [{"var": "$old.workflow_state"}, ["approved", "ordered"]]}]}]},
      {"var": "$now"}, {"var": "$old.approved_at"}]}]}}
]
```

Each approval stamp starts with the insert branch of control 5: a record created in `approved` or `ordered` keeps the approver and the date the insert sends.

The `validation_rules` of `purchase_requests`:

```json
[
  {"code": "99001", "name": "approve_purchase_request",
   "message": "Only the named approver, or an Approver when none is named, can approve a submitted purchase request, and never the person who requested it.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "approved"]}]},
     {"and": [
       {"or": [{"==": [{"var": "$mode"}, "insert"]}, {"in": [{"var": "$old.workflow_state"}, ["submitted", "ordered"]]}]},
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
  {"code": "99003", "name": "recall_purchase_request",
   "message": "Only the person who requested it, or an admin, can move a submitted or rejected purchase request back to draft.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"in": [{"var": "$old.workflow_state"}, ["submitted", "rejected"]]}, {"==": [{"var": "workflow_state"}, "draft"]}]},
     {"or": [{"has_permission": "spend:admin"},
       {"and": [{"!=": [{"var": "$old.requested_by_user_id"}, null]}, {"==": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}},
  {"code": "99004", "name": "order_purchase_request",
   "message": "Only a Buyer can order a purchase request.",
   "jsonlogic": {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "ordered"]}]},
     {"has_permission": "spend:order_purchase_request"},
     true]}},
  {"code": "99005", "name": "approve_purchase_request_first",
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
  {"code": "99006", "name": "approved_stays_approved",
   "message": "Only the named approver, or an Approver when none is named, can move an approved or ordered purchase request back, and never the person who requested it.",
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
  {"code": "99007", "name": "lock_submitted_purchase_request",
   "message": "Only an admin, or someone who may approve it, can change or delete a submitted, approved or ordered purchase request; its requester can move a submitted one back to draft to change it.",
   "jsonlogic": {"if": [
     {"and": [
       {"in": [{"var": "$old.workflow_state"}, ["submitted", "approved", "ordered"]]},
       {"or": [{"==": [{"var": "$mode"}, "delete"]}, {"value_changed": "supplier_id"}, {"value_changed": "needed_by_date"}, {"value_changed": "approver_user_id"}]}]},
     {"or": [{"has_permission": "spend:admin"},
       {"and": [{"has_permission": "spend:approve_purchase_request"},
         {"or": [{"==": [{"var": "$old.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "$old.approver_user_id"}]}]},
         {"!=": [{"var": "$old.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
     true]}}
]
```

The `validation_rules` of `purchase_request_lines`:

```json
[
  {"code": "99008", "name": "lock_purchase_request_lines_of_submitted_purchase_request",
   "message": "Only an admin, or someone who may approve the purchase request, can change the purchase request lines of a submitted, approved or ordered purchase request.",
   "jsonlogic": {"and": [
     {"if": [
       {"or": [{"==": [{"var": "$mode"}, "insert"]}, {"==": [{"var": "$mode"}, "delete"]},
         {"value_changed": "purchase_request_id"}, {"value_changed": "quantity"}, {"value_changed": "unit_price"}]},
       {"set_record": ["purchase_request", "purchase_requests", {"var": "purchase_request_id"},
         {"if": [{"==": [{"var": "purchase_request"}, null]},
           {"or": [{"==": [{"var": "$mode"}, "delete"]}, {"has_permission": "spend:admin"}]},
           {"if": [{"in": [{"var": "purchase_request.workflow_state"}, ["submitted", "approved", "ordered"]]},
             {"or": [{"has_permission": "spend:admin"},
               {"and": [{"has_permission": "spend:approve_purchase_request"},
                 {"or": [{"==": [{"var": "purchase_request.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "purchase_request.approver_user_id"}]}]},
                 {"!=": [{"var": "purchase_request.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
             true]}]}]},
       true]},
     {"if": [{"and": [{"==": [{"var": "$mode"}, "update"]}, {"value_changed": "purchase_request_id"}]},
       {"set_record": ["old_purchase_request", "purchase_requests", {"var": "$old.purchase_request_id"},
         {"if": [{"==": [{"var": "old_purchase_request"}, null]},
           {"has_permission": "spend:admin"},
           {"if": [{"in": [{"var": "old_purchase_request.workflow_state"}, ["submitted", "approved", "ordered"]]},
             {"or": [{"has_permission": "spend:admin"},
               {"and": [{"has_permission": "spend:approve_purchase_request"},
                 {"or": [{"==": [{"var": "old_purchase_request.approver_user_id"}, null]}, {"==": [{"var": "$user_id"}, {"var": "old_purchase_request.approver_user_id"}]}]},
                 {"!=": [{"var": "old_purchase_request.requested_by_user_id"}, {"var": "$user_id"}]}]}]},
             true]}]}]},
       true]}]}}
]
```

**A step whose named person sits on the parent** (not an approval, so no requester part). In a Recruiting module (`recruiting`) whose recruiters do the everyday work (`"everyday": "recruiter"`) and whose rules reach code `99008`, the record gives `applications` the state `"hired": { "by": "hiring_manager", "namedPerson": { "via": "job_opening_id" }, "notAfter": ["rejected"] }` (an application can be rejected without being hired), and the Hiring Manager role `"seesOnlyNamed": true`, which writes the two `select_rule`s of control 7 above:

```json
{"code": "99009", "name": "hire_application",
 "message": "Only the job opening's hiring manager, or a Hiring Manager when none is named, can hire an application.",
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

A new module, or one that has none of this yet, never uses these calls for its viewer, manager and admin access. Gates, the roles that take them and the roles that do part of the work come from the module's access record and `module-rbac-setup.ts --access` ("Restricted steps (gates)" → "The access record"), in a new module and in one that already has its entities alike; these calls never create them, except in a `raci` module ("A gate in a `raci` module"). Run the script instead (`data-modeling.md` → "Mandatory Creation Order", steps 1 to 5):

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
