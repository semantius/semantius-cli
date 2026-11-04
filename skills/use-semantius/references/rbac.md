# Semantius RBAC Reference

Role-based access control in Semantius flows: **Users → Roles → Permissions**, with optional permission inheritance through `permission_hierarchy`.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Permission** | Atomic capability, named `<module>:<action>` (e.g., `crm:read`, `crm:manage`) |
| **Bundle** | A permission that exists to include others through the hierarchy (e.g., `crm:manage`). Roles hold bundles; see *Per-entity permissions and bundles* |
| **Permission Hierarchy** | `manage` implicitly includes `read`, set up so users don't need both assigned separately |
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

Never use free-form names like `"can_edit"` or `"admin"`, always scope to a module.

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

## Step-by-Step: Full RBAC Setup for a New Module

Every step below writes a **set** of records of one kind, so each is **one** call with an array in `data` (Golden Rule 7): both permissions in one `create_permission`, both roles in one `create_role`, both grants in one `create_role_permission`. Duplicate-check each set with one `read_*` using an `in.(...)` filter first (`read_permission '{"filters": "permission_name=in.(crm:read,crm:manage)"}'`). A permission is keyed by its `permission_name`, so every reference to it (hierarchy relationships, grants, module wiring) writes the name directly; only roles and users carry a numeric `id`, and those ids come from that read, never from the create response.

### 1. Create Permissions

```bash
# Baseline: always create both read and manage — in ONE call
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
    }
  ]
}'
```

### 2. Set Up Permission Hierarchy (optional but recommended)

Make `crm:manage` implicitly include `crm:read`, so assigning `manage` is sufficient (with an admin tier, both relationships — `admin → manage` and `manage → read` — go in one call):

```bash
semantius call crud create_permission_hierarchy '{
  "data": {
    "including_permission_name": "crm:manage",
    "included_permission_name": "crm:read"
  }
}'
```

### 3. Create Roles

The role fields are **`role_name`** (the human display name) and **`slug`** (snake_case handle, `^[a-z0-9_]+$` — **underscores only, NO hyphens**, unlike a `module_slug`, which DOES allow hyphens; the two formats differ, so when you build a role slug from a hyphenated module slug you must convert `-`→`_`, e.g. module `hvac-svc-mgmt` → role `hvac_svc_mgmt_viewer`, never `hvac-svc-mgmt_viewer`. A hyphen in the slug fails the regex. Auto-derived from `role_name` if omitted, but pass it explicitly so the handle is deploy-controlled and not left to slugify). There is **no `name` and no `label` field** — those are a common mistake. For a role that belongs to a module you MUST also pass **`module_id`**, the owning module. Omit it and the role is an **orphan**: it exists but is invisible in the module's governance panel and not related to the module record's `default_*_role_id`.

**`origin`** records who provisioned a role or hierarchy relationship, and it cannot change after creation. Leave it unset when you create RBAC by hand; it defaults to `"user"`. `"model"` and `"model_master"` are set only by a spec deploy (a domain module and a master module respectively), and `"system"` only by the platform.

```bash
# Viewer (read only) and manager (full access) roles — in ONE call
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
    }
  ]
}'
```

### 4. Grant Permissions to Roles

```bash
# crm:read → crm_viewer, crm:manage → crm_manager (inherits crm:read via hierarchy) — in ONE call
semantius call crud create_role_permission '{
  "data": [
    {
      "role_id": <crm_viewer id>,
      "permission_name": "crm:read"
    },
    {
      "role_id": <crm_manager id>,
      "permission_name": "crm:manage"
    }
  ]
}'
```

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

`edit_permission` covers insert, update and delete alike. A gate on one operation (only some roles may delete) is a validation rule on the entity, not a third permission column; see `jsonlogic.md` § *Detecting the operation*.
