# Semantius RBAC Reference

Role-based access control in Semantius flows: **Users → Roles → Permissions**, with optional permission inheritance through `permission_hierarchy`.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Permission** | Atomic capability, named `<module>:<action>` (e.g., `crm:read`, `crm:manage`) |
| **Permission Hierarchy** | `manage` implicitly includes `read`, set up so users don't need both assigned separately |
| **Role** | Named bundle of permissions (e.g., `crm_viewer`, `crm_manager`) |
| **Role Permission** | M:N join: grants a permission to a role |
| **User Role** | M:N join: assigns a role to a user |

---

## Naming Convention

**Always use `<module>:<action>` format:**
- `crm:read`, read access to CRM entities
- `crm:manage`, full write access to CRM entities
- `leads:write`, specific write-only on leads
- `service_catalog:read`

Never use free-form names like `"can_edit"` or `"admin"`, always scope to a module.

---

## Step-by-Step: Full RBAC Setup for a New Module

Every step below writes a **set** of records of one kind, so each is **one** call with an array in `data` (Golden Rule 7): both permissions in one `create_permission`, both roles in one `create_role`, both grants in one `create_role_permission`. Duplicate-check each set with one `read_*` using an `in.(...)` filter first (`read_permission '{"filters": "permission_name=in.(crm:read,crm:manage)"}'`); resolve ids from that read, never from the create response.

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

Make `crm:manage` implicitly include `crm:read`, so assigning `manage` is sufficient (with an admin tier, both edges — `admin → manage` and `manage → read` — go in one call):

```bash
semantius call crud create_permission_hierarchy '{
  "data": {
    "including_permission_id": <crm:manage id>,
    "included_permission_id": <crm:read id>
  }
}'
```

### 3. Create Roles

The role fields are **`role_name`** (the human display name) and **`slug`** (snake_case handle, `^[a-z0-9_]+$` — **underscores only, NO hyphens**, unlike a `module_slug`, which DOES allow hyphens; the two formats differ, so when you build a role slug from a hyphenated module slug you must convert `-`→`_`, e.g. module `hvac-svc-mgmt` → role `hvac_svc_mgmt_viewer`, never `hvac-svc-mgmt_viewer`. A hyphen in the slug fails the regex. Auto-derived from `role_name` if omitted, but pass it explicitly so the handle is deploy-controlled and not left to slugify). There is **no `name` and no `label` field** — those are a common mistake. For a role a module scaffold owns you MUST also pass:

- **`module_id`** — the owning module. Omit it and the role is an **orphan**: it exists but is invisible in the module's governance panel and unlinked from the module record's `default_*_role_id`.
- **`origin: "model"`** — marks it deployer-provisioned. Omit it and the role defaults to **`origin: "user"`** (admin-created), the wrong provenance for a deployed role. (`model_master` for a master-module scaffold; see the modeler skill.)

```bash
# Viewer (read only) and manager (full access) roles — in ONE call
semantius call crud create_role '{
  "data": [
    {
      "role_name": "CRM Viewer",
      "slug": "crm_viewer",
      "description": "Can view CRM data",
      "module_id": 3,
      "origin": "model"
    },
    {
      "role_name": "CRM Manager",
      "slug": "crm_manager",
      "description": "Can manage all CRM data",
      "module_id": 3,
      "origin": "model"
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
      "permission_id": <crm:read id>
    },
    {
      "role_id": <crm_manager id>,
      "permission_id": <crm:manage id>
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
  "data": {"role_id": 5, "permission_id": 12}
}'
# Several permissions (or several roles) — ONE call
semantius call crud create_role_permission '{
  "data": [{"role_id": 5, "permission_id": 12}, {"role_id": 5, "permission_id": 13}, {"role_id": 6, "permission_id": 12}]
}'
```

### Remove permissions from a role
```bash
# Find the role_permission record(s) first
semantius call crud read_role_permission '{"filters": "role_id=eq.5&permission_id=in.(12,13)"}'
# Then delete by id — several ids in one call
semantius call crud delete_role_permission '{"id": ["<id-1>", "<id-2>"]}'
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
