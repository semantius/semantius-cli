# CRUD Tools - Tool Structure

## Overview

This directory contains **44 CRUD tools** (Create, Read, Update, Delete) for 11 entities in the PostgREST MCP server.

Each tool is in **its own file** and follows **DRY principles** with **shared schemas** and **utilities**.

## File Structure

**ONE file per tool + shared schemas**:

```
src/tools/
├── schemas/
│   ├── userSchema.ts        ← Shared schema for users
│   ├── fieldSchema.ts       ← Shared schema for fields
│   └── ...                  ← One schema per entity (11 total)
├── create_{entity}.ts       ← Uses shared schema; data = object or array (bulk insert)
├── read_{entity}.ts         ← Query with filters
├── update_{entity}.ts       ← Uses ID (or array of IDs), shared schema
└── delete_{entity}.ts       ← Uses ID (or array of IDs)
```

Bulk helpers live in `src/utils/bulk.ts`:
- `oneOrMany(schema)` wraps an input schema so it accepts one value or a non-empty array
- `keyFilter(column, value)` builds `col=eq.v` for a scalar or `col=in.(v1,v2)` for an array (with PostgREST quoting)
- `bulkInsertOptions(path, data, accept)` adds `?columns=<union of keys>` and `Prefer: missing=default` when `data` is an array, so items may omit different optional keys

## DRY Principles Applied

### 1. Shared Schemas (No Duplication!)
Schemas are defined **once** in `schemas/` and imported by both create and update tools:

```typescript
// schemas/userSchema.ts - SINGLE SOURCE OF TRUTH
export const userSchema = z.object({
  id: z.number().int().optional()...
  external_id: z.string()...
  email: z.string().email()...
  // All fields defined here
})

// create_user.ts - imports shared schema
import { userSchema } from './schemas/userSchema.ts'

// update_user.ts - imports same schema
import { userSchema } from './schemas/userSchema.ts'
// Uses: userSchema.partial() for partial updates
```

**Benefit:** Add a field once, it works in both create and update!

### 2. Shared Response Utility
All tools use `formatSuccessResponse()` from `src/utils/formatResponse.ts`:

```typescript
// Instead of duplicating this 44 times:
return {
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

// All tools use:
return formatSuccessResponse(result.response.data)
```

## Tool Operations

### CREATE Tools
Creates new records using shared schema. `data` is one object or a non-empty array of objects (bulk insert in one request):
```typescript
// Input (single)
{ data: { external_id: "...", email: "..." } }
// Input (bulk)
{ data: [{ external_id: "a", email: "a@x" }, { external_id: "b", email: "b@x", is_disabled: true }] }

// Uses the shared schema from schemas/{entity}Schema.ts
```

### READ Tools
Queries records with **flexible filters** (filters make sense for read):
```typescript
// Input
{ 
  filters: "id=eq.1",           // Optional PostgREST filters
  select: "id,email",           // Optional column selection
  limit: 10,                    // Optional pagination
  offset: 0,                    // Optional pagination
  order: "created_at.desc"      // Optional sorting
}
```

### UPDATE Tools
Updates records by **direct ID** (no complex filters needed). `id` is one value or a non-empty array; the same `data` is applied to every listed record (`update_entity` uses `table_name`):
```typescript
// Input
{
  id: 5,                        // Simple, direct ID (or [5, 6, 7] for several records)
  data: { email: "new@..." }    // Partial update using .partial()
}

// Uses shared schema with .partial() for partial updates
```

### DELETE Tools
Deletes records by **direct ID** (no complex filters needed). `id` is one value or a non-empty array (`delete_entity` uses `table_name`):
```typescript
// Input
{ id: 5 }                       // Simple, direct ID
{ id: [5, 6, 7] }               // Several records in one request (id=in.(5,6,7))

// Explicit keys only, no filter-based multi-record deletes
```

## Entities with CRUD Tools

Each of these 11 entities has 4 tool files (create, read, update, delete):

1. **entities** - Metadata for dynamically created tables
2. **fields** - Metadata for fields in dynamically created tables
3. **modules** - Logical modules that group related roles and permissions
4. **permission_hierarchy** - Defines permission inheritance
5. **permissions** - System permissions that can be assigned to roles
6. **role_permissions** - Many-to-many mapping between roles and permissions
7. **roles** - Groups of permissions that can be assigned to users
8. **user_roles** - Many-to-many mapping between users and roles
9. **users** - External users synchronized from JWT tokens
10. **webhook_receiver_logs** - Log of webhook receiver events
11. **webhook_receivers** - Configuration for webhook endpoints

## Benefits

✅ **Easy to find** - File name = tool name
✅ **DRY schemas** - Define once, use twice (create + update)
✅ **DRY responses** - Unified formatting utility
✅ **Simple CRUD** - Direct ID operations for update/delete
✅ **Flexible queries** - Filters for read operations
✅ **Type-safe** - Full Zod validation
✅ **Easy maintenance** - Single source of truth

## Adding a New Field

When you need to add a new field to an entity:

1. Edit the schema file in `schemas/{entity}Schema.ts`
2. Add the field with its Zod type and description
3. Done! Both create and update tools automatically get the new field

Example:
```typescript
// schemas/userSchema.ts
export const userSchema = z.object({
  // ... existing fields ...
  new_field: z.string().optional().describe('Description of new field'),
})
```

Both `create_user` and `update_user` now support the new field!

## Total Tools

- **44 CRUD tools** (11 entities × 4 operations)
- **11 shared schemas** (one per entity)
- **4 existing tools** (echo, getCurrentUser, postgrestRequest, sqlToRest)
- **48 total tool files** in this directory (excluding schemas)
