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
| Bundle (`read`, `manage`, `admin`, and a narrow tier such as `interview`) | `<unit>:<tier>` | The module that declares it |

An entity's `view_permission` and `edit_permission` point at its own read and write permissions, and never change. Roles hold bundles, and the bundles include the entity permissions through `permission_hierarchy`:

| Permission | Includes |
|---|---|
| `<unit>:read` | `read_<entity>` for every entity the module provisions, consumes or contributes to |
| `<unit>:manage` | `<unit>:read`, and `write_<entity>` for each entity written at the `manage` tier |
| `<unit>:admin` | `<unit>:manage`, `write_<entity>` for each entity written at the `admin` tier, plus gates and overrides |
| Narrow tier | `write_<entity>` for the entities it covers. `<unit>:manage` includes it |
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

`access_scope: custom` keeps hand-made permissions and has no per-entity rows. A module built by hand (the steps below, or `semantius-importer`) can use module-wide permissions as its entities' `view_permission` and `edit_permission`, as `crm:read` and `crm:manage` do below: both shapes are valid on the platform.

---

## Choosing an entity's permissions

An entity's `view_permission` and `edit_permission` follow from its class (`data-modeling.md` → "Classifying an entity"). The class gives the **write tier**, the permission level that gates INSERT, UPDATE and DELETE. Choose the class first, then take the permissions from this section, and send all three in the `create_entity` payload.

| Write tier | Entities | Hand-built module (module-wide) | Spec-deployed module (per entity) |
|---|---|---|---|
| `:read` | `computed` | `view_permission = <slug>:read`; omit `edit_permission` (it defaults to `admin`) | `view_permission = <owner>:read_<entity>`; omit `edit_permission` |
| `:manage` | `operational_record`, `operational_workflow`, `junction` | `view_permission = <slug>:read`, `edit_permission = <slug>:manage` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:manage` |
| `:admin` | `catalog`; a `junction` whose parent legs are all `catalog` | `view_permission = <slug>:read`, `edit_permission = <slug>:admin` | `<owner>:read_<entity>` and `<owner>:write_<entity>`, included by `<unit>:admin` |

- **Hand-built modules** (the steps below) have three module-wide permissions, `<slug>:read`, `<slug>:manage` and `<slug>:admin`, and `access_scope: advanced`, or `gated` when the module has a restricted step (see "Restricted steps (gates)" below). `basic` has no admin level, so a module with a `catalog` entity is never `basic`. The entity's `edit_permission` must already exist when `create_entity` runs.
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
# 3. Only now point the entity at it
semantius call crud update_entity '{"table_name": "vendors", "data": {"view_permission": "procurement:read_vendors"}}'
```

The entity list the user confirms says when a reused entity gets its own view permission (`build-module.md` → "Confirm the entity list").

### Restricted steps (gates)

A **gate** is a step that only some users may take: moving a record into an authorization state (`approved`, `signed`, `released`, `published`, `posted`, `committed`), closing or voiding a record that has contractual or financial weight, or creating a record that is restricted. An entity with a gate is an `operational_workflow`. Its `edit_permission` stays at its write tier (`<slug>:manage`), because everyone who edits the record still needs it; the gate is a separate permission plus a validation rule. A step that every holder of `<slug>:manage` may take is not a gate.

| Module situation | `access_scope` | What the gate is |
|---|---|---|
| No gate | `advanced` | Nothing to enforce |
| One or more gates, no RACI matrix | `gated` | One permission per gate, held by the admin role: `<slug>:admin` includes every gate |
| The module is already `raci` | stays `raci` | The new gate follows the module's RACI matrix: see "A gate in a `raci` module" below |

To add a gate to a module:

1. **Name it** `<slug>:<verb>_<noun>`: the verb names the step and the noun is the singular record (`spend:approve_purchase_request`, `spend:sign_contract`, `spend:release_budget`, `spend:post_invoice`, `spend:close_contract`, `spend:void_invoice`, `spend:open_period`, `spend:issue_po`). `create_permission` it in the same call as the baseline permissions, or alone after a `read_permission`.
2. **Hold it through admin:** `create_permission_hierarchy` with `<slug>:admin` including the gate. Roles keep holding `<slug>:read`, `<slug>:manage` and `<slug>:admin` only, never the gate itself.
3. **Set the access level:** `update_module` with `access_scope: gated`, unless it is already `raci`.
4. **Enforce it with a validation rule on the entity** (`validation_rules` on `create_entity` or `update_entity`), checked with `has_permission` so the rule's own `code` and `message` surface; the message names who may take the step ("Only an admin can approve a purchase request"). A transition into a state:

   ```json
   {"if": [
     {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "approved"]}]},
     {"has_permission": "spend:approve_purchase_request"},
     true]}
   ```

   A restricted create tests `$old` for `null` instead: `{"if": [{"==": [{"var": "$old"}, null]}, {"has_permission": "<gate>"}, true]}`. Operators and the rule shape (`code`, `name`, `message`, `jsonlogic`) are in `jsonlogic.md`.
5. **Name the gate in the summary** so the user knows who can take the step (the admin role) and can ask for another holder.

Create the gate permission before the rule that names it: a `has_permission` argument must exist. The direct path marks no gate as high risk, so every gate it creates is included in `<slug>:admin`.

#### A gate in a `raci` module

The matrix is platform data: `processes`, `raci_assignments` and `process_gates` are ordinary entities, read and written with `postgrestRequest`. A new gate joins it like this:

1. **Read the mode.** `living` when the instance has any `processes` row or the module's `settings.raci_mode` is `living`; otherwise `documentation`.
2. **Ask once** which role is Accountable for the new step. Name the step in plain words and offer the module's existing roles. If the user cannot name one, treat the gate as `gated` (the admin role alone holds it) and say so in the summary.
3. **Create the gate permission** and the `<slug>:admin` hierarchy row, exactly as in steps 1 and 2 above.
4. **Write the matrix for the mode.**
   - `living`: insert a `processes` row (`name`, `module_id`, `process_key` `<verb>_<noun>`); a `raci_assignments` row (`process_id`, `role_id` of the Accountable role, `raci: accountable`); and a `process_gates` row (`process_id`, `entity`, `gate_kind` `approval` for a transition into an authorization state, `create` for a restricted create, otherwise `transition`; `to_state`; `state_column` the name of the entity's state field, since the default is `status`). The Accountable role is not granted the gate: the rule resolves it live.
   - `documentation`: nothing is stored. Grant the gate permission to the Accountable role with `create_role_permission`.
5. **Write the rule for the mode.** `living`: the same rule as above with the permission check widened to `{"or": [{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}, {"has_permission": "<gate>"}]}`. `documentation`: `{"has_permission": "<gate>"}` as in step 4 above.

The Accountable role still needs the entity's write tier (`<slug>:manage`) to change the record at all; the gate only decides who may take the step.

---

## Step-by-Step: Full RBAC Setup for a New Module

Every step below writes a **set** of records of one kind, so each is **one** call with an array in `data` (Golden Rule 7): both permissions in one `create_permission`, both roles in one `create_role`, both grants in one `create_role_permission`. Duplicate-check each set with one `read_*` using an `in.(...)` filter first (`read_permission '{"filters": "permission_name=in.(crm:read,crm:manage,crm:admin)"}'`). A permission is keyed by its `permission_name`, so every reference to it (hierarchy relationships, grants, module wiring) writes the name directly; only roles and users carry a numeric `id`, and those ids come from that read, never from the create response.

### 1. Create Permissions

```bash
# Baseline: always create read, manage and admin — in ONE call
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
      "description": "Maintain CRM settings and reference data",
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

The module is pointed at the three permissions with `update_module` right after they exist, before the hierarchy (`data-modeling.md` → "Mandatory Creation Order" → "Wire the module's permission references").

### 3. Create Roles

The role fields are **`role_name`** (the human display name) and **`slug`** (snake_case handle, `^[a-z0-9_]+$` — **underscores only, NO hyphens**, unlike a `module_slug`, which DOES allow hyphens; the two formats differ, so when you build a role slug from a hyphenated module slug you must convert `-`→`_`, e.g. module `hvac-svc-mgmt` → role `hvac_svc_mgmt_viewer`, never `hvac-svc-mgmt_viewer`. A hyphen in the slug fails the regex. Derived from `role_name` if omitted: every run of characters outside `a-z`, `A-Z` and `0-9` becomes one `_`, leading and trailing `_` are removed, then it is lowercased; a name with no ASCII letter or digit derives an empty slug, and a second such role collides. Pass it explicitly so the handle is deploy-controlled and not left to the derivation). There is **no `name` and no `label` field** — those are a common mistake. For a role that belongs to a module you MUST also pass **`module_id`**, the owning module. Omit it and the role is an **orphan**: it exists but is invisible in the module's governance panel and not related to the module record's `default_*_role_id`.

**`origin`** records who provisioned a role or hierarchy relationship, and it cannot change after creation. Leave it unset when you create RBAC by hand; it defaults to `"user"`. `"model"` and `"model_master"` are set only by a spec deploy (a domain module and a master module respectively), and `"system"` only by the platform. `origin` is set on INSERT; a change is refused (`90203` on a role, `90205` on a `permission_hierarchy` row). The `system` roles are the platform built-ins seeded at database init (e.g. `Administrator`, `User`); the `slug` of a `system` role cannot be changed (`90204`), while roles of any other origin can be renamed.

**Module columns.** A module carries `module_type` (`"domain"`, the default, or `"master"` for a module promoted for sharing; its `input_type` is `readonly`, which the database does not enforce), `manage_permission` and `admin_permission` (the names of the module's manage and admin permissions), and `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` (the module's default roles). The last five are ordinary fields set with `create_module` or `update_module`; they are foreign keys, so the permissions and roles they name must already exist.

```bash
# Viewer (read only), manager (everyday records) and admin (settings and reference data) roles — in ONE call
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
      "description": "Can maintain CRM settings and reference data",
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
