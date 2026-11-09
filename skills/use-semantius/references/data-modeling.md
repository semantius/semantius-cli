# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius, the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

This file covers the schema mechanics: modules, entities, fields, relationships, and safe evolution. Two sibling references cover the rule layers: `jsonlogic.md` (`computed_fields`, `validation_rules`, extension operators, cross-entity lookups, dynamic `input_type_rule`) and `select-rule.md` (row-level read security via `select_rule`). Subtypes and extensions (`id_type: is_a` / `has_a`) have their own reference: `entity-families.md`.

## Contents

- [Mandatory Creation Order](#mandatory-creation-order)
- [Modules](#modules)
- [Entities](#entities): naming, built-ins, key fields, auto-generated fields, provenance columns
- [Fields](#fields): naming, formats, `width`, `input_type`, fields that apply only to some enum or boolean values, `unique_value`, `default_value`, `cube_type`, all properties
- [Relationships](#relationships): relationship labels, `reference`, `parent`, junctions, cross-module references
- [Safe Evolution Patterns](#safe-evolution-patterns)
- [Updating and Deleting Entities](#updating-and-deleting-entities)
- [Agent Workflow Tips](#agent-workflow-tips): including full-text search
- [Runtime schema introspection](#runtime-schema-introspection-live-fk--shape-lookup)
- [Tool Priority Rule](#tool-priority-rule), [Entity Reference](#entity-reference-all-managed-tables), [Troubleshooting](#troubleshooting)

---

## Mandatory Creation Order

This section is the single source for the creation order. Other files point here; they do not restate it.

**Always follow this sequence, never skip steps:**

```
Module → Permissions (one call) → update_module (wire permission refs) → Permission hierarchy (one call) → Roles (one call) → Role grants (one call) → update_module (default roles) → ALL Entities (one call; one per level, bases first, with is_a / has_a) → Fields (one call per entity) → update_entity (label_parent, where an entity has one)
```

**Batch every step that writes more than one record of a kind** (Golden Rule 7): both baseline permissions in one `create_permission`, every entity of the model in one `create_entity`, all of an entity's fields in one `create_field`. `data` is an array on every `create_*`; items may have different keys; the response is an array. And **create every entity before any field**: a field's `reference_table` (another entity of the model, or the entity itself) must exist when the field is created, which the entities-first order guarantees — no second pass for cross-references or self-references. `label_parent` is written after the fields (step 8), because the platform checks that the field it names exists.

**Exception: a model with `is_a` / `has_a` entities** creates its entities in **one `create_entity` call per level, bases first**: plain entities and family roots first, then the entities based on them, and so on. The fields still come only after every level exists. A based entity named before its base fails with `23503`. Full rules: `entity-families.md`.
<!-- Family variant: `entity-families.md` → "Creating a family". This block summarizes; that section governs families. -->

1. **Resolve/create module**, `read_module`, then `create_module` if needed (every module gets an `icon_name`, `box` when no icon fits, and it passes `lucide-icon-checker.ts` first; see "Icons are Lucide icons"). The module's id for the later steps comes from `read_module` by `module_slug`, never from the `create_module` response. (Chicken-and-egg: the module's `view_permission` / `manage_permission` are FKs to `permissions.permission_name`, and each request is its own transaction, so they must name permissions that already exist when `create_module` runs. Create the module with the default `user:read` (or no permission reference at all) and wire its own permissions back in step 3.)
2. **Resolve/create permissions**, one `read_permission` with `permission_name=in.(<slug>:read,<slug>:manage,<slug>:admin)`, then one `create_permission` call carrying the missing ones. A hand-built module has all three: `catalog` entities are written at the admin level (see "Classifying an entity" below and `rbac.md` → "Choosing an entity's permissions")
3. **Wire the module's permission references with `update_module`.** `create_module` leaves `view_permission` at the platform default (`user:read`) and `manage_permission` / `admin_permission` null, and `access_scope` at `custom`. Once the permissions exist, point the module at them and set `access_scope` to `advanced` (view, edit and admin), or `gated` when the module has a restricted step (`rbac.md` → "Restricted steps (gates)") — skip this and the module header shows `user:read` and the manage/admin pickers are empty:
   ```bash
   semantius call crud update_module '{"id": <module_id>, "data": {"view_permission": "<slug>:read", "manage_permission": "<slug>:manage", "admin_permission": "<slug>:admin", "access_scope": "advanced"}}'
   ```
   **Mind the column types:** `view_permission`, `manage_permission` and `admin_permission` are all **text** FK columns holding the permission *name* (`<slug>:read`, `<slug>:manage`); write the name directly, there is no permission id to resolve. The default-role columns wire the same way once roles exist, but hold numbers: `default_viewer_role_id` / `default_manager_role_id` / `default_admin_role_id` are numeric role-id FKs (see `rbac.md`).
4. **Create the permission hierarchy**, one `create_permission_hierarchy` call: `<slug>:manage` includes `<slug>:read`, and `<slug>:admin` includes `<slug>:manage` (`rbac.md` → "Set Up Permission Hierarchy").
5. **Create the roles and their grants**, one `create_role` call (viewer, manager and admin, each with `module_id`), then one `create_role_permission` call, then `update_module` to set `default_viewer_role_id` / `default_manager_role_id` / `default_admin_role_id` with ids from `read_role` (`rbac.md` → "Create Roles", "Grant Permissions to Roles").
6. **Create the entities**, one `create_entity` call whose `data` array carries every entity of the model (each with `module_id`, `entity_type`, `view_permission` and `edit_permission`; classify first, see "Classifying an entity" below). First `entity-match-checker.ts` exits 0 (`SKILL.md` → "Before any new entity: compare it with the instance"), then one `read_entity` with `table_name=in.(...)`. Icons first: every entity gets an `icon_name`, unless no icon fits, and they all go through `lucide-icon-checker.ts` in one call before the first `create_entity` (see "Icons are Lucide icons"). Every item carries `entity_type`, `view_permission` and (except on `computed`) `edit_permission`, chosen together from the entity's class and write tier: the platform default `unclassified` is a defect, not a class. Classify without asking, state the result in the summary, and check it with the read-back in "Agent Workflow Tips" → "Verify the class and the permissions after creating entities" (`rbac.md` → "Choosing an entity's permissions" gives the tiers). With `is_a` / `has_a` entities, one call per level instead, bases first (see the exception above). Before this call, run the pass in "Fields that apply only to some enum or boolean values": its validation rules go in this call.
7. **Add fields**, per entity, one `create_field` call whose `data` array carries every domain attribute of that entity (not the auto-generated ones); the FK targets all exist by now. Icons first: every enum and field icon goes through `lucide-icon-checker.ts` in one call before the first `create_field` (see "Icons are Lucide icons"). Each `input_type_rule` from the pass in step 6 goes in this call
8. **Set `label_parent`**, only on an entity whose records are identified through a parent (see `label_parent` under "Key Entity Fields") and never on a junction, with `update_entity` once its fields exist. `create_entity` cannot carry it: the field it names does not exist yet, and the write fails with `90226`. `update_entity` applies one `data` to every listed table, so each different field name is its own call:
   ```bash
   semantius call crud update_entity '{"table_name": "order_lines", "data": {"label_parent": "order_id"}}'
   ```

---

## Modules

Every entity **must** belong to a module.

A module has two name fields with distinct jobs:

- **`module_name`** is the unique, human-facing display name shown in the UI module selector and on the module landing page. Keep acronyms as acronyms (`CRM`, `ITSM`, `CMDB`), this is what users read. Matches the source model's `system_name`.
- **`module_slug`** is the lowercase, URL-safe handle. Optional in the schema (an empty value derives it from `module_name`: lowercased, every run of other characters replaced by `-`, leading and trailing `-` and `_` removed; a name with no ASCII letter or digit derives an empty slug, and a second such module collides), but always pass it explicitly (regex `^[a-z0-9][a-z0-9_-]*$`; lowercase letters, digits, `_`, and `-`, starting with a letter or digit). Used in URLs, in the permission prefix, and by other models that reference this module. Matches the source model's `system_slug` (e.g. `crm`, `itsm`, `ben-admin`). A malformed slug is rejected with `module_slug must be lowercase, start with a letter or digit, and contain only a-z, 0-9, '-' and '_'`.

**Check before creating** (filter on `module_slug` for the URL handle, or on `module_name` for the display name):
```bash
semantius call crud read_module '{"filters": "module_slug=eq.crm"}'
```

**Create module + baseline permissions (always all three, in ONE `create_permission` call):**
```bash
semantius call crud create_module '{"data": {"module_name": "CRM", "module_slug": "crm", "description": "Customer Relationship Management"}}'
semantius call crud create_permission '{"data": [
  {"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>},
  {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>},
  {"permission_name": "crm:admin", "description": "Administer CRM settings", "module_id": <id>}
]}'
```

The `description` field is a compact tagline (≤40 chars) shown beside `module_name` in the selector chip, for acronyms, the plain English expansion (`CRM` → `Customer Relationship Management`); for non-acronyms a 2-4 word disambiguating phrase. Long-form prose belongs elsewhere, not on the module record.

Other optional fields on `modules`: `icon_name`, `domain_code`, `access_scope`, `view_permission`, `manage_permission`, `admin_permission`, `logo_color`, `home_page`, `settings`, `dashboard_config`, run `semantius tools crud create_module` for the full field list. Three of these are top-level module classification columns (set them on `create_module` / `update_module`, not inside `settings`):

- **`icon_name`** — the module's UI icon: a Lucide icon name or an icon URL (see "Icons are Lucide icons" under the Field Format Quick Reference), like an entity's `icon_name`; distinct from the module `logo_url`. The module's `logo_color` has format `color`.
- **`domain_code`** — short uppercase business-domain code the module belongs to (`ATS`, `HCM`, `ITSM`, `CRM`). Groups related modules; many modules — and many `catalog_module_code`s — can share one `domain_code`.
- **`access_scope`**: the permission structure of the module (its access level). `enum_values`: `custom` ("Custom permission structure"), `basic` ("Two permissions: view and edit"), `advanced` ("Three permissions: view, edit and admin."), `gated` ("Three permissions: view, edit and admin and gates on `workflow_state` transitions"), `raci` ("Three permissions: view, edit and admin and enforced process gates"); default `custom`.

Permission naming convention: **always `<module_slug>:<action>`** (e.g., `crm:read`, `crm:manage`). The permission prefix is the slug, not the display name, `crm:read`, never `CRM:read`.

---

## Entities

### Creating an Entity

```bash
semantius call crud create_entity '{
  "data": {
    "table_name": "products",
    "singular_label": "Product",
    "plural_label": "Products",
    "description": "A catalog product available for sale",
    "label_column": "product_name",
    "module_id": 3,
    "view_permission": "catalog:read",
    "edit_permission": "catalog:manage",
    "entity_type": "operational_record",
    "icon_name": "package",
    "audit_log": false
  }
}'
```

Required by the platform: `table_name` and `module_id`. Also pass `entity_type`, `view_permission` and `edit_permission` on every entity: the platform stores `unclassified` and the permission defaults (`public:read`, `admin`) when they are omitted, and the next section says how to choose all three.

### Classifying an entity

Every entity carries a **class** in `entities.entity_type`, and the class decides which permission gates its writes (its **write tier**: the permission level that gates INSERT, UPDATE and DELETE on the entity). Decide the class and the write tier before the `create_entity` call and send `entity_type`, `view_permission` and `edit_permission` together in the same payload. The platform default `unclassified` means nobody classified the entity; it is never a choice, and an entity left there is a defect to fix.

Classify without asking the user: say the result in the summary after the create (one line per class, each with its write tier in plain words, e.g. "catalog: only admins can add or edit"), and change it with `update_entity` when the user disagrees.

| `entity_type` | What it holds | Typical examples |
|---|---|---|
| `catalog` | Reference or setup data that administrators maintain and operational records point at | cost_centers, product_categories, lead_sources |
| `operational_workflow` | Everyday records with a **gated step**: an approval, an enforced transition or a step only some users may take | purchase_requests, offers, tickets that only a manager may close |
| `operational_record` | Everyday records with no gated step, created and edited freely | invoices, subscriptions, budgets, notes |
| `junction` | A pure connecting record between two or more entities, with no attributes or lifecycle of its own | product_tags, user_roles |
| `computed` | Every field is derived; nothing writes it directly | reporting tables |
| `unclassified` | Never a choice: the platform default for an entity nobody classified | |

**Choose in this order; the first match wins:**

1. **Connecting record.** Two or more `parent` relationships (a binary or an N-ary one), no attributes of its own, no lifecycle → `junction`. One that carries its own attributes or a lifecycle is an association class → `operational_record` or `operational_workflow`, never `junction`.
2. **Everything derived**, no direct writes → `computed`.
3. **Base of a family** (other entities are `is_a` / `has_a` based on it; see `entity-families.md`) → never `catalog`, however small. `operational_workflow` when it has a gated step, otherwise `operational_record`. `business_partners`, the base of `customers` and `suppliers`, is an `operational_record`.
4. **Reference data** → `catalog` when **all three** hold: small and slowly changing (hundreds of rows at most, edited a handful of times a month); operational entities point at it as a lookup, category, stage, type or source (it is pointed *at*, it does not point outward at operational data); and it usually ships with seeded values decided once.
5. **Gated step** → `operational_workflow`. A gate is a step that needs its own permission (`rbac.md` → "Restricted steps (gates)"). A single gated step (`draft` → `submitted`) is enough, and the number of states is irrelevant. A `status` enum alone is not a gate: without a step that only some users may take, the entity is an `operational_record`.
6. **Otherwise** → `operational_record`.

An entity the module exists to hold (the inventory its users add to every day, such as the applications in a SaaS management module) is never a `catalog`, whatever its size: a `catalog` is written to only by admins, so classifying the main working dataset as one stops the module's managers from adding to it.

Classify from the entity's purpose, not its name: a `budget` is an `operational_record`, a `budget_category` is a `catalog`. The platform built-ins (`users`, `roles`, `permissions`) are already classified; never recreate them.

**Write tier and permissions.** The class gives the write tier, and `rbac.md` → "Choosing an entity's permissions" turns the tier into the entity's `view_permission` and `edit_permission`:

| `entity_type` | Write tier |
|---|---|
| `catalog` | `:admin` |
| `operational_workflow` | `:manage` |
| `operational_record` | `:manage` |
| `junction` | `:manage`; `:admin` only when every parent leg is a `catalog` |
| `computed` | `:read` (nothing writes it; omit `edit_permission`) |

**Rules**
- A `junction` is classified in the `create_entity` call that creates it (its `parent` fields come later, with the other fields), never afterward. The platform also treats an entity with two or more `parent` fields and no payload as a junction whatever its class, so classify a pure connecting record `junction`.
- `entity_type` is metadata, not a key: fix a wrong or missing class with `update_entity` (an array of `table_name`s takes the same value; the label function is rebuilt, no data is lost), then re-check the entity's `edit_permission` against the new tier.
- Never `create_field` it; it is a core column.
- The adjacent write-once column `catalog_entity_code` is set only for an entity that realizes a catalog identity; leave it empty for entities built outside the deploy pipeline. `singular` is derived from `table_name` when blank, and `plural` is always set to `table_name`, so pass neither.

### Entity Naming Rules

- **`table_name` is always plural snake_case**, `products`, `orders`, `order_lines`, not `product`, `order`, `orderLine`
- **Name the concept in full.** A singular noun that explains itself; `table_name` is its plural. `support_request` → `support_requests`, `sales_opportunity` → `sales_opportunities`, not `ticket` or `opp`.
- **Never end a `table_name` in `_ext`.** `<table_name>_ext` is the storage table of an `is_a` / `has_a` entity, so the platform reserves it (`90250`); see `entity-families.md`.
- **Never create a `users` entity**, Semantius has a built-in `users` table. Any module that needs to reference users must use `reference_table: "users"` pointing at the existing table. Creating a competing `users` or `user` entity will conflict with the built-in table and break authentication.
- **Never create a second entity for something the instance already holds**, under any name or prefix. `table_name` identifies an entity across the whole instance, not per module. Compare first: `SKILL.md` → "Before any new entity: compare it with the instance".

### Semantius built-in entities: shapes

The platform ships with built-in tables for authentication, RBAC, and integration. **Domain models reference these by `table_name`, never recreate them.** If a domain genuinely needs an extra field on a built-in (e.g. `users.job_title`), add it via `create_field` after dedup. Never modify or rename existing built-in fields, never change their formats, never replace built-in entities.

#### `users` — authenticated principals

| Field | Format | Notes |
|---|---|---|
| `id` | int64 | PK |
| `external_id` | text NOT NULL | Identifier from the auth provider (IdP) |
| `email` | email | The user's email (login identifier); default `''` |
| `display_name` | text | Human-readable name shown across the UI (use this — NOT `name`, `full_name`, `user_name`); default `''` |
| `first_name` | text | Given name, filled from the JWT `given_name` claim |
| `last_name` | text | Family name, filled from the JWT `family_name` claim |
| `is_agent` | boolean NOT NULL | TRUE for a service principal (agent) rather than a person; default FALSE |
| `is_disabled` | boolean | True when the account is suspended; default FALSE (inverse of "is_active" — use this name, not `is_active` or `is_enabled`) |
| `settings` | json | Per-user preferences blob |
| `last_seen` | date-time | Last activity timestamp |
| `created_at` / `updated_at` | date-time | Auto |

**Common author mistakes when extending `users` (the deployer skips these as overlapping with built-ins):**

| Don't add | Reason |
|---|---|
| `name`, `full_name`, `user_name` | Use existing `display_name`. |
| `given_name`, `family_name`, `surname`, `first_name`, `last_name` | Use existing `first_name` / `last_name`. |
| `is_agent`, `is_bot`, `is_service_account` | Use existing `is_agent`. |
| `is_active`, `active`, `enabled`, `is_enabled` | Use existing `is_disabled` (inverted semantics, same concept). |
| `username`, `login` | Use existing `email`. |
| `preferences`, `config` | Use existing `settings` json. |
| `disabled_at`, `deactivated_at` | Use `is_disabled` + audit log; no separate timestamp. |

**Legitimately additive fields a domain may want:** `primary_team_id` / `department_id` / `manager_id` (FKs to domain entities), `job_title` (text), `employee_id` (text, external HRIS reference). These don't overlap with built-in fields and should be added.

#### `roles` — RBAC roles, system-managed slugs

| Field | Format | Notes |
|---|---|---|
| `id` | int64 | PK |
| `role_name` | text NOT NULL | Human-readable display name (e.g. `"CRM Manager"`) |
| `slug` | text NOT NULL UNIQUE | Stable snake_case handle (e.g. `crm_manager`); acts as a natural-key second primary key. **Regex `^[a-z0-9_]+$` — underscores only, NO hyphens.** This differs from `module_slug` (`^[a-z0-9][a-z0-9_-]*$`, which DOES allow hyphens): when you build a role slug from a hyphenated module slug, convert `-`→`_` (module `ben-admin` → role `ben_admin_manager`, never `ben-admin_manager`). A hyphen fails the regex. |
| `description` | multiline | What this role does |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. Set by whoever creates the role; default `user`. |
| `module_id` | reference → modules | Which module owns the role |

> **Origin semantics.** `system` rows are platform built-ins (seeded at database init; only their `origin` and `slug` are locked). `model` rows are created by a spec deploy on a domain module's scaffold. `model_master` rows are scaffold roles on a master module (see master-data promotion design). `user` rows are admin-created via the UI/API. **Slug rename is permitted for `model` / `model_master` / `user`; locked for `system`.**

#### `permissions` — RBAC permissions, natural-key by name

| Field | Format | Notes |
|---|---|---|
| `permission_name` | text PK | Code in form `<module_slug>:<action>` (e.g. `crm:read`). The primary key (there is no numeric id): every other table names a permission by it, and `update_permission` / `delete_permission` are keyed by it |
| `description` | multiline | What this permission grants |
| `module_id` | reference → modules | Owning module |

#### `permission_hierarchy` — RBAC inclusion graph

| Field | Format | Notes |
|---|---|---|
| `id` | text PK | Generated as `"<including>.<included>"` (e.g. `"crm:manage.crm:read"`) |
| `including_permission_name` / `included_permission_name` | both → permissions (by name) | Reads as `including_permission_name` *includes* `included_permission_name`. Holding the broader (including) permission transitively grants the narrower (included) one. |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. |

#### `user_roles`, `role_permissions` — junctions

`user_roles` carries `user_id` / `role_id` (both numeric) plus `assigned_at` / `assigned_by`, with a text `id` of `"<user_id>.<role_id>"` (e.g. `"1001.1"`). `role_permissions` carries `role_id` (numeric) / `permission_name` plus `granted_at` / `granted_by`, with a text `id` of `"<role_id>.<permission_name>"` (e.g. `"1.user:read"`). Don't redeclare; reference via FK from your domain entities only if you need to surface RBAC state in a domain query.

#### `webhook_receivers`, `webhook_receiver_logs` — inbound HTTP intake

Used by the integration runtime; domain models almost never touch these.

#### `modules`, `entities`, `fields`, `queues`, `queue_table_events`, `dashboards`

Platform meta-schema. **Never declare in a domain model.** The deployer manages these as a side effect of `create_entity` / `create_field` / `create_module`.

### Key Entity Fields

| Field | Notes |
|-------|-------|
| `table_name` | **Plural** snake_case. Renaming is supported but think twice: integrations, saved queries, and external consumers reference the entity by name. |
| `singular_label` | Human-readable name for **one record** (e.g. `Product`). Must be grammatically symmetric with `plural_label`, if `plural_label` is "Products", this must be "Product", never "Product Name". Pass it: when blank it is derived from `label_column` (`product_name` becomes "Product Name"), which is not a singular noun. Field-level titles like "Product Name" belong on the label field (the field named in `label_column`), not here (see Customizing the label field's title below). |
| `plural_label` | e.g. "Products" |
| `label_column` | Snake_case **field name** that identifies a record (e.g. `product_name`). NOT a human-readable title. Optional on `create_entity`: set it on every entity that has a natural local label; omit it for a junction table, whose `_label` the platform composes from the parent legs (see "Junction tables" below). Never set it on an `is_a` / `has_a` entity: it comes from the base (on create the platform overwrites it; an update is refused with `90242`). **Always single-line text:** `create_entity` creates this field as `text`, and as a core column its format can never change afterward (`90219`), so a label column is never an `enum`, number, date, boolean or FK. When the only identifying attribute is a type or category, pick another text field, or on a junction omit `label_column`. |
| `module_id` | Required on `create_entity` — must be a valid (non-null) integer module id; `null` is rejected. Find with `read_module`. On `update_entity` it stays optional, but a provided value must still be a non-null integer. |
| `entity_type` | **Required on every entity you create:** `catalog`, `operational_workflow`, `operational_record`, `junction` or `computed`. The platform default `unclassified` is never a choice. See "Classifying an entity" above. Optional on `update_entity`, where a provided value must be one of the six allowed values. |
| `view_permission` | Name string (e.g. `"catalog:read"`); defaults to `public:read` when omitted, so set it deliberately. The permission must already exist |
| `edit_permission` | Name string (e.g. `"catalog:manage"`); defaults to `admin` when omitted, so set it from the entity's write tier (`rbac.md` → "Choosing an entity's permissions"), except on a `computed` entity, where you omit it. The permission must already exist. Gates INSERT, UPDATE and DELETE alike; there is no separate delete permission. To restrict one operation (e.g. only some roles may delete), add a `validation_rules` entry that tests `$mode` (see `jsonlogic.md`, *Detecting the operation*). |
| `id_type` | Optional key type, **set on create and locked afterward**: changing it is refused with `90233`, so omit it on `update_entity`. `auto_increment` (default when omitted): a 64-bit number the database assigns. `bigint`: a 64-bit number the caller supplies on every insert. `text`: a text key the caller supplies. `uuid`: a time-ordered UUIDv7 the database assigns. `typeid`: a prefixed, sortable TypeID such as `acct_01h455vb4pex5vsknk084sn02q`, assigned by the database; requires `id_prefix`. `is_a` / `has_a`: a subtype or an optional extension of another entity, sharing its key; requires `id_refentity` (and `id_prefix` for `is_a`); see `entity-families.md` before choosing either. `computed`: system tables only, refused for a new entity (`90234`). A key type missed at create means rebuilding the entity, so decide it up front: `typeid` suits ids that users or other systems see, `auto_increment` internal tables. |
| `id_prefix` | TypeID prefix: required when `id_type` is `typeid` or `is_a`, empty otherwise. Up to 63 lowercase letters and underscores, starting and ending with a letter (e.g. `acct`), **unique among entities**. A `typeid` prefix may be changed later: new ids take the new prefix, existing ids keep theirs, and an id with a former prefix can no longer be inserted. An `is_a` prefix never changes (`90245`), and a new `is_a` entity cannot take a prefix that records of its root still carry, such as one the root used before (`90254`). |
| `id_refentity` | Only with `id_type` `is_a` / `has_a`, and then required: the `table_name` of the base this entity is based on. `is_a` needs a managed `typeid` or `is_a` base; `has_a` a managed `typeid` base (`90240`). Set on create only; never send it on `update_entity` (`90241`). See `entity-families.md`. |
| `id_column` | Leave it unset: the key field is `id`. Like `id_type`, it is fixed on create; an update that changes it fails with `90253`. |
| `managed` | Optional, default `true`. When `false`, automatic DDL for table and field changes is disabled: use it only for external or legacy tables whose DDL is managed outside the platform. |
| `order_column` | Optional. Names an integer field that stores a fixed row order (drag-and-drop). Setting it creates the column, and an insert that sends no value gets the highest value below 900000 plus 10 (10 for the first record). Not available on an `is_a` / `has_a` entity (`90249`). |
| `icon_name` | The icon shown for the entity in the UI: a Lucide icon name in kebab-case or an icon URL (see "Icons are Lucide icons" under the Field Format Quick Reference). Every entity gets one, unless no icon fits. |
| `name_sort` | Optional text sort key that orders entities in navigation. Leave it unset unless the user wants a specific navigation order. |
| `edit_mode` | Optional. Controls how records open for editing: `auto` (default, system decides), `sidebar`, `modal`, or `page`. Set only when the user has a specific UX requirement. |
| `cube_mode` | Optional. OLAP cube generation: `auto` (default, include in cube) or `disabled`. Set to `disabled` to exclude the entity from cube queries. |
| `audit_log` | Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value. |
| `label_parent` | Optional. Names the **one** FK field that is this entity's identity spine — the parent whose composed `_label` prefixes this record's `_label`. Must name a `reference`/`parent` FK; must **not** reference its own entity (`90228`), must **not** target a junction and must **not** be set on a junction or on an `is_a` / `has_a` entity (it comes from the base: overwritten on create, an update is refused with `90242`). Omit for self-identifying records (then `_label` is just the local label). Never on `create_entity`: set it with `update_entity` after the fields exist ("Mandatory Creation Order", step 8). |

### Auto-Generated Fields: NEVER Create These Manually

When `create_entity` is called, the system automatically creates:

| Field | `ctype` | Notes |
|-------|---------|-------|
| `id` | `id` | Primary key (`is_pk: true`), typed by the entity's `id_type`: format `int64` for `auto_increment` and `bigint`, `text`, `uuid`, or `string` for `typeid`, `is_a` and `has_a`. An entity has exactly one `is_pk` field; a second one is refused (`90215`). **Never** create it with `create_field` |
| `<label_column>` | `label` | The actual named field (e.g. `product_name`), created as `text` with the title `Name`. Its format is locked (`90219`); it may be renamed and its default value may be changed (the default of every other core column is locked, `90220`) |
| `created_at` |, | Timestamp, auto-maintained |
| `updated_at` |, | Timestamp, auto-maintained |
| `_label` | `_label` | **Composed label** — the record's full human-readable label, folded from its parent chain (spine → … → local `label`). Read-only, read-time; **not** in the `fields` catalog. |
| `<fk>_label` | `fk_label` | Companion of every `reference`/`parent` FK named `X` → `X_label` = the referenced row's composed `_label` (e.g. `customer_id` → `customer_id_label`). Read-only, read-time; **not** in the `fields` catalog. |

> ⚠️ Calling `create_field` for any of these will fail or create duplicates.

**`ctype` marks what kind of column a field is.** It is derived, never sent: a value sent on create is ignored, and changing it on update fails with `90214`.

| `ctype` | Meaning | Protected |
|---|---|---|
| empty | Ordinary field | no |
| `id` | Primary key | yes |
| `label` | Display label | yes, but it may be renamed and its default value changed |
| `audit` | `created_at` and `updated_at` | yes |
| `core` | Other system columns | yes |
| `rollup` | Value aggregated by the database from the field's `rollup` definition (see `rollup-fields.md`) | no |
| `computed` | Value written by one of the entity's `computed_fields` rules | no |

A protected column cannot be deleted (`90217`) or renamed (`90218`), and its format (`90219`) and default value (`90220`) cannot change; the label column is the exception for renaming and for its default value. A `rollup` or `computed` field can still be renamed, deleted, or moved to another format with the same column type; `get_schema` reports these two with `is_core: false`.

> ℹ️ An `is_a` / `has_a` entity gets only `id`, `created_at` and `updated_at`. Its label field, and every other field of its base, are the base's, so create only the entity's **own** fields; a name that repeats a base field fails with `90243`. See `entity-families.md`.

> ℹ️ **`_label` / `<fk>_label` are platform-owned, read-only, read-time projections.** They are absent from the `fields` catalog (`read_field` never returns them) and are **not user-creatable**. Their names are deterministic, so agents select them by the naming convention — e.g. `select=id,_label,customer_id_label` — with **no discovery call**. Never `create_field`, write, or import into them.

> ℹ️ `searchable` and `is_child` on the entity are **read-only** and computed automatically. `searchable` becomes `true` when any field has `searchable: true`; `is_child` becomes `true` when any field uses `format: "parent"`. Never set these manually.

### Platform provenance / meta columns (core-provided; stamp VALUES only, never create)

The base schema ships a set of **core provenance columns** on `entities`, `fields`, `modules`, and `roles`. They are **registered by core with `ctype = 'core'`** — there is **no `is_core` boolean**; `is_core` is *derived* (true unless `ctype` is empty, `rollup` or `computed`) and still surfaces in `get_schema()`, so anything reading `is_core` keeps working. Every column is **NOT NULL with an empty default** (`''` for text, `'{}'` for a json object, `'[]'` for a json array, `'unclassified'` for the `entity_type` enum); "absent" is the empty value, never SQL `NULL`.

| Table | Column | Type / default | Meaning |
|---|---|---|---|
| `entities` | `catalog_entity_code` | TEXT `''`, non-unique | Canonical uber-model code (the rename / dialect / silo join key). `table_name` holds the deployed name and may drift; this does not. Empty = created outside the deploy pipeline. |
| `fields` | `catalog_field_code` | TEXT `''`, non-unique | Stable design-time field identity (the blueprint field name, e.g. `status`); the field-rename join key, and the field-level twin of `catalog_entity_code`. `field_name` holds the deployed name and may drift; this does not. Empty = not generated from a catalog spec. |
| `entities` | `catalog_owner_module` | TEXT `''` | Owning-module slug for an `embedded_master` placeholder. Soft pointer, not an FK. |
| `entities` | `entity_type` | TEXT `'unclassified'`, CHECK ∈ 6 (`operational_workflow` / `operational_record` / `catalog` / `junction` / `computed` / `unclassified`) | Data-class axis; the write tier derives FROM it. Set it on every `create_entity` (see "Classifying an entity"). |
| `entities` | `catalog_entity_aliases` | JSONB `'[]'`, array | Append-only `{alias_code, source_domain, source_module, decided}` reuse/merge records. |
| `modules` | `catalog_module_code` | TEXT `''`, non-unique | Catalog blueprint / `system_slug` the module was provisioned from. The coarser business-domain grouping is the separate `domain_code` column (many `catalog_module_code`s can share one `domain_code`). |
| `roles` | `catalog_role_code` | TEXT `''`, non-unique | Catalog persona the role was provisioned from. |

`use-semantius` exposes no tool to look up or install a catalog blueprint. A module built here is built by hand, and its catalog codes stay empty (`''`) unless a spec deploy stamps them. Do not search for a catalog or deploy tool, and do not invent a `catalog_*_code` value.

**Rules for every skill that writes the catalog:**

- **Never `create_field` these columns** — core provides them. Stamp **values only**: a spec deploy stamps the catalog codes and aliases at provision time, and every `create_entity` sets `entity_type` itself.
- **Never write `ctype`** — it is privilege-locked. There is nothing to set to mark a column "core"; that is core's job.
- The scalar codes (`catalog_entity_code` / `catalog_field_code` / `catalog_module_code` / `catalog_role_code`) are **write-once**: set on create, or filled once while empty, then never changed; a later rename touches `table_name` / `field_name` / `module_slug` only. `catalog_entity_aliases` is **append-only** (never rewrite or drop prior elements).
- Test emptiness as `= ''` / `= '{}'::jsonb` / `= '[]'::jsonb` / `= 'unclassified'`, **never `IS NULL`**.

### Customizing the label field's title

The title of the auto-created label field (the field named in `label_column`) is always `Name`, whatever `singular_label` says. If the record's identifying value is more specific than the entity name, follow up with `update_field` on the `<label_column>` field to set its `title`. Example: an entity `cars` where each record is identified by its license plate, keep `singular_label: "Car"` / `plural_label: "Cars"` (symmetric), then update the title of the `license_plate` field (the entity was created with `label_column: "license_plate"`) to `"License Plate"`. See "Updating and Deleting Entities" below for the `update_field` call shape. Do **not** smuggle the field-level title into `singular_label` (e.g. `"Car License Plate"`), that breaks plural/singular symmetry and propagates "Name"/"License Plate" into every UI surface that renders the entity name.

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries optional `computed_fields` / `validation_rules` JSON arrays
(default `[]`; set on `create_entity`, replaced wholesale on `update_entity`: send the full list, a partial list deletes the rest)
that derive values and enforce invariants on every write. Caller-supplied values
for a computed field are silently overwritten.
→ Full reference (evaluation semantics, reserved variables, platform-extension
operators, cross-entity lookups): `jsonlogic.md`.

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity carries a `select_rule` JsonLogic object (default `{}`); when non-empty it
drives a per-row `FOR SELECT` RLS policy. **A non-empty rule REPLACES `view_permission`
for reads — a rule without a `has_permission` disjunct locks out admins.** The same
predicate is also AND-ed into the `UPDATE` / `DELETE` row filter (`edit_permission` AND
rule), so it constrains which rows can be modified, not only read. Adding, modifying,
or removing a rule is medium-risk.
→ Full reference: `select-rule.md`.

---

## Fields

> ⚠️ **The #1 field-creation trap: there is no `required` column.** To make a field mandatory, set **`input_type: "required"`** — never `"required": true`. To make it unique, set **`unique_value: true`**. Sending a `required` key to `create_field` fails: the live tool schema has no such field (confirm any time with `semantius tools crud create_field`). Likewise **never send `is_nullable`** — the platform computes nullability from `format`. These are the most common "wrote it from memory" errors; the rest of this section gives the full property list.

### Field Naming Rules

- **snake_case, descriptive, no abbreviations:** `customer_email_address`, not `cust_email`.
- **Include the noun the field describes:** `invoice_total_amount`, not `total`.
- **A field that holds a relationship is `<target_singular>_id`, or names the record's part in the relationship and ends in `_id`:** `account_id`, `assigned_user_id`, `parent_case_id`, `manager_id`.
- **Fixed names win:** the lifecycle state field is `workflow_state` (see `default_value` below); reserved names are in the 🛑 note under "Field Format Quick Reference".
- **Only when the user asks to follow a product's names** (to move data to and from it): spell each name the way the product does and convert it with `vendor-names.ts` (`SKILL.md` → Reference Files), never by hand. When your knowledge of the product falls short, read its own API or data-export reference, and use only names those pages confirm.

### Field Format Quick Reference

Choose `format` carefully. Format **can** be changed after creation on a managed entity, but **only to a format that maps to the same physical Postgres column type**. Such transitions are allowed (`text → multiline → html`, all `TEXT`); any other is refused with `90223` (`text → date`, `integer → number`, `int32 → int64`, `date → boolean`): drop and recreate the field instead. The mapping is visible in the format-to-type table later in this reference (under `default_value`). A reference takes the type of the key it points at, so `text → reference` of a TEXT-keyed entity is allowed. **Core columns are the exception:** a field with a core `ctype` (the key, the label column, `created_at` / `updated_at`) never changes format, not even to a format with the same type (`90219` "Cannot change format of core system field"), and its default value is locked too (`90220`), except the label column's. So a label column can never become an `enum`, even though both are `TEXT`. Still pick the format deliberately on the first pass: a later change re-renders the form (input shape) and may require republishing UI surfaces, even though the column data survives.

| Category | `format` values |
|----------|----------------|
| Text | `string`, `text`, `multiline`, `html`, `code` |
| Numbers | `integer`, `int32`, `int64`, `number`, `float`, `double`, use `number` (stored as `NUMERIC(18, scale)`) for all monetary/currency/amount fields (`price`, `cost`, `amount`, `total`, `balance`, `revenue`, `fee`, `rate`, `salary`, `budget`, `discount`). Pair with `precision` (digits after the decimal; default `2` suits money, set `4`–`6` for tax/FX rates, `0` for integer-like NUMERIC counts). `float`/`double` are binary IEEE-754 and lose cents on rounding, only use them when the user explicitly requests them or the value is inherently imprecise (scientific measurements, ML scores, GPS coordinates) |
| Dates/Time | `date`, `time`, `date-time`, `duration` |
| Boolean | `boolean` |
| Choice | `enum` (also set `enum_values`: each entry is a value or a `{"value", "label"}` object that may also carry an optional `description`, `color` and `icon`, e.g. `[{"value": "draft", "label": "Draft", "color": "#64748b"}, {"value": "on_hold", "label": "On hold", "color": "#f59e0b"}]`; see "Enum values and labels" below) |
| Display | `color` (an HTML color), `icon` (a Lucide icon name or an icon URL, see below), `rating` (an integer 0–5, `0` = not rated; use for star ratings and 5-point scores, never for general integers) |
| Structured | `json`, `object`, `array`, `jsonlogic` |
| Identifiers | `uuid`, `email`, `uri`, `url` |
| Binary | `binary` (stored as `BYTEA`) |
| Other text formats | `jsonata`, `password`, `uri-reference`, `iri`, `iri-reference`, `uri-template`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `regex`, `json-pointer`, `json-pointer-uri-fragment`, `relative-json-pointer`, `byte` |
| Cross-entity relationship (independent) | `reference` + `reference_table` |
| Ownership/composition | `parent` + `reference_table` |

> ℹ️ **The other text formats are plain `TEXT` columns.** Each one chooses the form control; the database does not check the shape of the value. `password` only masks the input: the value is not hashed and reads return it like any other field, so never describe it as secure storage.

> ℹ️ **Colors are written as hex.** A `color` field, the `color` of an enum entry and a module's `logo_color` accept any HTML color; write lowercase `#rrggbb` (e.g. `#22c55e`). A value read back from the platform is kept as it is.

> ℹ️ **Icons are Lucide icons.** An `icon` field, the `icon` of an enum entry and the `icon_name` of a module or entity take a Lucide icon name in kebab-case (e.g. `circle-check`, `users`, `shopping-cart`; never the PascalCase React component name `CircleCheck`), or an icon URL. The UI always uses the latest Lucide release, so every current icon is available. Find a name by running `bun "<skill-folder>/references/lucide-icon-finder.ts" <query…>` once, with up to five queries for the meaning, most specific first (`"user plus" user person "contact card"`; a query of several words matches only icons that have them all), and take the first icon, in that order, that fits the meaning. If none fits, an enum entry and an entity get no icon and a module icon is `box`. Confirm names with `bun "<skill-folder>/references/lucide-icon-checker.ts" <name…>` (exit 1 names the unknown ones; a URL always passes). Every icon a skill writes passes the checker. From another skill the folder is `"<skill-folder>/../use-semantius/references/"`. Both scripts need no network: they read `lucide-icon-tags.json`, a snapshot of a Lucide release bundled next to them, so an icon added to Lucide after that release is reported unknown, as is a deprecated Lucide alias such as `building-2` (use `building-complex`); pick another name.

> 🛑 **Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. Never combine `reference_table` with scalar formats (`integer`, `uuid`, `string`, etc.). This will always fail.**

**Picking between text formats.** All five resolve to a Postgres `TEXT` column; the format selects the UI input shape. Because they share a primitive, the format **can be changed among them after creation** — `text → multiline → html` is safe and accepted by `update_field`. The choice still matters up front because flipping later re-renders the form and may force a UI republish. Cross-primitive changes (e.g. `text → date`) are rejected by the platform.

- `string` and `text` are **single-line** inputs — names, titles, labels, email-like identifiers, short tags. The form renders a single-line `<input>`. Use these for any field that holds a short value displayed on a single row.
- `multiline` is the **multi-line** input — descriptions, notes, comments, free-form prose, journal entries, scorecard commentary. The form renders a `<textarea>`. Pick `multiline` whenever the field holds prose the user might paste a paragraph into; pick `text` / `string` when the value is a single line. The distinction lives in the column metadata, so the choice is made up front and migrating between them later means dropping and recreating the field.
- `html` renders a rich-text editor on top of HTML storage; reserve for fields that need formatted output (release notes, marketing copy).
- `code` renders a monospace code editor; reserve for stored source / configuration snippets.

Heuristic: field names like `*_name`, `*_title`, `*_label`, `*_code`, `*_id` (string identifier), `email_address`, `phone_number`, `url` → single-line (`string` or `text`). Field names like `description`, `notes`, `body`, `comment`, `concerns`, `strengths`, `feedback`, `summary`, `details`, `rationale`, `instructions` → multi-line (`multiline`).

> 🛑 **Reserved field names.** A `field_name` must **not** start with `_` (reserves the entity's own `_label`); the platform rejects it on create and on rename (`90224`). A name ending in `_id_label` is accepted, but it shadows the generated `<fk>_label` companion of the FK `<fk>` when both exist, so avoid it. Plain `*_label` names (e.g. `status_label`) remain allowed.

### `width` Values

| Value | Use |
|-------|-----|
| `default` | **Default, always use this** unless a specific layout requirement exists |
| `s` | Small (short text, booleans, status badges) |
| `m` | Medium |
| `w` | Wide (long text, descriptions) |

### `input_type` Values

| Value | Meaning |
|-------|---------|
| `default` | Standard editable input, use for most fields |
| `required` | Editable and mandatory, enforced by the platform, not only in the UI |
| `readonly` | Displayed but not editable, **never import into this** |
| `disabled` | Grayed out, not editable, **never import into this** — this is the canonical mode for **computed fields** (platform owns the value, caller payloads are silently overwritten on every write; see `jsonlogic.md`) |
| `hidden` | Not shown in forms |

> ℹ️ The composed-label columns `_label` / `<fk>_label` are **always** platform-owned and read-only regardless of `input_type` — they are read-time projections, never authored fields, so this table does not apply to them. Never write or import into them.

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` JsonLogic object that overrides the
static `input_type` per record at form-render time. UI-only and fails open — a field
rendered `hidden` / `readonly` is still writable via API; server-side enforcement
belongs in `validation_rules` (see `jsonlogic.md`). A non-empty rule also removes the
database check of `required` for that field, because the rule can turn `required` off per record.
Use it whenever a field's input mode depends on the record: required, readonly, disabled or hidden in some states and editable in others (for example `rejection_reason` editable only while `status` is `rejected`: the rule returns `default` in that state and `readonly` otherwise). The `input_type_rule` only shapes the form, so also add a `validation_rules` entry on the entity that enforces the same condition for every caller, unless the user says the restriction is cosmetic. For `rejection_reason`: `{"code": "99010", "name": "rejection_reason_only_when_rejected", "message": "A rejection reason can be set only while the request is rejected.", "jsonlogic": {"if": [{"value_changed": "rejection_reason"}, {"==": [{"var": "status"}, "rejected"]}, true]}}`, and the field's `input_type_rule` is `{"if": [{"==": [{"var": "status"}, "rejected"]}, "default", "readonly"]}`. Read a field with `{"var": "<field>"}`, never as a bare string.
→ Full reference: `jsonlogic.md`.

### Fields that apply only to some enum or boolean values

A required pass before the write, in a build and whenever a field, an enum or a boolean is added to an entity. For every `enum` and `boolean` of the entity, `workflow_state` first, name the fields that make sense only for some of its values: `sold_date` and `sale_price` when the record is `sold`, `rejection_reason` when it is `rejected`, `recurrence_interval` when `is_recurring` is on. A field that applies to every value, or that is useful before the value is reached (`target_close_date`), stays plain. List every value where the field applies, later states included: `approved_at` still applies once the record is `closed`.

Each such field gets an `input_type_rule`, by how it is filled in those values. Its static `input_type` stays `default`, never `required`.

| In those values the field is | The rule returns there | The rule returns otherwise | Validation rule |
|---|---|---|---|
| Needed, filled in by the user | `required` | `hidden` | Yes |
| Optional, filled in by the user | `default` | `hidden` | No |
| Filled by a `computed_fields` rule | `readonly` | `hidden` | No |

The rule is `{"if": [{"==": [{"var": "workflow_state"}, "sold"]}, "required", "hidden"]}`, or with several values `{"if": [{"in": [{"var": "workflow_state"}, ["approved", "closed"]]}, "readonly", "hidden"]}`, or on a boolean `{"if": [{"==": [{"var": "is_recurring"}, true]}, "required", "hidden"]}`.

An `input_type_rule` never blocks a write, so the validation rule on the entity is what refuses a missing value. Write one per set of values, naming every field needed there, guarded with `$mode` so a record written before the rule can still be deleted. A new entity carries it on `create_entity`; an existing one takes `update_entity` with its full list. Hiding needs no validation rule: a value left behind when the record moves on stays stored, and a form cannot clear a hidden field.

What counts as empty depends on the format, because only three formats can be `NULL` (see "`default_value`"):

| Format | Empty value | The value is set when |
|---|---|---|
| `date`, `date-time`, `reference` | `NULL` | `{"!=": [{"var": "<field>"}, null]}` |
| `number`, `float`, `double`, the integer formats, `rating` | `0` | `{"!=": [{"var": "<field>"}, 0]}` |
| Text formats and `enum` | `''` | `{"!=": [{"var": "<field>"}, ""]}` |

A needed number for which 0 is a real value and a needed `boolean` cannot be told from empty, so they stay out of the validation rule. Worked example: `jsonlogic.md` → "Dynamic `input_type` via `input_type_rule`".

### `unique_value`

Set `unique_value: true` only when duplicates would cause data integrity issues (e.g., `email` on contacts, external system keys).

It creates a partial unique index: for string formats, `NULL` and `''` are exempt, so any number of records can leave the field empty. To refuse an empty value as well, set `input_type: "required"`.

> ⚠️ Adding `unique_value: true` to an **existing** field is medium-risk, will fail if duplicates exist. Warn the user and suggest deduplication first.

### `default_value`: auto-filled by the platform; authors only override

When `default_value` is blank, the column-add trigger gives a NOT NULL column the zero value of its type, chosen by `format`:

| Format | PostgreSQL type | Auto-default when `default_value` is blank |
|---|---|---|
| `string`, `text`, `multiline`, `email`, `url`, `color`, `icon`, …  | `TEXT` | `''` |
| `int32`, `int64`, `integer` | `INTEGER` / `BIGINT` | `0` |
| `rating` | `INTEGER` | `0` (not rated). The database does not check the 0–5 range (a client library does) and refuses only `0` on a required rating; a required rating needs a value from 1 to 5 |
| `number` | `NUMERIC(18, scale)` | `0.0` |
| `float` | `REAL` | `0.0` |
| `double` | `DOUBLE PRECISION` | `0.0` |
| `boolean` | `BOOLEAN` | `FALSE` |
| `json`, `jsonlogic`, `object` | `JSONB` | `'{}'` |
| `array` | `JSONB` | `'[]'` |
| `uuid`, `time`, `duration`, `binary` | `UUID` / `TIME` / `INTERVAL` / `BYTEA` | none: no zero value, so every insert must send one |
| `date-time`, `date`, `reference` | `TIMESTAMPTZ` / `DATE` / key type | none: the column allows NULL |
| `enum` | `TEXT` (with CHECK) | `''`: a required enum refuses it (`90258`), so give it a `default_value` |

Nullability is also computed by format (via the platform's `is_nullable()` rule): **only `reference`, `date`, and `date-time` allow NULL**. Every other format is `NOT NULL`, with the zero value above when `default_value` is blank. Non-required fields accept `''`/null as a backfill.

**Rule:** `default_value` is optional on `create_field`. Set it when the zero value is wrong for the domain (a non-zero starting balance, a specific seed string) and always on a required `enum`.

- **A required enum has no automatic default.** With no `default_value` the default is `''`, which a required enum refuses (`90258`): every write must send a value, and adding the field to a table with rows fails (`90259`). Pass `default_value` (the value, never the label). The order of `enum_values` only affects display; list values in lifecycle order (`draft`, `pending`, `new`, `open`, `active` first) for that reason.
- **The lifecycle state field is named exactly `workflow_state`.** An entity with a lifecycle (an ordered set of states a record moves through, such as `draft` → `submitted` → `approved`) stores it in one required `enum` field named `workflow_state`: `enum_values` are the states in order, `default_value` is the initial state. Never `status`, `state` or `lifecycle_state`. Gates, `value_changed` rules and `process_gates.state_column` refer to this name, and a spec with another name is rejected on deploy. An enum that merely looks state-like but is not the lifecycle (a `priority`, a `contract_status` beside the lifecycle) keeps its domain name. Before creating it, read the entity's fields and do not add a second state field when `workflow_state` exists.
- **Limits and SQL expressions.** A `default_value` has at most 200 characters, with no `;`, `--` or `/*`. It is evaluated only when it exactly matches (case-insensitive) one of `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`, `LOCALTIMESTAMP`, `LOCALTIME`, `now()`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `gen_random_uuid()`, `CURRENT_USER`, `SESSION_USER`. Any other text is a literal cast to the column's type, never evaluated.
- **`default_value` is stored as text**, whatever the format. A number or boolean is converted (`1` is stored as `"1"`, `true` as `"true"`), and a JSON array or object as its JSON text. Give a value that fits the format: a whole number for an integer field, `true` or `false` for a boolean, valid JSON for a JSON field. Example: a required `integer` field `seats_purchased` with a `>= 1` rule takes `"default_value": "1"` (or `1`), because the auto-default `0` would break the rule.
- **There is no settable `is_nullable` flag** — nullability is computed purely from `format` (the `is_nullable()` rule above): only `reference`, `date`, and `date-time` are nullable. For every other format the column is NOT NULL regardless of `input_type`; declaring the field optional doesn't make it nullable.

```bash
# Required enum on a possibly-non-empty entity — always include default_value
semantius call crud create_field '{
  "data": {
    "table_name": "departments",
    "field_name": "workflow_state",
    "title": "Workflow State",
    "format": "enum",
    "enum_values": ["active", "inactive"],
    "default_value": "active",
    "input_type": "required",
    "width": "default"
  }
}'
```

### Enum values and labels

An `enum_values` entry is either a plain value (`"draft"`) or a `{"value", "label"}` object (`{"value": "on_hold", "label": "On hold"}`), and the two forms can be mixed. An object may also carry an optional `description`, `color` (an HTML color) and `icon` (a Lucide icon name); these are UI hints only. **Records store the value; the label, description, color and icon are only what the UI shows.** Rules:

- Write every entry as an object with a `label` and a `color`. The label is the value in words, in sentence case (`{"value": "checked_out", "label": "Checked out"}`), or the full term for a code or an abbreviation (`{"value": "nda", "label": "Non-disclosure agreement"}`); an entry without a label shows its raw value. The color follows "Enum colors" below. An object always carries `label`.
- **Give every entry of every enum an `icon` that fits its meaning.** Take it from "Enum icons" below; when the label fits no row there, run `lucide-icon-finder.ts` for it. When the finder finds nothing that fits, the entry has no icon. Then pass every name through `lucide-icon-checker.ts` once for all of the module's enums, in one call.
- `description` is the exception: add it only when the label is not self-describing (an internal code, a term of art, two choices a user could confuse). A label like "Approved" needs none.
- Never an object map like `{"draft": "Draft"}`: `enum_values` is always an array.
- Writes, filters, `default_value` and JsonLogic compare against the **value**, never the label. Only the value reaches the CHECK constraint and the column default.
- Reading `enum_values` back (or the `enum` list of a property in `get_schema`) returns the entries as defined, so an object comes back as an object with any `description`, `color` and `icon` it carries: take its `value`. `get_schema` also lists `""` for an enum that is not required.
- Changing only a label, description, color or icon is cosmetic (records keep their values); adding, removing or renaming a value is a schema change (see Safe Evolution).
- `update_field` replaces the whole `enum_values` array, so send every entry back with all of its keys; an entry sent without its `color` loses it. Removing a value still in use is refused (`23514`).

```bash
semantius call crud create_field '{"data": {
  "table_name": "contracts", "field_name": "contract_type", "title": "Contract Type", "format": "enum",
  "enum_values": [
    {"value": "msa", "label": "Master services agreement", "color": "#3b82f6", "icon": "handshake"},
    {"value": "nda", "label": "Non-disclosure agreement", "color": "#ec4899", "icon": "lock"},
    {"value": "sow", "label": "Statement of work", "color": "#14b8a6", "icon": "clipboard-list"}
  ],
  "default_value": "msa", "input_type": "required", "width": "default"
}}'

semantius call crud create_field '{"data": {
  "table_name": "contracts", "field_name": "workflow_state", "title": "Status", "format": "enum",
  "enum_values": [
    {"value": "draft", "label": "Draft", "color": "#64748b", "icon": "file-pen"},
    {"value": "on_hold", "label": "On hold", "color": "#f59e0b", "icon": "circle-pause", "description": "Waiting for the counterparty to countersign"},
    {"value": "signed", "label": "Signed", "color": "#22c55e", "icon": "circle-check"}
  ],
  "input_type": "required", "width": "default"
}}'
```

#### Enum icons

Take the icon of the row whose meaning the entry's label carries. When the label fits no row, run `lucide-icon-finder.ts` for it and take the first hit that clearly matches the meaning.

| Entry meaning | `icon` | Entry meaning | `icon` |
|---|---|---|---|
| draft, new | `file-pen` | approved, done | `circle-check` |
| submitted | `send` | completed | `check-check` |
| in review, pending, waiting | `clock` | active, in use | `circle-play` |
| upcoming | `calendar-clock` | on hold, suspended, idle | `circle-pause` |
| renegotiated | `refresh-cw` | blocked | `ban` |
| trial | `hourglass` | canceled, failed | `circle-x` |
| rejected | `x` | expired, retired, revoked, inactive, void | `circle-slash` |
| overdue | `circle-alert` | on leave | `tree-palm` |
| disputed | `scale` | left | `log-out` |
| low (level) | `signal-low` | medium (level) | `signal-medium` |
| high (level) | `signal-high` | critical (level) | `siren` |
| paid | `circle-dollar-sign` | | |

#### Enum colors

Write each hex in lowercase, exactly as listed. No two entries of one enum share a color.

**State-like enums**, `workflow_state` and enums whose field name is `priority`, `severity`, `urgency`, `impact`, `risk_level` or ends in `_status`, take each entry's color by its meaning. When two or more entries share a meaning (`submitted` and `in_review` are both waiting), the first takes the `color`, the next ones the shades in order:

| Entry meaning | `color` | Shades |
|---|---|---|
| draft, new, initial | `#64748b` | `#475569` · `#94a3b8` |
| active, open, in progress | `#3b82f6` | `#2563eb` · `#60a5fa` |
| waiting, on hold, pending | `#f59e0b` | `#d97706` · `#fbbf24` |
| done, approved, closed as success | `#22c55e` | `#16a34a` · `#4ade80` |
| canceled, failed, rejected | `#ef4444` | `#dc2626` · `#f87171` |
| levels (priority, severity, urgency, impact, risk_level) low · medium · high · critical | `#64748b` · `#3b82f6` · `#f59e0b` · `#ef4444` | |

Past the listed shades, a further entry of that meaning gets another shade of the same hue that the enum does not use yet.

**Every other enum:** an entry whose label carries one of the meanings above takes that color (`defect` → `#ef4444`, `approved` → `#22c55e`). Red, amber and green go only to such entries, never to an entry whose label does not relate to them (never red for `approved`). Every other entry takes the next color of this set that the enum does not use yet, in order:

| # | Color | `color` |
|---|---|---|
| 1 | blue | `#3b82f6` |
| 2 | pink | `#ec4899` |
| 3 | teal | `#14b8a6` |
| 4 | slate | `#64748b` |
| 5 | cyan | `#06b6d4` |
| 6 | purple | `#a855f7` |

Purple is last because next to blue it is easy to miss; an enum with few entries never gets it. Once the set is used up, each further entry gets a new hex that is not red, amber or green in hue.

### `cube_type` Values

Controls how a field participates in OLAP cube generation (only relevant when the entity has `cube_mode: "auto"`).

| Value | Meaning |
|-------|---------|
| `disabled` | Field excluded from cube |
| `auto` | **Default.** System infers dimension or measure from `format` |
| `dimension` | Explicit grouping axis (e.g. category, region, status) |
| `measure` | Explicit numeric aggregation (e.g. revenue, count) |

When to set `cube_type` explicitly:

- `dimension`: categorical fields the user will group or filter by (status, country, product type)
- `measure`: numeric fields the user will aggregate (amount, quantity, duration)
- `disabled`: fields that should be excluded from cube queries even if `cube_mode: "auto"` is set on the entity (e.g. internal audit fields, raw foreign keys)
- `auto`: default; leave unset unless the system inference is incorrect

### Example: Add Fields to an Entity

All new fields of an entity go into **one** `create_field` call — `data` is an array, and the items may carry different keys (`searchable` on one, `precision` on another, `enum_values` + `default_value` on a third; a key omitted from an item takes the column default). One request, one transaction, one array back:

```bash
semantius call crud create_field '{
  "data": [
    {
      "table_name": "products",
      "field_name": "description",
      "title": "Description",
      "format": "text",
      "width": "default",
      "input_type": "default",
      "searchable": true
    },
    {
      "table_name": "products",
      "field_name": "price",
      "title": "Price",
      "format": "number",
      "precision": 2,
      "width": "default",
      "input_type": "default"
    },
    {
      "table_name": "products",
      "field_name": "workflow_state",
      "title": "Workflow State",
      "format": "enum",
      "enum_values": ["draft", "active", "discontinued"],
      "default_value": "draft",
      "width": "default",
      "input_type": "required"
    }
  ]
}'
```

No `field_order`: the platform places each new field after the entity's existing fields, in array order, so list the items in the order they should display.

Three separate `create_field` calls for the three fields would be three round trips with no atomicity — the failure the batching rule (Golden Rule 7) names. Duplicate check first, in one read: `read_field '{"filters": "table_name=eq.products&field_name=in.(description,price,workflow_state)"}'`.

### All Field Properties

| Property | Type | Notes |
|----------|------|-------|
| `table_name` | string | Target entity, required |
| `field_name` | string | Snake_case identifier. Renaming is supported but think twice: views, integrations, and saved queries reference the field by name. |
| `title` | string | Human-readable label shown in UI |
| `description` | string | Explains what the field represents |
| `format` | string | Changeable only to a format with the same physical database type (e.g., one string format can swap to another string format; `int32` to `int64` is refused with `90223`). See format table above. |
| `width` | string | `default` (default), `s`, `m`, `w` |
| `input_type` | string | `default`, `required`, `readonly`, `disabled`, `hidden` |
| `field_order` | integer | Display position in the UI. **Omit it on create**: the platform gives each new field the next position after the entity's existing fields, in array order. Set it only to put a field at a specific position (on create, or later with `update_field`), and read the entity's live `field_order` values first: the auto-created fields already hold positions (the label field sits at 20), and a tie is not an error, the UI just renders the tied fields in an unpredictable order. Choose a value strictly between the two live neighbors the field should sit between (e.g. 25 between 20 and 30), or above the highest value below 900000 to put it last. The automatic numbering ignores values from 900000 up (`created_at` and `updated_at` sit at 999998 and 999999); keep every other field below 900000. |
| `searchable` | boolean | Adds this field to the entity's full-text search index |
| `unique_value` | boolean | Enforces uniqueness at database level through a partial unique index: for string formats, `NULL` and `''` are exempt. See `### unique_value` above. |
| `enum_values` | array | Required when `format: "enum"`: the allowed entries, each a value or a `{"value", "label"}` object with an optional `description`, `color` and `icon`. Records and `default_value` hold the value, never the label; never an object map. See "Enum values and labels" above. |
| `precision` | integer (0–18) | For `format: "number"` only, number of digits after the decimal point in the generated `NUMERIC` column. Defaults to `2` (suits money and most measured quantities). Set higher (e.g. `4`–`6`) for tax rates, FX rates, or scientific values; `0` for integer-like counts that still want NUMERIC semantics. |
| `default_value` | string | Override for the platform's auto-default. Only set when the auto-default is wrong for the domain. See `### default_value` above for the auto-default table per format, the 200-character limit and the SQL expressions it evaluates. Stored as text: a number or boolean is converted (`1` → `"1"`, `true` → `"true"`), a JSON array or object to its JSON (`{}` → `"{}"`). |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade`. On an `is_a` entity never `cascade` (`90249`): set `restrict` or `clear` explicitly, on `parent` fields too. |
| `relationship_label` | string | Verb for the relationship, set on every `reference` and `parent` field in the same `create_field` call that creates it; omitted, the platform writes `has`. Read it as `<Referenced Entity> <label> <Holding Entity>` (e.g. `"employs"` on `employees.department_id`). Used as the arrow label in module diagrams and in navigation labels. See "Relationship labels". |
| `singular_label_parent` | string | `parent` fields only. The noun in the add button of this field's child list on the parent's page: `"Permission"` gives "Add Permission". |
| `plural_label_parent` | string | `parent` fields only. The title of the button on the parent's page that opens this field's child list: `"Permissions"` gives "Permissions…". Empty, the button uses the child entity's plural label (an Entity page shows "Fields…"). Set the pair on every junction leg, and when one child has two or more `parent` fields to the same parent. See "Relationship labels". |
| `cube_type` | string | OLAP cube participation: `disabled`, `auto` (default), `dimension`, `measure`. See `### cube_type Values` above. |
| `catalog_field_code` | string | Core provenance column: stable design-time field identity (the blueprint field name, e.g. `status`), the field-rename join key. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec. See "Platform provenance / meta columns" above. |

---

## Relationships

### Choosing the Right Format

The platform manages nullability from the format; there is no `is_nullable` flag to pass. A `reference` column allows NULL; a `parent` column is NOT NULL whatever its delete mode. A `reference` becomes mandatory with `input_type: required` and delete mode `restrict`; `required` with `clear` is refused (`90257`).

**Exception: fields of an `is_a` entity never cascade** (`90249`). The rows below that say `cascade` become `restrict` (or `clear` on a `reference`) there, set explicitly. See `entity-families.md`.
<!-- Family variant: `entity-families.md` → "Creating a family". This rule summarizes; that section governs families. -->

**Read order:** the divergent-permission-scope rule (last two rows) **overrides** the "child is owned by parent" and "M:N junction FK" rows whenever the child's edit tier differs from the parent's. Always evaluate divergence first; fall through to the same-tier rows only when tiers match.

| Scenario | `format` | `reference_delete_mode` |
|----------|----------|------------------------|
| Optional relationship to independent entity | `reference` | `clear` |
| Required relationship to independent entity | `reference` | `restrict` |
| Child is owned by parent (**shared permission scope** — child tier == parent tier) | `parent` | `cascade` (`restrict` on an `is_a` child) |
| M:N junction FK, **both parents share the junction's tier** (per-leg test, not table-wide) | `parent` | `cascade` (`restrict` on an `is_a` junction) |
| **Lifecycle-bound child with divergent permission scope** — overrides the two rows above | `parent` | `restrict` |
| Lifecycle-bound child with divergent permission scope, accepting that deleting the parent deletes the child without the child's own permission check (high-risk) — overrides the two rows above | `parent` | `cascade` |

**Divergent-permission-scope rule.** This is the rare case: most children share their parent's permissions, and `parent` + `cascade` is right. A cascade deletes the children without checking the child's own delete permission (a Postgres referential action does not apply row-level security); `restrict` refuses the parent's deletion while any child exists, so each child is removed first through its own delete permission. When a child has its own conditional permission gate (a `validation_rules` rule whose JsonLogic invokes `has_permission` or `require_permission` (see `jsonlogic.md`) against a workflow permission that the parent does not require, or a §3 `**Edit permission:**` annotation that differs from the parent's tier), keep `format: parent` and set `reference_delete_mode: restrict` (recommended for audit-logged decision evidence like scorecards or signed offers). Use `cascade` only when the user explicitly accepts that deleting the parent deletes the child without that check. `clear` never works on a `parent`: the column is NOT NULL, so every delete of the parent would fail. A child that must survive its parent is not a `parent`: use `reference` with `clear` (first row). Never change a `parent` to a `reference` to protect the child's permissions; that makes the field optional and removes it from the parent's child listing. A junction is the exception: every leg stays `parent`, including a leg to an entity another module owns, because a junction row is only a relationship and its permission comes from the module that created it.

### Relationship labels

Set `relationship_label` on every `reference` and `parent` field, in the same `create_field` call that creates the field. A field created without one gets `has`, and a module whose arrows all read `has` shows nothing about its relationships.

- **Voice.** The referenced entity speaks. Read the label as `<Referenced Entity> <label> <Holding Entity>`, the direction of the arrow in the module diagram: `accounts` → `opportunities` is `owns`, `users` → `tasks` (the owner) is `manages`. A sentence that does not parse means the label is written from the wrong side.
- **Specific verbs.** `has`, `references`, `belongs to` and `relates to` add nothing; use a domain verb such as `owns`, `employs` or `supports`. A self-reference takes `parent of`, `manages` or `reports to`.
- **One verb per field.** Fields from one entity to the same entity take different verbs: `tasks.creator_id` → `users` is `created`, `tasks.assignee_id` → `users` is `assigned`.
- **Junction legs.** Read the label through the junction to the other end, and set `singular_label_parent` and `plural_label_parent` to the other end's name. On `product_tags`, `product_id` is `is tagged with` with `Tag` / `Tags`, so the Product page shows "Tags…" and "Add Tag"; `tag_id` is `applied to` with `Product` / `Products`.
- **Same parent twice.** When one child has two or more `parent` fields to the same parent, give each its own pair, or the parent's page shows two identical buttons. `permission_hierarchy` does this with `Includes` and `Included in`.

### `reference`: Cross-Entity Relationship (Independent Lifecycle)

Use when the child record is **created independently** and then associated with the parent, it exists and makes sense on its own. Example: a Task is created on its own and related to a Lead; a Product exists independently of any category. The child can outlive or be reassigned away from the parent.

```bash
# Order has an optional assigned sales rep
semantius call crud create_field '{
  "data": {
    "table_name": "orders",
    "field_name": "sales_rep_id",
    "title": "Sales Rep",
    "format": "reference",
    "reference_table": "users",
    "reference_delete_mode": "clear",
    "relationship_label": "manages",
    "width": "default",
    "input_type": "default"
  }
}'
```

### `parent`: Ownership/Composition (Bound Lifecycle)

Use when the child record is **always created in the context of the parent** and has no meaning outside it, master-detail. Example: an Order Line is created within an Order; a Meeting Attendee is created within a Meeting. You would never create the child record first and relate it later.

```bash
# Order line belongs to an order
semantius call crud create_field '{
  "data": {
    "table_name": "order_lines",
    "field_name": "order_id",
    "title": "Order",
    "format": "parent",
    "reference_table": "orders",
    "reference_delete_mode": "cascade",
    "relationship_label": "contains",
    "width": "default",
    "input_type": "default"
  }
}'
```

### M:N Junction Tables

Create a junction entity and add a `parent` field for **each** leg (two for a binary junction, three or more for an N-ary one):

```bash
# Create junction entity (products and tags already exist — entities before fields)
semantius call crud create_entity '{"data": {"table_name": "product_tags", "entity_type": "junction", ...}}'

# Both parent legs in ONE create_field call; each leg is labeled through to the other end
semantius call crud create_field '{"data": [
  {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "relationship_label": "is tagged with", "singular_label_parent": "Tag", "plural_label_parent": "Tags", "width": "default", "input_type": "default"},
  {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "relationship_label": "applied to", "singular_label_parent": "Product", "plural_label_parent": "Products", "width": "default", "input_type": "default"}
]}'
```

> **Do not set `label_column` on a junction.** `label_column` is optional — `create_entity` requires only `table_name` and `module_id` — and a junction has no natural label field: the platform composes `_label` from the `parent` legs automatically. Setting `label_column` to `id` (or any auto-generated column — `created_at`, `updated_at`) makes `create_entity` fail with *column 'id' specified more than once*, because that column already exists. Omit `label_column` (as the example above does), and likewise omit `label_parent`.

> **Junctions aren't binary-only.** `entity_type = junction` combines **all** `parent` legs, so an N-ary relationship works the same way — e.g. `(user, role, tenant)`. The class rule for a junction versus an association class is in "Classifying an entity" above.

### Cross-module references and required relationships

Modules deploy standalone. The blueprint's `related_modules` frontmatter is an **advisory integration hint**, NOT a deployment prerequisite. The deployer never auto-pulls or auto-requires another module to install before this one. A blueprint that needs another module to function (its entities can't deploy without the other module's entities) is a defect to flag, not assemble around.

The mechanism for self-containment is `embedded_master`: a module declares an entity locally with `held_as = embedded_master` and `mastered_in = <canonical-owner-module>`. The entity exists in this module's catalog until the canonical owner installs; at that point Branch-B promotion (deployer Stage 4c-promote) moves the entity to the canonical owner with no data migration.

For a relationship between entities in different modules:

- A relationship to an entity that is neither live nor created in the same deploy creates **no field and no constraint**.
- When both entities exist, the field is proposed. It is non-mandatory unless the spec's §6 `Required` says `yes`: `yes` sends `input_type: "required"` with `reference_delete_mode: "restrict"`, and `no` (the default) sends `input_type: "default"` with `reference_delete_mode: "clear"`.
- The relationship NEVER forces the other entity (or its module) to install.

The blueprint's §5 `field_required` says whether the relationship's field must be filled in once both entities are installed; the spec records the decision in its §6 `Required`. Neither makes an entity required. Whether a module can be installed without an entity is a separate fact, the blueprint's §3 `install_optional`.

### Embedded-entity governance follows the catalog

An entity's permissions are named by the catalog, never by what is installed. A module that embeds an entity (`held_as = embedded_master`) keeps its owner's names, even when the owner module is not installed yet, and holds them through its own bundles:

- **Read and write:** `<owner>:read_<entity>` and `<owner>:write_<entity>`, named after the entity's master. The entity's `view_permission` and `edit_permission` point at them and never change.
- **Workflow gates:** `<owner>:<verb>`, named after the module that realizes the state if the catalog names one, otherwise the entity's master.
- **Overrides** (`view_all_<plural>` / `manage_all_<plural>` / `submit_<singular>` / `bypass_submit_lock`) and matching business rules: named after the entity's master.
- **Bundles** (`<unit>:read`, `<unit>:manage`, `<unit>:admin`, a narrow tier): named after the module that declares them. They include the rows above through `permission_hierarchy`, so the module's roles keep holding bundles. `rbac.md` § *Per-entity permissions and bundles* has the full table.
- **Boundary-crossing handoffs:** the module still emits the events the embedded entity publishes to or reacts from modules the embedding unit doesn't "play".

When the canonical owner module later installs and Branch-B promotion moves the entity to its canonical home, nothing is renamed. The permission rows already exist: they move to the owner and take the owner's description. Entity columns, grants and rules don't change, and the owner adds its own bundle rows. **Once the same modules are installed, every order ends with the same permission names, entity columns, hierarchy rows and grants.** A second module that embeds the same entity uses the same rows and adds only its own bundle rows.

Three cases keep other names:

- **Deliberately separate table** (`rename-incoming-from` in a spec): keeps the local prefix, because a shared name would make a grant on one table open the other.
- **Entity already live with other permission names** (reused or built by hand): the live names win, and the module's bundle rows include them.
- **`access_scope: custom`:** the module keeps its hand-made permissions.

This rule applies uniformly to every blueprint shape (`hiring-starter`, `ats-recruitment-pipeline` which is itself master-of-15-and-embedded-of-5, `real-estate-agent`, any future bundle) and to every install ordering. The deployer's behavior on every install is `module_kind`-agnostic; the `module_kind` frontmatter is an informational label, not a behavior switch.

---

## Safe Evolution Patterns

### ✅ Low-Risk (do freely)
- Add new fields
- Update descriptions, labels, UI hints (`width`, `field_order`, `icon_name`, `name_sort`)
- Add `searchable: true` to fields
- Create new entities in new or existing modules
- Add new permissions/roles/assignments
- Add a new `input_type_rule` to a field that is not `required` (pure UI behavior, fails open) — see `jsonlogic.md`

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values` (values; a change to only labels, descriptions, colors or icons is cosmetic, since records store values)
- Adding `unique_value: true` to an existing field (fails if duplicates exist)
- Adding, modifying, or removing a `select_rule` on an entity (it replaces `view_permission` for reads: rows may suddenly disappear or reappear for current users, and a rule without a permission test shows its rows to every user who can reach the table) — see `select-rule.md`
- Adding an `input_type_rule` to a `required` field (the database stops enforcing `required` for it)
- Adding or changing a `rollup` definition or `computed_fields` (recalculates existing records with no audit row; the tables written take no other writes until the save commits) — see `rollup-fields.md`
- Modifying or removing an existing `input_type_rule` (forms suddenly show, hide, or unlock a field mid-workflow) — see `jsonlogic.md`

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name`, breaks all references
- Deleting entities or fields, permanent data loss
- Removing permissions still in use by roles
- Changing primary key fields (`id_type` cannot change at all, `90233`; a record's key value cannot change either, `90236`)
- Choosing `is_a` or `has_a` (`id_refentity` and an `is_a` prefix are fixed at creation; a record's type cannot change later)
- Deleting an entity that others are based on (refused with `90248`; check `id_refentity=eq.<table_name>` first)
- Deleting an entity that fields of other entities reference (refused with `90260`; check `reference_table=eq.<table_name>` first)
- Setting `include_hidden_rows: true` on a rollup (readers see an aggregate over rows they cannot read) — see `rollup-fields.md`
- Always check dependencies before deletion

---

## Updating and Deleting Entities

```bash
# Update entity metadata (safe — low risk)
semantius call crud update_entity '{
  "table_name": "products",
  "data": {
    "description": "Updated description",
    "view_permission": "catalog:read"
  }
}'

# Update a field (only changed attributes needed)
semantius call crud update_field '{
  "id": "<field-id>",
  "data": {
    "title": "New Title",
    "searchable": true
  }
}'

# Delete field — requires explicit user confirmation first
semantius call crud delete_field '{"id": "<field-id>"}'

# Delete entity — check all dependencies first!
# 1. Check for fields referencing this entity
semantius call crud read_field '{"filters": "reference_table=eq.<table_name>"}'
# 2. Check for entities based on this one (is_a / has_a); a base with dependents is refused (90248)
semantius call crud read_entity '{"filters": "id_refentity=eq.<table_name>", "select": "table_name,id_type"}'
# 3. Only proceed if no references or dependents were found and user has confirmed
semantius call crud delete_entity '{"table_name": "<table_name>"}'
```

An entity cannot be deleted while a field of another entity references it (`90260`), whatever that field's `reference_delete_mode`: the mode governs deleting records, not the entity. Delete those fields or point them at another entity first. It is also refused while a rollup of another entity aggregates over it (`90266`). An `is_a` / `has_a` entity, or the base of one, cannot be deleted while it has records (`90247`): delete the records through the entity first. See `entity-families.md`.

`delete_module` removes the module with all its entities, fields and records in one request, so do not delete its entities first; confirm with the user and back up with `export_module` first. It is refused with `90260` while a field of another module references one of its entities, and with `90266` while a rollup of another module aggregates over one; references between its own entities do not count. Two modules that reference each other need one such field removed first. While an `is_a` / `has_a` entity in the module has records it is refused with `90247`; entities of the same module that are based on each other do not block it.

---

## Agent Workflow Tips

1. **Always read before writing**, Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`, and compare a new entity with the whole instance first (`SKILL.md` → "Before any new entity: compare it with the instance"). For a bulk create, one `read_*` with an `in.(...)` filter covers all items.
2. **Resolve prerequisites in order**, as given in "Mandatory Creation Order".
3. **Batch related writes**, Put all fields of one entity, both baseline permissions of one module, all entities of one model (one call per level when it has `is_a` / `has_a` entities), or all `role_permission` rows of one role into a single `create_*` call with an array in `data`; use an id array for `update_*` / `delete_*` across several records. Fewer calls, one transaction. N single-record calls where one array call would do is a mistake.
4. **Be conversational**, Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
5. **Validate semantic correctness**, Does the model make sense for the user's domain?
6. **Ask for clarification when needed**, If a user says "add contacts", confirm what fields they need before creating anything. In a request to build a whole module, model fields, lifecycle states and classes from the user's description and the leading products of the domain instead of asking about them. Ask the questions `build-module.md` names, plus any other that only the user can answer and where a wrong guess is costly to undo, such as a choice locked at creation (`is_a` / `has_a`, `entity-families.md`) or a concept the instance may already hold.
7. **Warn before risky changes**, Alert the user to medium/high-risk changes and wait for confirmation before executing.
8. **Suggest next steps**, After creating an entity, suggest related entities, missing fields, or useful roles.
9. **Provide link to UI**, After creating or updating entities/fields, provide: `{ui_baseurl}/{module_slug}/{table_name}` (get `ui_baseurl` from `getCurrentUser` — never hardcode the org host; URL paths use the lowercase `module_slug`, never the display `module_name`). For a specific record, append the id: `{ui_baseurl}/{module_slug}/{table_name}/{id}`.
10. **Verify the class and the permissions after creating entities**, one `read_entity '{"filters": "table_name=in.(...)", "select": "table_name,entity_type,view_permission,edit_permission"}'`. `unclassified` is a defect: classify it with `update_entity` (an array of `table_name`s takes the same value) and re-check its `edit_permission` against the write tier before reporting the module as done. Run the same read on an existing module you work on, and classify what is missing.

Use `wfts(simple)` on the `search_vector` column when the entity is searchable:

```bash
# Check if entity is searchable
semantius call crud read_entity '{"filters": "table_name=eq.contacts"}'
# Look for searchable: true in response

# Full-text search
semantius call crud postgrestRequest '{
  "method": "GET",
  "path": "/contacts?search_vector=wfts(simple).Monica"
}'
```

> Always use `wfts(simple)`, the `simple` text search configuration is language-agnostic and required for multilingual content. Never use bare `wfts` or `fts`. Only fall back to field-specific filters (`ilike`, `eq`) when the user specifies a particular column or when the table is not searchable.

> For an `is_a` / `has_a` entity, `search_vector` covers the searchable fields of its base as well as its own. That search cannot use an index, so on large tables add a narrowing filter.

---

## Runtime schema introspection (live FK / shape lookup)

`read_entity` and `read_field` are not just schema-setup tools. They are the live source of truth for the current shape of any entity, and they are cheap to call mid-flight from a business CRUD recipe. Two distinct use cases:

1. **Schema setup** (covered above). Before `create_entity` / `create_field`, check the entity or field doesn't already exist; before `delete_entity`, check what references it.

2. **Runtime drift recovery** (new context). A baked recipe in a domain skill (e.g. one generated by `semantius-skill-maker`) assumes a particular FK shape, junction uniqueness, or audit-log flag. The live schema can drift. When a recipe gets a `409 Conflict`, `422 Unprocessable Entity`, or any write failure it didn't predict, **query the live shape** before deciding how to recover:

```bash
# What FKs does entity <id> have right now?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>"}'

# What does this specific field reference today?
semantius call crud read_field '{"filters": "entity=eq.<entity_id>&name=eq.<field_name>"}'

# Is this entity audit-logged today?
semantius call crud read_entity '{"filters": "id=eq.<entity_id>"}'
# Look for audit_log: true in response
```

**A based entity's fields span its family.** `read_field` lists only the fields an entity owns; an `is_a` / `has_a` entity's record also carries every field of its base. To see the whole shape, walk `id_refentity` up with `read_entity` (until it is null), then read every level in one call:

```bash
semantius call crud read_entity '{"filters": "table_name=eq.emails", "select": "table_name,id_type,id_refentity"}'
semantius call crud read_field '{"filters": "table_name=in.(emails,activities)"}'
```

> **Combine multiple filter conditions with `&`, never a comma.** `entity=eq.<id>&name=eq.<f>` ANDs two columns (PostgREST query-string syntax). A comma is only a value-list separator *inside* `in.(...)` / `or=(...)`; a top-level `col1=eq.a,col2=eq.b` does **not** mean AND — it silently matches nothing, which reads as "not found" and then triggers a duplicate create on the next write.

If the live shape contradicts the recipe's assumption, abort the recipe with a clear message naming the drift, do not silently "fix it up" with extra writes. Recommend the user regenerate the affected domain skill via `semantius-skill-maker`.

This separation matters because the two contexts have different defaults: schema-setup reads precede a *write to the model*; runtime introspection precedes a *recovery decision* about a stuck business write. Same tools, different guardrails.

---

## Tool Priority Rule

**Always use typed CRUD tools** (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations — including bulk ones: `create_*` takes an array in `data`, `update_*` / `delete_*` take an array in `id` (`table_name` for entities).

Only use `postgrestRequest` or `sqlToRest` for:
- Complex multi-filter or aggregation queries not expressible through typed tools
- A bulk mutation that must be selected by an arbitrary **filter** (not by a list of ids), e.g. `PATCH /fields?table_name=eq.products&format=eq.string`
- An update where each row needs **different** values in one request (typed `update_*` applies the same `data` to every id)
- Business-record rows in your own entity tables (Layer 2), where the array-body POST is the bulk form

---

## Entity Reference: All Managed Tables

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `entities` | Domain concept definition | Parent of fields; references module; uses permissions |
| `fields` | Entity attributes/columns | Belongs to entity; may reference other entities |
| `modules` | Domain grouping | Referenced by entities, roles, permissions |
| `permissions` | Atomic capabilities | Used by entities; granted to roles; can inherit |
| `permission_hierarchy` | Permission inheritance | Relates including/included permissions (broader includes narrower) |
| `roles` | Permission bundles | Granted permissions; assigned to users |
| `role_permissions` | Role ↔ Permission M:N | Junction with audit fields |
| `users` | Actor identities | Assigned roles via `user_roles` |
| `user_roles` | User ↔ Role M:N | Junction with audit fields |
| `webhook_receivers` | Integration endpoints for external systems | Scoped to a target table |
| `webhook_receiver_logs` | Audit log of webhook calls | Belongs to a receiver |

---

## Troubleshooting

### "Permission denied" errors
```bash
# 1. Get current user and their effective permissions
semantius call crud getCurrentUser '{}'

# 2. Check entity's required permissions
semantius call crud read_entity '{"filters": "table_name=eq.<table>"}'

# 3. Trace: user → user_roles → role_permissions → permission_hierarchy
```

### Fields not displaying correctly
- Check `label_column` is set and matches a real field with `ctype='label'`
- Check `field_order` for display sequence
- Check `input_type` is appropriate
- Ensure `width: "default"` unless a specific override is needed
