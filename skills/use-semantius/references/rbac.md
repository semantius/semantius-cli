# Semantius RBAC Reference

Role-based access control in Semantius flows: **Users → Roles → Permissions**, with optional permission inheritance through `permission_hierarchy`.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Permission** | Atomic capability, named `<module>:<action>` (e.g., `crm:read`, `crm:manage`) |
| **Permission Hierarchy** | `manage` implicitly includes `read` — set up so users don't need both assigned separately |
| **Role** | Named bundle of permissions (e.g., `crm_viewer`, `crm_manager`) |
| **Role Permission** | M:N join: grants a permission to a role |
| **User Role** | M:N join: assigns a role to a user |

---

## Naming Convention

**Always use `<module>:<action>` format:**
- `crm:read` — read access to CRM entities
- `crm:manage` — full write access to CRM entities
- `leads:write` — specific write-only on leads
- `service_catalog:read`

Never use free-form names like `"can_edit"` or `"admin"` — always scope to a module.

---

## Step-by-Step: Full RBAC Setup for a New Module

### 1. Create Permissions

```bash
# Baseline: always create both read and manage
semantius call crud create_permission '{
  "data": {
    "permission_name": "crm:read",
    "description": "Read CRM data",
    "module_id": 3
  }
}'

semantius call crud create_permission '{
  "data": {
    "permission_name": "crm:manage",
    "description": "Create, update, and delete CRM data",
    "module_id": 3
  }
}'
```

### 2. Set Up Permission Hierarchy (optional but recommended)

Make `crm:manage` implicitly include `crm:read`, so assigning `manage` is sufficient:

```bash
semantius call crud create_permission_hierarchy '{
  "data": {
    "parent_permission_id": <crm:manage id>,
    "child_permission_id": <crm:read id>
  }
}'
```

### 3. Create Roles

```bash
# Viewer role — read only
semantius call crud create_role '{
  "data": {
    "name": "crm_viewer",
    "label": "CRM Viewer",
    "description": "Can view CRM data",
    "module_id": 3
  }
}'

# Manager role — full access
semantius call crud create_role '{
  "data": {
    "name": "crm_manager",
    "label": "CRM Manager",
    "description": "Can manage all CRM data",
    "module_id": 3
  }
}'
```

### 4. Grant Permissions to Roles

```bash
# Grant crm:read to crm_viewer
semantius call crud create_role_permission '{
  "data": {
    "role_id": <crm_viewer id>,
    "permission_id": <crm:read id>
  }
}'

# Grant crm:manage to crm_manager (inherits crm:read via hierarchy)
semantius call crud create_role_permission '{
  "data": {
    "role_id": <crm_manager id>,
    "permission_id": <crm:manage id>
  }
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
semantius call crud read_permission '{"filters": "name=ilike.crm:*"}'

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

### Add a permission to an existing role
```bash
semantius call crud create_role_permission '{
  "data": {"role_id": 5, "permission_id": 12}
}'
```

### Remove a permission from a role
```bash
# Find the role_permission record first
semantius call crud read_role_permission '{"filters": "role_id=eq.5&permission_id=eq.12"}'
# Then delete by id
semantius call crud delete_role_permission '{"id": "<id>"}'
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
