   ---
   name: semantius-model-management
   description: Manage Semantius semantic data models - create entities, fields, relationships, and RBAC configurations. Use when users want to add tables, modify schema, configure permissions, or evolve their data model through the Semantius MCP server tools.
   ---

   # Semantius Semantic Data Model Management

   ## Overview

   Semantius is a **semantic data model system** that stores domain concepts, their attributes, relationships, and behaviors as structured data. Unlike raw database metadata, it encodes:
   - Human-readable labels and descriptions
   - UI rendering hints (order, width, icons)
   - Reference relationships with delete behavior
   - Role-based access control (RBAC)

   **Runtime behavior:** Applications use this model to generate UIs, validate data, and enforce access control—all driven by the semantic definitions.

   ---

   ## Core Concepts

   ### 1. Semantic Meaning (Labels & Documentation)
   - **Entities:** `singular_label`, `plural_label`, `description` define *what the concept means*
   - **Fields:** `title`, `description` explain *what each attribute represents*
   - **UI hints:** `icon_url`, `width`, `field_order` control *how concepts appear*

   ### 2. Relationships
   Fields reference other entities via `reference_table`. There are two relationship formats:

   - **`reference`** — Cross-entity link. The referenced record has an independent lifecycle.
   - Default delete mode: `restrict` (protect the parent from accidental deletion)
   - Use when: child can exist or be meaningful without the parent (e.g., Order → Customer)

   - **`parent`** — Ownership/composition. The child's lifecycle is bound to the parent.
   - Default delete mode: `cascade` (delete parent = delete children)
   - Use when: child cannot meaningfully exist without the parent (e.g., OrderLine → Order)
   - Also used for **junction tables** in M:N relationships — both FK fields use `format: "parent"` (e.g., `user_roles.user_id` and `user_roles.role_id`)

   **`reference` delete modes:**
   - `restrict`: Strong dependency — child cannot exist without parent
   - `clear`: Weak/optional link — relationship is optional (e.g., Ticket → AssignedUser)

   ### 3. Access Control (RBAC)
   - **Entity-level gates:** `view_permission` (read), `edit_permission` (write)
   - **Permission flow:** Users → Roles → Permissions (with optional hierarchy)
   - **Effective permissions:** Computed from direct grants + inherited permissions
   - **Naming convention:** Always use `<module>:<action>` format (e.g., `crm:read`, `crm:manage`, `leads:write`)

   ### 4. Domain Organization
   - **Modules:** Group related entities, permissions, and roles
   - Every entity **must** belong to a module
   - Used for navigation, branding, and logical boundaries

   ---

   ## Entity Reference Guide

   | Entity | Purpose | Key Relationships |
   |--------|---------|-------------------|
   | **entities** | Domain concept definition | Parent of fields; references module; uses permissions |
   | **fields** | Entity attributes/columns | Belongs to entity; may reference other entities |
   | **modules** | Domain grouping | Referenced by entities/roles/permissions; carries `module_type` and scaffold FKs (`manage_permission`, `admin_permission`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`) |
   | **permissions** | Atomic capabilities | Used by entities; granted to roles; can inherit |
   | **permission_hierarchy** | Permission inclusion | Each row says `including_permission_name` *includes* `included_permission_name` (the broader implies the narrower); carries immutable `origin` |
   | **roles** | Permission bundles | Granted permissions; assigned to users; carries `slug` and `origin` |
   | **role_permissions** | Role ↔ Permission mapping | M:N with audit fields |
   | **users** | Actor identities | Assigned roles via user_roles |
   | **user_roles** | User ↔ Role mapping | M:N with audit fields |

   ---

   ## Golden Rules for Agents

   1. **Labels are semantic contracts** – Set intentional, clear labels/descriptions on all entities and fields
   2. **References over raw IDs** – Use `reference_table` + `reference_delete_mode` for relationships
   3. **Security by default** – Always set `view_permission` and `edit_permission` on new entities
   4. **Additive changes first** – Prefer adding over deleting/renaming unless impact is understood
   5. **Validate before runtime** – Ensure one PK field (`is_pk=true`) and one label field (`ctype='label'`) per entity
   6. **Never create auto-generated fields** – When creating an entity, the system automatically creates `id`, `label`, and the field named in `label_column`. Do **not** call `create_field` for any of these.
   7. **Every entity needs a module** – Always assign a `module_id`. If no suitable module exists, create one first (see Module Workflow below).
   8. **Modules need baseline permissions** – Every new module must have at least `<module>:read` and `<module>:manage` permissions created.
   9. **CRUD tools have priority** – Always use the typed CRUD tools (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations. Only use `postgrestRequest` or `sqlToRest` for complex queries, filter-based bulk mutations, or updates where each row needs different values.
   10. **🚀 Always batch: one call per set of records, never a loop of single calls** – Whenever more than one record of the same kind is pending (several fields for an entity, several permissions for a module, several role_permission rows, several ids to update or delete), send them **in one call**: pass an array in `data` to `create_*`, or an array in `id` (`table_name` for entities) to `update_*` / `delete_*`. Array items do **not** need the same keys. Issuing N single-record calls where one array call would do is a mistake. See *Bulk Operations* under Tool Reference.
   11. **Permission naming convention** – Always use `<module>:<action>` format (e.g., `crm:read`, `crm:manage`)
   12. **`reference_table` mandates relational format** — Any field with a `reference_table` MUST use `format: "reference"` or `format: "parent"`.
   13. **`number` is the default for amounts and currencies** — Any field representing money, prices, totals, rates, or similar measured quantities must use `format: "number"`. Use `float` or `double` only when the user explicitly requests it or the field stores inherently imprecise values (e.g., scientific measurements, ML scores, GPS coordinates). Never default to `float` or `double` for financial data. Set `precision` to control decimal places (default 2); omit it unless a different scale is needed.
      Setting any scalar format (`integer`, `string`, `uuid`, etc.) alongside `reference_table` is always wrong and will always fail. No exceptions.

   ---

   ## Common Workflows

   > 🚀 **Batching applies to every workflow below.** Whenever a step produces more than one record of the same kind, make **one** tool call with an array (`data: [...]` for `create_*`, `id: [...]` for `update_*` / `delete_*`). Do not call the same tool once per record. Items in the array may have different keys.

   ### Create a Module (prerequisite for new entities)

   When no suitable module exists for a new entity, always create the module first.

   **Required steps:**

   1. **Check if a matching module exists** using `read_module` (filter by `module_name`)

   2. **If not found, create the module** with:
      - `module_name` (lowercase, snake_case identifier, e.g., `crm`, `inventory`)
      - `label` (human-readable, e.g., "CRM", "Inventory")
      - `description`
      - Optional: `access_scope` — `"basic"` (default) for simple read/edit modules; `"full"` only when the module needs role tiers, approvals, and gating. Leave unset for ordinary modules.
      - Optional: `icon_name` — name of the icon to show for the module in navigation; leave unset unless the user requests a specific icon.

   3. **Create baseline permissions** (always both):
      - `<module>:read` — grants read access to the module's entities
      - `<module>:manage` — grants full write access to the module's entities

   4. **Create a default role** (recommended):
      - E.g., `<module>_viewer` with `<module>:read`
      - E.g., `<module>_manager` with `<module>:read` + `<module>:manage`

   **Example:** User asks to add a "Service Catalog" feature with no existing module.

   **Agent actions:**
   - Call `read_module` to check for existing modules — none found
   - Call `create_module` with `module_name: "service_catalog"`, `label: "Service Catalog"`
   - Call `create_permission` once with `data: [{ permission_name: "service_catalog:read" }, { permission_name: "service_catalog:manage" }]` (one bulk call instead of two)
   - Proceed to create entity with the new `module_id`

   ---

   ### Create a New Domain Concept

   When user says: *"Add a lead tracker to the CRM"* or *"Create a products table"*

   **Required steps:**

   1. **Resolve the module** – Use `read_module` to find a matching module. If none exists, complete the Module Workflow above first.

   2. **Resolve permissions** – Use `read_permission` to find suitable `view_permission` and `edit_permission`. Use module-level permissions (e.g., `crm:read`, `crm:manage`) or create entity-specific ones if needed.

   3. **Create the entity** with:
      - `table_name` (lowercase, snake_case, **always plural**; e.g., `customers`, `categories`) — renaming is high-risk: breaks all references
      - `singular` – machine-readable singular form (e.g., `service`, `company`) — required
      - `singular_label` – human-readable singular name, also becomes the title of the label field (e.g., "Service Name", "Company Name")
      - `plural` – machine-readable plural form (e.g., `services`, `companies`) — required
      - `plural_label` (e.g., "Services", "Companies")
      - `description` (clear explanation of what this concept represents)
      - `label_column` – the snake_case **field name** whose value identifies a record (e.g., `service_name`, `company_name`). This must be a snake_case identifier, not a human-readable title.
      - `module_id` (required — use resolved module)
      - `view_permission` and `edit_permission` (required)
      - Optional: `icon_url`
      - Optional: `edit_mode` — controls how records open for editing: `auto` (default, system decides), `sidebar`, `modal`, or `page`
      - Optional: `cube_mode` — OLAP cube generation: `disabled` (default) or `auto` (include in cube)
      - `audit_log`: Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value.
      - Optional: `managed` — When `false`, automatic DDL execution is disabled for this entity. Leave unset (defaults to `true`) for normal entities where Semantius manages the database schema. Set to `false` only for external or legacy tables where DDL is managed outside the platform.
      - Optional: `order_column` — Enable fixed, user-defined row ordering (e.g. drag-and-drop) by naming the snake_case field that stores the sort position. The platform provisions that INTEGER column and auto-assigns increasing values on insert. Leave unset (default `''`) unless the user wants records to keep a manual order rather than a natural/sorted one.

      **The system automatically creates these fields — do NOT create them manually:**
      - `id` — primary key field (`ctype: "id"`, `is_pk: true`)
      - `label` — display field (`ctype: "label"`) that reads from `label_column`
      - The field named in `label_column` (e.g., `service_name`) with title from `singular_label`
      - `created_at` and `updated_at` timestamp fields

      > ⚠️ **Never call `create_field` for `id`, `label`, `created_at`, `updated_at`, or the field named in `label_column`. They already exist.**

      > ℹ️ `searchable` and `is_child` on the entity are **read-only** and computed automatically (`searchable` when any field has `searchable: true`; `is_child` when any field uses `format: "parent"`). Never set these manually.

      > ℹ️ **`is_nullable` and `default_value` are computed automatically from `format` — never set them manually.** The system trigger assigns NOT NULL + a sensible default to every format except `reference`, `date`, and `date-time`, which allow NULL. Setting these manually will be ignored or conflict with the trigger.

   4. **Add domain fields** based on user requirements (see Field Format Quick Reference below). Pass all fields of the entity to a single `create_field` call as an array in `data`.

   **Example user request:** "Add a service catalog with service name, description, and cost"

   **Agent actions:**
   - `read_module` → find or create `service_catalog` module
   - `read_permission` → find or create `service_catalog:read` and `service_catalog:manage`
   - `create_entity` with `table_name: "services"`, `singular: "service"`, `plural: "services"`, `singular_label: "Service Name"`, `label_column: "service_name"`, `module_id: <id>`, `audit_log: false`, etc.
   - System auto-creates: `id`, `label`, `service_name`, `created_at`, `updated_at`
   - `create_field` once with `data: [ { table_name: "services", field_name: "description", title: "Description", format: "text", searchable: true }, { table_name: "services", field_name: "cost", title: "Cost", format: "number" } ]` (both fields in one bulk call)

   **What NOT to do:**
   - ❌ Don't call `create_field` for `id` — auto-generated
   - ❌ Don't call `create_field` for `label` — auto-generated
   - ❌ Don't call `create_field` for `service_name` (the label_column field) — auto-generated
   - ❌ Don't call `create_field` for `created_at` / `updated_at` — auto-generated
   - ❌ Don't manually set `searchable` on the entity — it is computed

   ---

   ### Model a Relationship

   When user says: *"Link orders to customers"*, *"Add order lines to orders"*, or *"Create a user-roles junction"*

   **Choose the right format:**

   Nullability is derived automatically from `format` and `reference_delete_mode` — a `reference` with `clear` is optional (can be null); a `parent` with `cascade` is required.

   | Scenario | `format` | `reference_delete_mode` |
   |----------|----------|-------------------------|
   | Child references an independent entity | `reference` | `restrict` |
   | Optional/weak link to another entity | `reference` | `clear` |
   | Child is owned by / composed into parent | `parent` | `cascade` |
   | Junction table FK (M:N) | `parent` | `cascade` |

   **Steps for a `reference` field:**

   1. **Verify target entity exists** using `read_entity`
   2. **Create reference field** with:
      - `format: "reference"`
      - `reference_table: "<target_table_name>"`
      - `reference_delete_mode: "restrict"` (strong dependency) or `"clear"` (optional link)
      - Optional: `relationship_label` — verb describing what the referenced entity does (e.g. `"employs"`, `"heads"`); used in ER diagrams and navigation labels

   **Steps for a `parent` field:**

   1. **Verify target entity exists** using `read_entity`
   2. **Create parent field** with:
      - `format: "parent"`
      - `reference_table: "<target_table_name>"`
      - `reference_delete_mode: "cascade"` (default — children are deleted with the parent)
      - Optional: `relationship_label` — verb label for ER diagrams and navigation
      - Optional: `singular_label_parent` / `plural_label_parent` — override the default labels inherited from the parent entity (e.g. use `"Billing Address"` instead of `"Address"` when a customer has multiple address roles)

   **Steps for a junction table (M:N):**

   1. **Create the junction entity** (e.g., `user_roles`, `product_tags`)
   2. **Create two `parent` fields**, one for each side of the relationship:
      - Both use `format: "parent"`, `reference_delete_mode: "cascade"`
      - Example: `user_id` → `users` and `role_id` → `roles`

   **Examples:**

   *"Each lead should have a sales rep assigned"*
   - `create_field` on leads: `format: "reference"`, `reference_table: "users"`, `reference_delete_mode: "clear"`, `title: "Sales Rep"`

   *"Add line items to orders"*
   - `create_field` on order_lines: `format: "parent"`, `reference_table: "orders"`, `reference_delete_mode: "cascade"`, `title: "Order"`

   *"Create a product_tags junction between products and tags"*
   - `create_entity` for `product_tags`
   - `create_field` once with both parent fields in `data`:
     - `product_id`: `format: "parent"`, `reference_table: "products"`, `reference_delete_mode: "cascade"`
     - `tag_id`: `format: "parent"`, `reference_table: "tags"`, `reference_delete_mode: "cascade"`

   ---

   ### Entity Logic: Computed Fields and Validation Rules

   Entities can carry per-record derivation and validation logic via two optional entity-level properties, both stored as `format: json` and defaulting to `[]`.

   | Property | Type | Default | Purpose |
   |----------|------|---------|---------|
   | `computed_fields`  | array | `[]` | Ordered list of fields whose values are derived from the same record via JsonLogic. |
   | `validation_rules` | array | `[]` | Ordered list of record-level invariants that must hold for a write to succeed. |

   The platform evaluates these on every INSERT and UPDATE: `computed_fields` first (in order, each result written back into the working record), then `validation_rules` (in order, any failing rule rejects the write).

   **Trigger lifecycle.** When both arrays are empty or null, no entity trigger function exists. As soon as one becomes non-empty, the platform generates a BEFORE INSERT/UPDATE function on the table. When both arrays go back to empty, or the entity is deleted, the function is dropped.

   #### `computed_fields` element shape

   | Property | Type | Required | Purpose |
   |----------|------|----------|---------|
   | `name` | string | yes | Must reference an existing scalar field on the same entity. The computed result is written into this slot. Dotted paths (e.g. `metadata.name`) write into nested JSONB properties. |
   | `jsonlogic` | object | yes | Evaluated against the record being written. |
   | `description` | string | no | Human note for future readers and agents. |

   Sample:

   ```json
   [
     {
       "name": "rice_score",
       "description": "(reach × impact × confidence) / effort, null when effort is missing or 0.",
       "jsonlogic": {
         "if": [
           { "and": [
             { "!=": [{ "var": "effort_score" }, null] },
             { ">":  [{ "var": "effort_score" }, 0] }
           ]},
           { "/": [
             { "*": [
               { "var": "reach_score" },
               { "var": "impact_score" },
               { "var": "confidence_score" }
             ]},
             { "var": "effort_score" }
           ]},
           null
         ]
       }
     }
   ]
   ```

   #### `validation_rules` element shape

   | Property | Type | Required | Purpose |
   |----------|------|----------|---------|
   | `code` | string | yes | snake_case, unique within the entity. Stable identifier for UI / i18n binding. |
   | `message` | string | yes | Default English text returned to the caller on failure. |
   | `jsonlogic` | object | yes | Must evaluate truthy for the record to be valid. |
   | `description` | string | no | Human note explaining why this rule exists. |

   Sample:

   ```json
   [
     {
       "code": "release_only_when_committed",
       "message": "A release can only be assigned once the feature is planned, in_progress, or shipped.",
       "description": "Mirrors §3.2 of the product_roadmap semantic model.",
       "jsonlogic": {
         "or": [
           { "==": [{ "var": "release_id" }, null] },
           { "in": [
             { "var": "feature_status" },
             ["planned", "in_progress", "shipped"]
           ]}
         ]
       }
     }
   ]
   ```

   #### Evaluation order

   On every INSERT or UPDATE the generated trigger:

   1. Builds `newValues` from the record's column values plus the reserved variables below.
   2. Walks `computed_fields` in order. For each entry it calls `evaluate_json_logic` with `newValues` and writes the result into `newValues` under the entry's `name` (dotted paths update nested JSONB properties).
   3. Walks `validation_rules` in order. For each entry it calls `evaluate_json_logic` with `newValues`. When the call returns null, the trigger raises an error containing the rule's `code` and `message`, and the write is rejected.
   4. If every rule passes, the write proceeds with the post-derivation `newValues`.

   If `evaluate_json_logic` itself throws, the raised error must include the offending entry's `name` (for computed fields) or `code` (for validation rules) together with the inner error.

   #### Reserved variables

   JsonLogic expressions may read these injected variables via `{"var": "$name"}`:

   | Var | Type | Meaning |
   |-----|------|---------|
   | `$today`   | date      | Server date at evaluation time. |
   | `$now`     | date-time | Server timestamp at evaluation time. |
   | `$user_id` | uuid      | Authenticated user performing the write (null when the write is system-initiated). |
   | `$old`     | object    | Previous row as JSON on UPDATE; null on INSERT. |


   ---

   ### Row-Level Read Access via `select_rule`

   Entities can carry an optional `select_rule` (JSONB object, default `{}`) that is evaluated per row to determine whether the current user is allowed to view the record. It complements the entity-level `view_permission` gate: `view_permission` controls whether a user can read the entity at all; `select_rule` filters which rows that user sees.

   - **Return type:** `select_rule` MUST evaluate to a boolean. `true` means the row is visible; `false` means it is filtered out by the FOR SELECT RLS policy.
   - **Trigger lifecycle:** When `select_rule` is non-empty, the platform generates a FOR SELECT RLS policy function for the table. When the rule is cleared (back to `{}`) or the entity is deleted, the policy is dropped.
   - **Reserved variables:** The same `$today`, `$now`, `$user_id`, and `$old` variables from the validation/computed-field context are available; `$user_id` is the typical anchor for ownership checks.
   - **Use sparingly:** Per-row evaluation runs on every read, so keep the JsonLogic simple — prefer direct comparisons to columns and reserved variables over deep traversals.

   Sample (a row is visible if its `owner_id` matches the current user, or its `visibility` column is `public`):

   ```json
   {
     "or": [
       { "==": [{ "var": "owner_id" }, { "var": "$user_id" }] },
       { "==": [{ "var": "visibility" }, "public"] }
     ]
   }
   ```

   ---

   ### Dynamic `input_type` via `input_type_rule`

   Fields can carry an optional `input_type_rule` (JSONB object, default `{}`) that dynamically overrides the static `input_type` value at runtime. It is useful when a field's editability or visibility depends on the record's state.

   - **Return type:** `input_type_rule` MUST evaluate to one of the valid `input_type` enum values: `"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`. The returned value replaces the static `input_type` for that record.
   - **Evaluated client-side** against the current form record; reserved variables (`$today`, `$now`, `$user_id`) are available where relevant.
   - **Falls back** to the static `input_type` when the rule is empty (`{}`) or evaluates to something other than a valid enum value.

   Sample (an `approved_at` field is `readonly` once `status` is `approved`, otherwise standard `default`):

   ```json
   {
     "if": [
       { "==": [{ "var": "status" }, "approved"] },
       "readonly",
       "default"
     ]
   }
   ```

   ---

   ### Configure RBAC

   When user says: *"Sales managers should be able to edit leads"* or *"Create a viewer role"*

   **Steps:**

   1. **Check if permissions exist**:
      - Use `read_permission` to find existing permissions
      - If not found, create with `create_permission` using `<module>:<action>` naming and field `permission_name`

   2. **Create or update role**:
      - Use `read_role` to check if role exists
      - Create with `create_role` if needed
      - Leave `origin` unset on manual creation — it defaults to `"user"`. Never set `origin` to `"system"`, `"model"`, or `"model_master"` from the agent; those values are reserved for the platform (DB init seed, semantic-model deploys, and the promotion / master-model deploy flow respectively).
      - Leave `slug` unset unless the user explicitly requests a specific slug — the database derives it from `role_name` via slugify on INSERT.

   3. **Grant permissions to role**:
      - Use `create_role_permission` to link role to permissions
      - Use `create_permission_hierarchy` if a permission should include another (e.g., `crm:manage` implicitly includes `crm:read`). Set `including_permission_name` to the broader permission (`crm:manage`) and `included_permission_name` to the narrower one (`crm:read`). Leave `origin` unset on creation (defaults to `"user"`). `permission_hierarchy.origin` is strictly immutable after INSERT — no upgrade paths.

   4. **Assign role to user** (if requested):
      - Find user with `read_user`
      - Create mapping with `create_user_role`

   ---

   ### Role `slug` and `origin`

   Every role carries two metadata fields used by the scaffold and promotion pipelines:

   - **`slug`** — snake_case, unique, NOT NULL. Auto-derived from `role_name` via slugify on INSERT when omitted. Always populated. Immutable when `origin` is `"system"`, `"model"`, or `"model_master"` (platform-owned roles); mutable for `origin = "user"` (admins can rename their own roles freely).
   - **`origin`** — one of `"system"`, `"model"`, `"model_master"`, or `"user"`. Defaults to `"user"` for manually created roles. The other three values are reserved for the platform and must never be set by the agent:
     - `"system"` — platform built-ins seeded at DB init (e.g. `Administrator`, `User`). Strictly immutable.
     - `"model"` — scaffold role on a domain module, created by a `*-semantic-model.md` deploy. Slug pattern `<module_slug>_viewer` / `_manager` / `_admin`.
     - `"model_master"` — scaffold role on a master module, created by promotion or master-model deploy. Same slug pattern.

   **Allowed transitions after INSERT** (enforced by validation rule):
   - `"user"` -> `"model"` — auto-claim into a domain module scaffold.
   - `"user"` -> `"model_master"` — auto-claim into a master module scaffold.
   - All other transitions are blocked, including any change involving `"system"`. These auto-claim transitions are performed by the platform, not the agent.

   ### Module scaffolding columns

   The `modules` table carries scaffold and promotion metadata that is populated by the platform, not by the agent:

   - **`module_type`** — `"domain"` (default) or `"master"`. Set to `"master"` only by the promotion flow; never assign manually.
   - **`manage_permission`** — the manage permission's name, populated by the scaffold pass.
   - **`admin_permission`** — the admin permission's name, populated by the scaffold pass only when any entity in the module carries `edit_permission: "admin"`.
   - **`default_viewer_role_id`** / **`default_manager_role_id`** — FKs to `roles.id`, populated by the scaffold pass.
   - **`default_admin_role_id`** — FK to `roles.id`, populated by the scaffold pass when `admin_permission` is present.

   Leave all six fields unset when calling `create_module` / `update_module` — the scaffold pass owns them.

   ### Permission hierarchy columns

   A row in `permission_hierarchy` encodes one inclusion edge: the **including** permission implies the **included** permission. Read each row as:

   `including_permission_name` ── *includes* ──▶ `included_permission_name`

   The same row, read the other way, is "`included_permission_name` is *included in* `including_permission_name`".

   - **`including_permission_name`** — the broader permission, the one doing the including (e.g. `crm:manage` in `crm:manage includes crm:read`).
   - **`included_permission_name`** — the narrower permission, the one being included (e.g. `crm:read`).

   Whether a row is intra-master or cross-module is derivable from the `module_id` of each side.

   ### Permission hierarchy `origin`

   Every `permission_hierarchy` row carries an `origin` of `"system"`, `"model"`, `"model_master"`, or `"user"` (default for new records):

   - `"system"` — platform-seeded at DB init.
   - `"model"` — row declared in a model file's §2 Permissions summary table.
   - `"model_master"` — auto-created by the deployer as a side effect of promotion or Branch A wire-up; covers both the master's internal chain (`<master>:manage -> <master>:read`) and cross-module bridges (`<consumer>:read -> <master>:read`).
   - `"user"` — manually added by an admin.

   `permission_hierarchy.origin` is **strictly immutable after INSERT — no upgrade paths**. The auto-claim path applies only to `roles`.

   ---

   ### Search Records

   When user says: *"Find contacts named Monica"* or *"Search for leads from Allvue"*

   **Steps:**

   1. Check if entity is searchable using `read_entity` — look for `searchable: true` (this is `true` when at least one field has `searchable: true`)
   2. Use `wfts(simple)` on the `search_vector` column: `?search_vector=wfts(simple).<term>`
      - `search_vector` is a computed column automatically maintained by the system across all searchable fields
      - Always use `wfts(simple)` — the `simple` text search configuration is language-agnostic and required for multilingual content. Never use bare `wfts` or `fts`.
   3. Only use field-specific filters (`ilike`, `eq`, etc.) when the user specifies a particular column or when the table is not searchable

   ---

   ### Evolve Existing Model

   When user says: *"Add an email field to customers"* or *"Make status required"*

   **For adding fields:**
   - Use `create_field` on existing `table_name` (pass an array in `data` when adding several fields at once)
   - Safe to add new fields anytime

   **For modifying fields:**
   - Use `read_field` first to see current state
   - Use `update_field` with only the changed attributes
   - Warn user about risky changes (see Safe Evolution Patterns below)

   **For removing fields:**
   - Check if field is referenced elsewhere: `read_field` with `filters: "reference_table=eq.<table>"`
   - Warn user about data loss
   - Use `delete_field` only after explicit confirmation

   ---

   ## Safe Evolution Patterns

   ### ✅ Low-Risk Changes (do freely)
   - Add new fields
   - Add new permissions/roles/role assignments
   - Update descriptions, labels, UI hints
   - Add `searchable: true` to fields
   - Create new entities in new or existing modules

   ### ⚠️ Medium-Risk Changes (warn user before proceeding)
   - Changing `reference_delete_mode`
   - Adding view/edit permissions to previously open entities
   - Changing `enum_values`
   - Adding `unique_value: true` to an existing field (will fail if duplicate values exist — suggest deduplication first)
   - These may affect existing data or access patterns

   ### 🛑 High-Risk Changes (require explicit user confirmation)
   - Renaming `table_name` or `field_name` (breaks all references)
   - Deleting entities or fields (permanent data loss)
   - Removing permissions still in use by roles
   - Changing primary key fields
   - **Always check dependencies before deletion**

   ---

   ## Troubleshooting Common Issues

   ### "Permission denied" errors

   **Diagnosis workflow:**
   1. Call `getCurrentUser` to see the user's effective permissions
   2. Call `read_entity` on the table to see required `view_permission` / `edit_permission`
   3. Check if user has the required permission in their list
   4. If not, trace through: user → `user_roles` → `role_permissions` → `permission_hierarchy`

   **Resolution:** Grant the missing permission to the user's role, or assign a role that already has it.

   ---

   ### Fields not displaying correctly

   **Check:**
   - Entity has `label_column` set and it matches a real field with `ctype='label'`
   - Fields have appropriate `width` (see Field Format Quick Reference)
   - Fields have proper `field_order` for display sequence
   - `input_type` is appropriate for the use case (see Field Format Quick Reference)

   ---

   ## Field Format Quick Reference

   Choose the appropriate `format` when creating fields:

   > ⚠️ `format` can be changed, but only to another format within the same primitive type (e.g. `text` → `email` is safe; `text` → `number` is not). Changing to an incompatible primitive type is high-risk and requires explicit planning with the user.

   | Category | Values |
   |----------|--------|
   | **Text** | `string`, `text`, `multiline`, `html`, `code` |
   | **Numbers** | `integer`, `int32`, `int64`, `number`, `float`, `double` — **use `number` for all monetary/currency/amount fields; `float`/`double` only when explicitly requested.** For `number` format, set `precision` to control decimal places (default 2). |
   | **Dates/Time** | `date`, `time`, `date-time`, `duration` |
   | **Relationships** | `reference` (cross-entity link, independent lifecycle — default delete: `restrict`) |
   | **Composition** | `parent` (ownership/composition, child lifecycle bound to parent — default delete: `cascade`; also used for M:N junction FKs) |
   | **Choice** | `enum` (requires `enum_values` array) |
   | **Boolean** | `boolean` |
   | **Structured** | `json`, `object`, `array` |
   | **Identifiers** | `uuid`, `email`, `uri`, `url` |

   ---

   ### Nullability and Default Values

   > ℹ️ **Never set `is_nullable` or `default_value` manually.** Both are computed automatically from `format` by the system trigger on field creation. The table below shows what the system assigns.

   | Format(s) | PostgreSQL type | Auto default | Nullable? |
   |-----------|-----------------|--------------|-----------|
   | `string`, `text`, `multiline`, `html`, `code`, `email`, `url`, `uri`, `uuid`, `password` | TEXT | `''` | NOT NULL |
   | `enum` | TEXT | `''` unless `input_type: "required"`, then first entry of `enum_values` | NOT NULL |
   | `integer`, `int32`, `int64` | INTEGER / BIGINT | `0` | NOT NULL |
   | `number`, `float`, `double` | NUMERIC / REAL | `0.0` | NOT NULL |
   | `boolean` | BOOLEAN | `FALSE` | NOT NULL |
   | `json`, `object`, `array` | JSONB | `'{}'` | NOT NULL |
   | `date-time` | TIMESTAMPTZ | `CURRENT_TIMESTAMP` | NULL allowed |
   | `date` | DATE | `CURRENT_DATE` | NULL allowed |
   | `reference` | FK (UUID) | — | NULL allowed |
   | `parent` | FK (UUID) | — | NOT NULL |

   ---

   > 🛑 **CRITICAL: `reference_table` always requires `format: "reference"` or
   > `format: "parent"`**
   > If a field has `reference_table` set, its `format` MUST be either
   > `"reference"` or `"parent"`. Any other format (`integer`, `uuid`, `string`,
   > etc.) will **always fail**. There are no exceptions.
   > - Use `"reference"` for cross-entity links with independent lifecycles
   > - Use `"parent"` for ownership/composition and M:N junction FKs
   > - **Never** combine `reference_table` with any scalar format


   ### `width` Values

   Controls the display width of a field in the UI.

   | Value | Meaning |
   |-------|---------|
   | `default` | **Default — always use this.** System selects the best width based on `format` and screen size. |
   | `s` | Small override (short text, booleans, status badges) |
   | `m` | Medium override |
   | `w` | Wide override (long text, descriptions) |

   > ⚠️ Always set `width: "default"` unless the user has a specific layout requirement. Manual width values should be avoided in most cases.

   ---

   ### `input_type` Values

   Controls how a field is rendered in forms.

   | Value | Meaning |
   |-------|---------|
   | `default` | Standard editable input — use for most fields |
   | `required` | Editable but marked as mandatory in the UI |
   | `readonly` | Displayed but not editable |
   | `disabled` | Shown greyed out, not editable |
   | `hidden` | Not shown in forms at all |


   ### `unique_value` Values

   Controls whether a field must contain a unique value across all records.

   | Value | Meaning |
   |-------|---------|
   | `true` | Field value must be unique — duplicates are rejected at the database level |
   | `false` | **Default.** No uniqueness constraint applied |

   **When to use:**
   - User-facing identifiers that must not collide (e.g., `email` on a contacts table)
   - External system keys imported from other platforms (e.g., `kunnr` from SAP, `external_id` from Salesforce)
   - Any field where duplicate records would cause data integrity issues

   > ⚠️ Adding `unique_value: true` to an existing field is a **medium-risk change** — it will fail if duplicate values already exist in the database. Always warn the user and suggest deduplication before applying.

   ---

   ### `cube_type` Values

   Controls how a field participates in OLAP cube generation (only relevant when the entity has `cube_mode: "auto"`).

   | Value | Meaning |
   |-------|---------|
   | `disabled` | Field excluded from cube |
   | `auto` | **Default.** System infers dimension or measure from `format` |
   | `dimension` | Explicit grouping axis (e.g. category, region, status) |
   | `measure` | Explicit numeric aggregation (e.g. revenue, count) |

   ---

   ### `precision` Values

   Controls the number of decimal places (scale) stored for `number`, `float`, and `double` fields. Only applies when the system generates a NUMERIC column.

   | Value | Meaning |
   |-------|---------|
   | `0` | Integer-like storage (no decimals) |
   | `2` | **Default.** Suitable for most monetary and percentage values |
   | `4`–`6` | Higher precision for exchange rates, unit prices, or scientific values |
   | `18` | Maximum supported scale |

   > ℹ️ Only set `precision` when the default of 2 is not appropriate. Omit it for most fields.

   ---

   ## Tool Reference

   ### Priority Rule
   **Always use typed CRUD tools for create, read, update, and delete operations.** Use `postgrestRequest` or `sqlToRest` only when:
   - A complex multi-filter or aggregation query cannot be expressed through typed tools
   - A bulk mutation must be selected by an arbitrary filter (not by a list of ids), or each row needs different values in one update

   ### Bulk Operations
   **Rule: if more than one record of the same kind is pending, send them in ONE call. Never loop single-record calls.** One array call is one HTTP request and one database transaction; N single calls are N round trips with partial-failure risk and no atomicity.
   - **`create_*`**: `data` is either one object or a **non-empty array of objects**. **Items do not need the same keys**: the server sends the union of keys and keys omitted from an item take the column default. All rows are inserted in one request and one transaction (all-or-nothing). Example: `create_field` with `data: [ {...description}, {...cost} ]`.
   - **`update_*`**: `id` is either one value or a **non-empty array of ids** (for `update_entity` the key is `table_name`). The **same** `data` is applied to every listed record. For per-record values, call once per record.
   - **`delete_*`**: `id` (or `table_name` for entities) is either one value or a **non-empty array**; all listed records are deleted in one request.
   - **Responses** are always an array of the created/updated/deleted records. Never combine an array input with `accept: application/vnd.pgrst.object+json` (that Accept value requests exactly one row and fails otherwise).
   - **Duplicate checks still apply**: before a bulk `create_*`, run one `read_*` with an `in.(...)` filter covering all items (e.g. `field_name=in.(description,cost)&table_name=eq.services`).
   - Keep batches reasonable (roughly up to 100 rows or ids per call); split larger sets.
   - Typical batches: all fields of a new entity, the `<module>:read` + `<module>:manage` permissions of a new module, all `role_permission` rows of a role, all `permission_hierarchy` rows of a module.
   - `postgrestRequest` also accepts an array `body`, but with raw PostgREST rules: all items must have **identical keys** unless you add `?columns=col1,col2` to the path, and omitted keys become NULL (no `missing=default`). Prefer the typed tools for bulk writes.

   ### Entity Management
   - **read_entity** — Query entities (use `filters` to find by `table_name` before creating)
   - **create_entity** — Define a new domain concept
   - **update_entity** — Modify entity metadata or permissions
   - **delete_entity** — Remove entity (check all dependencies first!)

   ### Field Management
   - **read_field** — Query fields (filter by `table_name`; also use to find cross-references before deletion)
   - **create_field** — Add an attribute to an entity
   - **update_field** — Modify field properties. ⚠️ `format` can only be changed to another format with the same primitive type.
   - **delete_field** — Remove field (warn user about data loss; require confirmation)

   ### Module Management
   - **read_module** — Check if a module exists before creating one
   - **create_module** — Create a new domain grouping
   - **update_module** — Modify module metadata
   - **delete_module** — Remove module (check all dependent entities first!)

   ### RBAC Tools
   - **read_permission** / **create_permission** — Manage atomic capabilities
   - **read_permission_hierarchy** / **create_permission_hierarchy** — Set up permission inheritance
   - **read_role** / **create_role** — Manage permission bundles
   - **read_role_permission** / **create_role_permission** — Grant permissions to roles
   - **read_user** / **create_user** — User identity management
   - **read_user_role** / **create_user_role** — Assign roles to users

   ### Utilities
   - **getCurrentUser** — Get current user's profile and effective permissions. Also returns `api_baseurl` (for webhook/hook endpoints), `semantius_org` (the org slug), and `ui_baseurl` (the web UI base, e.g. `https://<org>.semantius.app`) for building links to the web user interface:
     - List of records for an entity: `{ui_baseurl}/{module_slug}/{table_name}` (e.g. `https://mytest.semantius.app/hiring-starter/job_applications`)
     - A specific record: `{ui_baseurl}/{module_slug}/{table_name}/{id}` (e.g. `https://mytest.semantius.app/hiring-starter/job_applications/719`)
   - **postgrestRequest**: Direct PostgREST API for complex queries, filter-based bulk mutations, or per-row differing updates (typed tools already cover array creates and id-list updates/deletes)
   - **sqlToRest** — Convert SQL to PostgREST format for complex operations

   ---

   ## Agent Workflow Tips

   1. **Always read before writing** – Before any `create_*`, call the corresponding `read_*` to check for duplicates or find existing records. Example: always call `read_entity` filtering by `table_name` before `create_entity`. For a bulk create, one `read_*` with an `in.(...)` filter covers all items.
   2. **Resolve prerequisites in order** – Module → Permissions → Entity → Fields. Never skip steps.
   3. **Batch related writes** – Put all fields of one entity, both baseline permissions of one module, or all `role_permission` rows of one role into a single `create_*` call with an array in `data`; use an id array for `update_*` / `delete_*` across several records. Fewer calls, one transaction.
   4. **Be conversational** – Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
   5. **Validate semantic correctness** – Does the model make sense for the user's domain?
   6. **Ask for clarification when needed** – If a user says "add contacts", confirm what fields they need before creating anything.
   7. **Warn before risky changes** – Alert the user to medium/high-risk changes and wait for confirmation before executing.
   8. **Suggest next steps** – After creating an entity, suggest related entities, missing fields, or useful roles.
   9. **Provide link to UI** when you are done with creating or updating entities or fields provide a link to the user so they can verify your changes. Use the `ui_baseurl` from `getCurrentUser`: a list of records is `{ui_baseurl}/{module_slug}/{table_name}` and a specific record is `{ui_baseurl}/{module_slug}/{table_name}/{id}` (e.g. `https://mytest.semantius.app/hiring-starter/job_applications/719`).



   ## File Import via Webhooks

When a user wants to import records from a CSV, Excel, or TXT file into a Semantius entity, use the webhook-based import approach instead of creating records one by one via MCP tools.

### Step 1 — Identify the Target Entity

Use `read_entity` and `read_field` to confirm the entity exists and retrieve all its fields (names, titles, formats). You'll need these for column mapping.

### Step 2 — Check for or Create the Webhook Receiver

Search for an existing receiver named **"Agent Import"** scoped to this table:
```
read_webhook_receiver(filters: "label=eq.Agent Import&table_name=eq.<table_name>")
```

- **If found:** reuse its `id` and `secret`.
- **If not found:** create one:
  - `label`: `"Agent Import"`
  - `table_name`: target table
  - `auth_type`: `"hmac"`
  - `secret`: randomly generated 10-character alphanumeric string (e.g. `aB3kP9mXqZ`)

### Step 3 — Construct the Endpoint URL

Call `getCurrentUser` and extract `api_baseurl`. The webhook endpoint is:
```
{api_baseurl}/hook/{webhook_receiver_id}
```

### Step 4 — Map Columns to Fields

Compare file headers to entity field names/titles:

- **Exact or obvious match** (e.g. "first_name", "First Name" → `first_name`): auto-map silently
- **Reasonable match** (e.g. "Email Address" → `email`): auto-map and mention it in your summary
- **Ambiguous or no match**: ask the user before generating code

Never map file columns to fields with `input_type: "readonly"` — these are system-controlled and cannot be imported.

### Step 5 — Generate the Python Import Script

Use the Standard Webhooks signing scheme:

- **Signed content:** `{webhook-id}.{webhook-timestamp}.{body}` (body is the raw JSON string)
- **Algorithm:** HMAC-SHA256; decode the secret from base64 first (`secret` field stored in the receiver is the raw value — base64-encode it before decoding, or treat it directly as bytes depending on how Semantius stores it — verify with a test call)
- **Signature header value:** `v1,{base64_encoded_signature}`
- **Required headers on every request:**
  - `webhook-id`: a unique message ID (e.g. `msg_{uuid4}`)
  - `webhook-timestamp`: current Unix timestamp as an integer string
  - `webhook-signature`: `v1,{signature}`
  - `Content-Type`: `application/json`

Each record is sent as one POST request. Include a progress counter and print failed rows with their HTTP status and response body so the user can fix and retry.
```python
import csv, json, hmac, hashlib, base64, time, uuid, requests

WEBHOOK_URL = "<api_baseurl>/hook/<receiver_id>"
SECRET = "<raw_secret>"          # the 10-char secret from the receiver record
SECRET_BYTES = base64.b64decode(base64.b64encode(SECRET.encode()))  # treat as bytes

MAPPING = {
    "ColumnNameInFile": "field_name_in_entity",
    # ... add all mapped columns
}

def sign(msg_id, timestamp, body):
    signed = f"{msg_id}.{timestamp}.{body}"
    sig = hmac.new(SECRET_BYTES, signed.encode(), hashlib.sha256).digest()
    return "v1," + base64.b64encode(sig).decode()

with open("import.csv", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader, 1):
        payload = {MAPPING[k]: v for k, v in row.items() if k in MAPPING}
        body = json.dumps(payload, separators=(",", ":"))
        msg_id = f"msg_{uuid.uuid4().hex}"
        ts = str(int(time.time()))
        headers = {
            "Content-Type": "application/json",
            "webhook-id": msg_id,
            "webhook-timestamp": ts,
            "webhook-signature": sign(msg_id, ts, body),
        }
        resp = requests.post(WEBHOOK_URL, data=body, headers=headers)
        if resp.status_code >= 300:
            print(f"Row {i} FAILED ({resp.status_code}): {resp.text}")
        else:
            print(f"Row {i} OK")
```

Adapt the file parsing for Excel (use `openpyxl` or `pandas`) or tab-delimited TXT files as needed. Always send the JSON body as a compact string (no extra spaces) — the signature is sensitive to any formatting change.
