// Auto-generated from src/SKILL.md by scripts/sync-postgrest-mcp.ts — do not edit manually
export const instructions = `   ---
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
   - **Entities:** \`singular_label\`, \`plural_label\`, \`description\` define *what the concept means*
   - **Fields:** \`title\`, \`description\` explain *what each attribute represents*
   - **UI hints:** \`icon_name\`, \`name_sort\`, \`width\`, \`field_order\` control *how concepts appear*

   ### 2. Relationships
   Fields reference other entities via \`reference_table\`. There are two relationship formats:

   - **\`reference\`** — Cross-entity relationship. The referenced record has an independent lifecycle. The column allows NULL.
   - Delete mode default: \`restrict\` (deleting the referenced record is refused while records reference it)
   - Use when: child can exist or be meaningful without the parent (e.g., Order → Customer)

   - **\`parent\`** — Ownership/composition. The child's lifecycle is bound to the parent. The column is NOT NULL, and the parent lists the child among its children.
   - Delete mode: normally \`cascade\` (see below)
   - Use when: child cannot meaningfully exist without the parent (e.g., OrderLine → Order)
   - Also used for **junction tables** in M:N relationships — both FK fields use \`format: "parent"\` (e.g., \`user_roles.user_id\` and \`user_roles.role_id\`)

   **\`reference\` delete modes:**
   - \`restrict\`: Strong dependency — the referenced record cannot be deleted while records reference it
   - \`clear\`: Weak/optional relationship — the field is set to NULL when the referenced record is deleted (e.g., Ticket → AssignedUser)

   **\`parent\` delete modes:**
   - \`cascade\` (the normal choice, since a child usually shares its parent's permissions): deleting the parent deletes its children.
   - \`restrict\` (rare): for a child that has its own permissions or an audit log with its own lifecycle (scorecards, signed offers). A cascade does not check the child's own delete permission (a Postgres referential action does not apply row-level security); \`restrict\` refuses the parent's deletion while children exist, so each child is removed through its own permission. Keep the format \`parent\` and change the delete mode; a \`reference\` would be optional and drop out of the parent's child list.
   - \`clear\` never works on a \`parent\`: the column is NOT NULL, so every delete of the parent would fail. A child that must survive its parent is a \`reference\` with \`clear\`.

   ### 3. Access Control (RBAC)
   - **Entity-level gates:** \`view_permission\` (read), \`edit_permission\` (write). \`edit_permission\` gates INSERT, UPDATE and DELETE alike; there is no separate delete permission. To let only some users delete (or approve, or close), add a \`validation_rules\` entry that tests \`\$mode\`.
   - **Permission flow:** Users → Roles → Permissions (with optional hierarchy)
   - **Effective permissions:** Computed from direct grants + inherited permissions
   - **Naming convention:** Use \`<module>:<action>\` (e.g., \`crm:read\`, \`crm:manage\`, \`leads:write\`). The platform accepts any name made of segments \`[a-z0-9][a-z0-9_-]*\` joined by \`:\` (zero or more colons), so \`admin\` is valid too

   ### 4. Domain Organization
   - **Modules:** Group related entities, permissions, and roles
   - Every entity **must** belong to a module
   - Used for navigation, branding, and logical boundaries

   ---

   ## Entity Reference Guide

   | Entity | Purpose | Key Relationships |
   |--------|---------|-------------------|
   | **entities** | Domain concept definition | Parent of fields; references module; uses permissions |
   | **fields** | Entity attributes/columns | Belongs to entity; may reference other entities; may aggregate a child entity (\`rollup\`) |
   | **modules** | Domain grouping | Referenced by entities/roles/permissions; carries \`module_type\` and the permission/role FKs (\`manage_permission\`, \`admin_permission\`, \`default_viewer_role_id\`, \`default_manager_role_id\`, \`default_admin_role_id\`) |
   | **permissions** | Atomic capabilities | Used by entities; granted to roles; can inherit |
   | **permission_hierarchy** | Permission inclusion | Each row says \`including_permission_name\` *includes* \`included_permission_name\` (the broader implies the narrower); carries immutable \`origin\` |
   | **roles** | Permission bundles | Granted permissions; assigned to users; carries \`slug\` and \`origin\` |
   | **role_permissions** | Role ↔ Permission mapping | M:N with audit fields |
   | **users** | Actor identities | Assigned roles via user_roles |
   | **user_roles** | User ↔ Role mapping | M:N with audit fields |

   ---

   ## Golden Rules for Agents

   1. **Labels are semantic contracts** – Set intentional, clear labels/descriptions on all entities and fields
   2. **References over raw IDs** – Use \`reference_table\` + \`reference_delete_mode\` for relationships
   3. **Security by default** – Set \`view_permission\` and \`edit_permission\` deliberately on new entities (the defaults are \`public:read\` and \`admin\`)
   4. **Additive changes first** – Prefer adding over deleting/renaming unless impact is understood
   5. **Validate before runtime** – Ensure one PK field (\`is_pk=true\`; a second one is refused with \`90215\`) and one label field (\`ctype='label'\`) per entity
   6. **Never create auto-generated fields** – When creating an entity, the system automatically creates \`id\`, the field named in \`label_column\` (the entity's label field), \`created_at\` and \`updated_at\`. Do **not** call \`create_field\` for any of these.
   7. **Every entity needs a module** – Always assign a \`module_id\`. If no suitable module exists, create one first (see Module Workflow below).
   8. **Modules need baseline permissions** – By convention every new module has at least \`<module>:read\` and \`<module>:manage\` permissions.
   9. **CRUD tools have priority** – Always use the typed CRUD tools (\`create_*\`, \`read_*\`, \`update_*\`, \`delete_*\`) for standard operations. Only use \`postgrestRequest\` or \`sqlToRest\` for complex queries, filter-based bulk mutations, or updates where each row needs different values.
   10. **🚀 Always batch: one call per set of records, never a loop of single calls** – Whenever more than one record of the same kind is pending (several fields for an entity, several permissions for a module, several role_permission rows, several ids to update or delete), send them **in one call**: pass an array in \`data\` to \`create_*\`, or an array in \`id\` (\`table_name\` for entities) to \`update_*\` / \`delete_*\`. Array items do **not** need the same keys. Issuing N single-record calls where one array call would do is a mistake. See *Bulk Operations* under Tool Reference.
   11. **Permission naming convention** – Use \`<module>:<action>\` (e.g., \`crm:read\`, \`crm:manage\`); the platform accepts any valid permission name
   12. **\`reference_table\` mandates relational format** — Any field with a \`reference_table\` MUST use \`format: "reference"\` or \`format: "parent"\`.
   13. **\`number\` is the default for amounts and currencies** — Any field representing money, prices, totals, rates, or similar measured quantities must use \`format: "number"\`. Use \`float\` or \`double\` only when the user explicitly requests it or the field stores inherently imprecise values (e.g., scientific measurements, ML scores, GPS coordinates). Never default to \`float\` or \`double\` for financial data. Set \`precision\` to control decimal places (default 2); omit it unless a different scale is needed.
      Setting any scalar format (\`integer\`, \`string\`, \`uuid\`, etc.) alongside \`reference_table\` is always wrong and will always fail. No exceptions.
   14. **Aggregates over child records are rollups** — A value summed, counted or otherwise aggregated from child records is a field with a \`rollup\` definition, never a \`computed_fields\` rule or a value the client maintains. See *Rollup Fields*.

   ---

   ## Common Workflows

   > 🚀 **Batching applies to every workflow below.** Whenever a step produces more than one record of the same kind, make **one** tool call with an array (\`data: [...]\` for \`create_*\`, \`id: [...]\` for \`update_*\` / \`delete_*\`). Do not call the same tool once per record. Items in the array may have different keys.

   ### Create a Module (prerequisite for new entities)

   When no suitable module exists for a new entity, always create the module first.

   **Required steps:**

   1. **Check if a matching module exists** using \`read_module\` (filter by \`module_name\`)

   2. **If not found, create the module** with:
      - \`module_name\` — the module's display name, unique (e.g., \`CRM\`, \`Inventory\`)
      - \`description\`
      - \`module_slug\` — the module's identifier in UI paths (\`{ui_baseurl}/{module_slug}/...\`) and the prefix of its permissions: lowercase, starting with a letter or digit, only \`a-z\`, \`0-9\`, \`-\` and \`_\` (\`^[a-z0-9][a-z0-9_-]*\$\`, \`90702\`). Optional: when empty it is derived from \`module_name\` (lowercased, every run of other characters replaced by \`-\`, leading and trailing \`-\` and \`_\` removed). A name with no ASCII letter or digit derives an empty slug, and a second such module collides on the unique slug, so pass it in that case.
      - Optional: \`access_scope\` — permission structure of the module: \`"custom"\` (default), \`"basic"\`, \`"advanced"\`, \`"gated"\` or \`"raci"\`. Leave unset for ordinary modules.
      - Optional: \`icon_name\` — the icon to show for the module in navigation: a Lucide icon name (see Field Format Quick Reference) or an icon URL; leave unset unless the user requests a specific icon.

   3. **Create baseline permissions** (always both):
      - \`<module>:read\` — grants read access to the module's entities
      - \`<module>:manage\` — grants full write access to the module's entities

   4. **Create a default role** (recommended):
      - E.g., \`<module>_viewer\` with \`<module>:read\`
      - E.g., \`<module>_manager\` with \`<module>:read\` + \`<module>:manage\`

   **Example:** User asks to add a "Service Catalog" feature with no existing module.

   **Agent actions:**
   - Call \`read_module\` to check for existing modules — none found
   - Call \`create_module\` with \`module_name: "Service Catalog"\`, \`module_slug: "service_catalog"\` and a \`description\`
   - Call \`create_permission\` once with \`data: [{ permission_name: "service_catalog:read" }, { permission_name: "service_catalog:manage" }]\` (one bulk call instead of two)
   - Proceed to create entity with the new \`module_id\`

   ---

   ### Create a New Domain Concept

   When user says: *"Add a lead tracker to the CRM"* or *"Create a products table"*

   **Required steps:**

   1. **Resolve the module** – Use \`read_module\` to find a matching module. If none exists, complete the Module Workflow above first.

   2. **Resolve permissions** – Use \`read_permission\` to find suitable \`view_permission\` and \`edit_permission\`. Use module-level permissions (e.g., \`crm:read\`, \`crm:manage\`) or create entity-specific ones if needed.

   3. **Create the entity** with:
      - \`table_name\` (lowercase, snake_case, **always plural**; e.g., \`customers\`, \`categories\`; never ending in \`_ext\`, which is reserved) — renaming is high-risk: breaks all references
      - \`singular\` – optional; derived from \`table_name\` when blank (\`services\` becomes \`service\`, \`cities\` becomes \`city\`)
      - \`singular_label\` – human-readable singular noun (e.g., "Service", "Company"), symmetric with \`plural_label\`. Pass it: when blank it is derived from \`label_column\` (\`service_name\` becomes "Service Name"). It does not set the title of the label field, which is always "Name".
      - \`plural\` – do not pass it: the platform always sets it to \`table_name\`
      - \`plural_label\` (e.g., "Services", "Companies")
      - \`description\` (clear explanation of what this concept represents)
      - \`label_column\` – the snake_case **field name** whose value identifies a record (e.g., \`service_name\`, \`company_name\`). This must be a snake_case identifier, not a human-readable title. Always single-line text: it is created as \`text\` and, as a core column, its format never changes (\`90219\`), so it is never an enum, number, date, boolean or FK. Omit it for a junction (the platform composes its \`_label\` from the records it relates; set the auto \`label\` field's \`input_type\` to \`default\`) and for an \`is_a\` or \`has_a\` entity: it comes from the base (\`90242\`).
      - \`module_id\` (required — use resolved module)
      - \`view_permission\` and \`edit_permission\` – optional (defaults \`public:read\` and \`admin\`); set both deliberately. Each must name an existing permission.
      - Optional: \`icon_name\` — the icon to show for the entity: a Lucide icon name (see Field Format Quick Reference) or an icon URL; leave unset unless the user requests a specific icon.
      - Optional: \`name_sort\` — sort key that orders entities in navigation; leave unset unless the user wants a specific navigation order.
      - Optional: \`edit_mode\` — controls how records open for editing: \`auto\` (default, system decides), \`sidebar\`, \`modal\`, or \`page\`
      - Optional: \`cube_mode\` — OLAP cube generation: \`auto\` (default, include in cube) or \`disabled\`
      - \`audit_log\`: Optional boolean, default \`false\`. When \`true\`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value.
      - Optional: \`managed\` — When \`false\`, automatic DDL execution is disabled for this entity. Leave unset (defaults to \`true\`) for normal entities where Semantius manages the database schema. Set to \`false\` only for external or legacy tables where DDL is managed outside the platform.
      - Optional: \`order_column\` — Enable fixed, user-defined row ordering (e.g. drag-and-drop) by naming the snake_case field that stores the sort position. The platform provisions that INTEGER column and, when an insert sends no value, assigns the highest value below 900000 plus 10 (10 for the first record). Leave unset (default \`''\`) unless the user wants records to keep a manual order rather than a natural/sorted one.
      - Optional: \`id_type\` — the key type of the table. **Chosen once on create and locked afterwards** (an update that changes it fails with \`90233\`), so decide before creating:
        - \`auto_increment\` (default, leave it unset): a 64-bit number the database assigns. Right for almost every entity.
        - \`uuid\`: a time-ordered UUIDv7 the database assigns. Use when ids must be unguessable or created by several systems without coordination.
        - \`typeid\`: a prefixed, sortable id such as \`acct_01h455vb4pex5vsknk084sn02q\`, assigned by the database. Use when ids appear in URLs, logs or support tickets and should say what they are. **Requires \`id_prefix\`.**
        - \`bigint\` / \`text\`: the caller supplies the key on every insert (e.g. an external system's numeric id, or a natural code like an ISO country code). Only when the user has such a key.
        - \`is_a\` / \`has_a\`: a subtype or an optional extension of another entity, sharing its key. **Requires \`id_refentity\`** (and \`id_prefix\` for \`is_a\`). See **Inheritance and Extensions** below before choosing either.
        - \`computed\` is for system tables only; never use it.
      - \`id_prefix\` — only with \`id_type: "typeid"\` or \`"is_a"\`, and then required: a short lowercase name for the records (e.g. \`acct\`, \`inv\`, \`cust\`), up to 63 lowercase letters and underscores, starting and ending with a letter, unique among entities. A \`typeid\` prefix can be changed later: new ids take the new prefix and ids already issued keep theirs. An \`is_a\` prefix never changes (\`90245\`), and a new \`is_a\` entity cannot take a prefix that records of its root still carry, such as one the root used before (\`90254\`).
      - \`id_refentity\` — only with \`id_type: "is_a"\` or \`"has_a"\`, and then required: the entity this one is based on. Set once on create; never send it on update (\`90241\`).
      - \`id_column\` — leave it unset: the key field is \`id\`. Like \`id_type\`, it is fixed on create; an update that changes it fails with \`90253\`.

      **The system automatically creates these fields — do NOT create them manually:**
      - \`id\` — primary key field (\`ctype: "id"\`, \`is_pk: true\`), typed from \`id_type\`: format \`int64\` for \`auto_increment\` and \`bigint\`, \`text\`, \`uuid\`, or \`string\` for \`typeid\`, \`is_a\` and \`has_a\`
      - The field named in \`label_column\` (e.g., \`service_name\`) with the title "Name"
      - \`created_at\` and \`updated_at\` timestamp fields

      > ⚠️ **Never call \`create_field\` for \`id\`, \`created_at\`, \`updated_at\`, or the field named in \`label_column\`. They already exist.**

      > ℹ️ An \`is_a\` or \`has_a\` entity gets only \`id\`, \`created_at\` and \`updated_at\`: its label field, and every other field of its base, is its base's. Its \`label_column\` is set from the base.

      > ℹ️ \`searchable\` and \`is_child\` on the entity are **read-only** and computed automatically (\`searchable\` when any field has \`searchable: true\`; \`is_child\` when any field uses \`format: "parent"\` — for an \`is_a\` or \`has_a\` entity, a field of its base's levels counts too). Never set these manually.

      > ℹ️ **There is no \`is_nullable\` field: nullability follows \`format\`.** Only \`reference\`, \`date\` and \`date-time\` allow NULL. \`default_value\` is optional and may be set; when it is blank, a NOT NULL column gets the zero value of its type (see *Nullability and Default Values*).

   4. **Add domain fields** based on user requirements (see Field Format Quick Reference below). Pass all fields of the entity to a single \`create_field\` call as an array in \`data\`.
      - Omit \`field_order\`: the platform appends each new field after the entity's existing ones in array order. A hand-picked value can sit above the label field's 20 or tie with a neighbor; values from 900000 up are outside the automatic numbering.
      - A \`field_name\` must not start with \`_\`: \`_label\` and \`<fk>_label\` are read-time projections of the composed label, absent from the \`fields\` catalog, selected by name (\`select=id,_label,customer_id_label\`) and never created, written or imported.
      - Never create a \`users\` entity: the built-in \`users\` table exists. Reference it with \`reference_table: "users"\`, and do not rename or change the format of any built-in field.
      - The \`catalog_*\` columns (\`catalog_entity_code\`, \`catalog_field_code\`, \`catalog_module_code\`, \`catalog_role_code\`) are stamped by spec deploys and write-once (set on create or filled once while empty, then never changed); never create them as fields.

   **Example user request:** "Add a service catalog with service name, description, and cost"

   **Agent actions:**
   - \`read_module\` → find or create \`service_catalog\` module
   - \`read_permission\` → find or create \`service_catalog:read\` and \`service_catalog:manage\`
   - \`create_entity\` with \`table_name: "services"\`, \`singular_label: "Service"\`, \`label_column: "service_name"\`, \`module_id: <id>\`, \`audit_log: false\`, etc.
   - System auto-creates: \`id\`, \`service_name\`, \`created_at\`, \`updated_at\`
   - \`create_field\` once with \`data: [ { table_name: "services", field_name: "description", title: "Description", format: "text", searchable: true }, { table_name: "services", field_name: "cost", title: "Cost", format: "number" } ]\` (both fields in one bulk call)

   **What NOT to do:**
   - ❌ Don't call \`create_field\` for \`id\` — auto-generated
   - ❌ Don't call \`create_field\` for \`service_name\` (the label_column field) — auto-generated
   - ❌ Don't call \`create_field\` for \`created_at\` / \`updated_at\` — auto-generated
   - ❌ Don't manually set \`searchable\` on the entity — it is computed

   ---

   ### Model a Relationship

   When user says: *"Relate orders to customers"*, *"Add order lines to orders"*, or *"Create a user-roles junction"*

   **Choose the right format:**

   Nullability is derived from \`format\`: a \`reference\` column allows NULL, a \`parent\` column is NOT NULL whatever its delete mode. A \`reference\` becomes mandatory with \`input_type: "required"\` and delete mode \`restrict\`; \`required\` with \`clear\` is refused (\`90257\`).

   | Scenario | \`format\` | \`reference_delete_mode\` |
   |----------|----------|-------------------------|
   | Child references an independent entity | \`reference\` | \`restrict\` |
   | Optional/weak relationship to another entity | \`reference\` | \`clear\` |
   | Child is owned by / composed into parent | \`parent\` | \`cascade\` |
   | Junction table FK (M:N) | \`parent\` | \`cascade\` |

   **Steps for a \`reference\` field:**

   1. **Verify target entity exists** using \`read_entity\`
   2. **Create reference field** with:
      - \`format: "reference"\`
      - \`reference_table: "<target_table_name>"\`
      - \`reference_delete_mode: "restrict"\` (strong dependency) or \`"clear"\` (optional relationship)
      - Optional: \`relationship_label\` — verb describing what the referenced entity does (e.g. \`"employs"\`, \`"heads"\`); used in ER diagrams and navigation labels

   **Steps for a \`parent\` field:**

   1. **Verify target entity exists** using \`read_entity\`
   2. **Create parent field** with:
      - \`format: "parent"\`
      - \`reference_table: "<target_table_name>"\`
      - \`reference_delete_mode: "cascade"\` (the normal choice: children are deleted with the parent), or \`"restrict"\` in the rare case of a child with its own permissions or an audit log. On an \`is_a\` entity \`cascade\` is refused (\`90249\`): set \`"restrict"\`.
      - Optional: \`relationship_label\` — verb label for ER diagrams and navigation
      - Optional: \`singular_label_parent\` / \`plural_label_parent\` — override the default labels inherited from the parent entity (e.g. use \`"Billing Address"\` instead of \`"Address"\` when a customer has multiple address roles)

   **Steps for a junction table (M:N):**

   1. **Create the junction entity** (e.g., \`user_roles\`, \`product_tags\`)
   2. **Create two \`parent\` fields**, one for each side of the relationship:
      - Both use \`format: "parent"\`, \`reference_delete_mode: "cascade"\`
      - Example: \`user_id\` → \`users\` and \`role_id\` → \`roles\`

   **Examples:**

   *"Each lead should have a sales rep assigned"*
   - \`create_field\` on leads: \`format: "reference"\`, \`reference_table: "users"\`, \`reference_delete_mode: "clear"\`, \`title: "Sales Rep"\`

   *"Add line items to orders"*
   - \`create_field\` on order_lines: \`format: "parent"\`, \`reference_table: "orders"\`, \`reference_delete_mode: "cascade"\`, \`title: "Order"\`

   *"Create a product_tags junction between products and tags"*
   - \`create_entity\` for \`product_tags\`
   - \`create_field\` once with both parent fields in \`data\`:
     - \`product_id\`: \`format: "parent"\`, \`reference_table: "products"\`, \`reference_delete_mode: "cascade"\`
     - \`tag_id\`: \`format: "parent"\`, \`reference_table: "tags"\`, \`reference_delete_mode: "cascade"\`

   ---

   ### Inheritance and Extensions (\`is_a\`, \`has_a\`)

   When user says: *"Emails and tasks are both activities"*, *"Customers and suppliers are business partners"*, or *"A person can also be a customer"*

   Two key types let records of one entity share the key of another (its base, named in \`id_refentity\`):

   - **\`is_a\` — a subtype.** \`activities\` > \`emails\` > \`classified_emails\`, and \`tasks\` is_a \`activities\`; \`persons\` and \`organizations\` is_a \`business_partners\`. Every record is exactly one type, fixed when it is created: an email has an \`eml_…\` id, and \`activities\` lists it with every other activity. The base must be a managed \`typeid\` or \`is_a\` entity (\`90240\`); the subtype needs its own \`id_prefix\`.
   - **\`has_a\` — an optional extension.** \`customers\` and \`suppliers\` has_a \`business_partners\`: a partner has at most one customer record and at most one supplier record, and both use the partner's \`bp_…\` key. The base must be a managed \`typeid\` entity (\`90240\`). One level only.

   **Choose the right tool — inheritance is not a way to reuse fields:**

   | Situation | Use |
   |-----------|-----|
   | The kind of record is fixed when it is created, and every subtype record is also a valid record of the base (an email *is* an activity) | \`is_a\` |
   | An optional role a record may take on or drop (a partner becomes a customer) | \`has_a\` |
   | A classification that can change during the record's life (lead → customer, draft → approved) | an \`enum\` field, plus \`input_type_rule\` to show fields per value |
   | 1:n data per organizational level (a customer's data per sales area or company code) | a child entity with a \`parent\` field |
   | Two entities that merely share some field names | nothing — give each its own fields |

   **Creating one:**
   1. Create the base as a \`typeid\` entity (or use an existing one), with its fields.
   2. \`create_entity\` with \`id_type: "is_a"\` (plus \`id_prefix\`) or \`"has_a"\`, and \`id_refentity: "<base table_name>"\`. Do not set \`label_column\` or \`label_parent\`: they come from the base (on create the platform overwrites them; changing them later is refused with \`90242\`), and a later change of the root's \`label_column\` reaches every entity based on it. The entity's table is \`<table_name>_ext\`, so that name must be free too (\`90250\`).
   3. Add only the entity's **own** fields with \`create_field\`. A field belongs to the entity that owns it: an inherited field is changed through its owner, and a field name may not repeat one of the base's or of an entity based on this one (\`90243\`); siblings (emails and tasks) may share names.

   **Reading and writing:** each entity is read and written at its own \`table_name\`, which shows the whole record — the base's fields and its own. \`get_schema\` lists the inherited properties with \`"inherited_from": "<owner>"\`, and a has_a base lists its \`extensions: [{table, properties, required}]\`. A reader needs the view permission of every level, a writer the edit permission of every level it writes; a record the caller cannot write whole is skipped, never half-written.
   - **Writes through any level reach the record's own type.** \`PATCH /activities?id=eq.<eml id>\` runs the emails rules too, and \`DELETE /activities?id=eq.<eml id>\` deletes the email completely, running the delete rules of every level (any of them may refuse). An update writes the level that changed and the levels below it.
   - **Create a \`has_a\` record** without an \`id\` to create the base record too, or with the \`id\` of an existing base record to **attach** to it: only the extension's fields are written, and a base value that differs from the stored one is refused (\`90246\`) — change it through the base. An \`id\` that no base record has creates the base record with that id, which must carry the base's prefix (\`90237\`).
   - **Update a base field through a \`has_a\` record** — a customer's \`city\`, when the partner is a person: it is a change of the person record, so the rules and edit permissions of every level of it apply, and a caller who may not write the person skips the record. An update of the extension's own fields writes only the extension.
   - **Delete a \`has_a\` record** to detach it; the base record stays. A base record with an extension cannot be deleted (\`90251\`): remove the extensions first.
   - The \`<table_name>_ext\` tables store each entity's own fields; never write them directly (\`90244\`).

   **Limits:** a \`reference\` or \`parent\` field of an \`is_a\` entity cannot use \`reference_delete_mode: "cascade"\` (\`90249\`; use \`restrict\`, or \`clear\` on a \`reference\`): set the mode explicitly on every \`parent\` field of an \`is_a\` entity; \`order_column\`, queue mappings and RACI process gates are not available on \`is_a\`/\`has_a\` entities (\`90249\`), and neither side of a rollup can be one (\`90249\`); a base cannot be switched to \`managed: false\` while entities are based on it (\`90252\`); an upsert (\`Prefer: resolution=merge-duplicates\`, \`PUT\`) fails with \`42P10\` — insert, then update; a search spans every level but is slower on large tables. A view, function or policy built by hand on an \`is_a\`/\`has_a\` entity's view blocks every change that rebuilds its family — a field change on any level, a rename, a root prefix change, rules — and the delete of a family entity (\`90256\`, the hint names the objects): drop them, make the change, then create them again.

   **Deleting:** an \`is_a\`/\`has_a\` entity, or the base of one, cannot be deleted while it has records (\`90247\`), and a base cannot be deleted while entities are based on it (\`90248\`). Deleting a module is refused the same way while one of these entities in it has records (\`90247\`); entities of the same module that are based on each other do not block it. Before deleting an entity, check its dependents with \`read_entity(filters: "id_refentity=eq.<table_name>")\`.

   ---

   ### Entity Logic: Computed Fields and Validation Rules

   Entities can carry per-record derivation and validation logic via two optional entity-level properties, both stored as \`format: json\` and defaulting to \`[]\`.

   | Property | Type | Default | Purpose |
   |----------|------|---------|---------|
   | \`computed_fields\`  | array | \`[]\` | Ordered list of fields whose values are derived from the same record via JsonLogic. |
   | \`validation_rules\` | array | \`[]\` | Ordered list of record-level invariants that must hold for a write to succeed. |

   The platform evaluates these on every INSERT, UPDATE and DELETE: \`computed_fields\` first (in order, each result written back into the working record), then \`validation_rules\` (in order, any failing rule rejects the write). On DELETE the computed output is discarded and a failing validation rule aborts the delete; a rule that must not run on delete guards on \`\$mode\` (for example \`{"!=": [{"var": "\$mode"}, "delete"]}\`).

   **Trigger lifecycle.** When both arrays are empty or null, no entity trigger function exists. As soon as one becomes non-empty, the platform generates a BEFORE INSERT/UPDATE/DELETE function on the table. When both arrays go back to empty, or the entity is deleted, the function is dropped.

   **Saving \`computed_fields\` recalculates existing records.** A validation rule added later is not applied retroactively; it checks later writes only. Adding or changing \`computed_fields\` recalculates every record whose value moves. A record that cannot take its new value (a validation rule refuses it, the rule fails on it, or a constraint does) refuses the whole save with \`90908\`, whose \`record_id\` and \`problem\` say why. The pass moves no \`updated_at\` and writes no audit row, queue message or RACI event, and the tables it writes take no other writes until the save commits. A rule that stamps \`\$user_id\` or \`\$now\` unconditionally moves on this pass, as on any update; make such a stamp insert-only: \`{"if": [{"==": [{"var": "\$mode"}, "insert"]}, {"var": "\$user_id"}, {"var": "\$old.created_by"}]}\`. Removing a rule keeps the last values as ordinary data.

   **Derived marker.** A field a rule names gets \`ctype: "computed"\`, and its \`input_type\` \`default\` or \`readonly\` becomes \`disabled\` (and stays \`disabled\` when the rule goes). The label column keeps \`ctype: "label"\`. Rules match fields by name and a rename does not rewrite them, so a renamed field loses the marker: update the rule too. A rule cannot name a rollup field (\`90907\`), and a computed field cannot become a rollup (\`90261\`).

   #### \`computed_fields\` element shape

   | Property | Type | Required | Purpose |
   |----------|------|----------|---------|
   | \`name\` | string | yes | The scalar field of the same entity that receives the result. It is not checked when the rule is saved: a rule may name a field that does not exist yet, and it fills the field in once the field is added. The computed result is written into this slot. Dotted paths (e.g. \`metadata.name\`) write into nested JSONB properties. |
   | \`jsonlogic\` | object | yes | Evaluated against the record being written. |
   | \`description\` | string | no | Human note for future readers and agents. |

   Sample:

   \`\`\`json
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
   \`\`\`

   #### \`validation_rules\` element shape

   | Property | Type | Required | Purpose |
   |----------|------|----------|---------|
   | \`code\` | string | yes | A five-digit class 99 number matching \`^99[0-9]{3}\$\` (e.g. \`99001\`); any other value is refused with \`90905\`. It becomes the SQLSTATE of the error the rule raises, so it is the stable identifier for UI / i18n binding. Use a distinct code per rule; the platform does not check uniqueness. |
   | \`message\` | string | yes | Default English text returned to the caller on failure. |
   | \`jsonlogic\` | object | yes | Must evaluate truthy for the record to be valid. |
   | \`hint\` | string | no | Extra text added to the error hint of the failure. |
   | \`description\` | string | no | Human note explaining why this rule exists. |

   Sample:

   \`\`\`json
   [
     {
       "code": "99001",
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
   \`\`\`

   #### Evaluation order

   On every INSERT, UPDATE or DELETE the generated trigger:

   1. Builds \`newValues\` from the record's column values plus the reserved variables below.
   2. Walks \`computed_fields\` in order. For each entry it calls \`evaluate_json_logic\` with \`newValues\` and writes the result into \`newValues\` under the entry's \`name\` (dotted paths update nested JSONB properties).
   3. Walks \`validation_rules\` in order. For each entry it calls \`evaluate_json_logic\` with \`newValues\`. When the result is not truthy (\`false\`, \`0\`, \`null\` and the empty string all fail), the trigger raises an exception with the rule's \`code\` as SQLSTATE, the rule's \`message\` as the message and a hint naming the entity and the rule, and the write is rejected.
   4. If every rule passes, the write proceeds with the post-derivation \`newValues\`.

   If \`evaluate_json_logic\` itself throws, the raised error must include the offending entry's \`name\` (for computed fields) or \`code\` (for validation rules) together with the inner error.

   #### Reserved variables

   JsonLogic expressions may read these injected variables via \`{"var": "\$name"}\`:

   | Var | Type | Meaning |
   |-----|------|---------|
   | \`\$today\`   | date      | Server date at evaluation time. |
   | \`\$now\`     | date-time | Server timestamp at evaluation time. |
   | \`\$user_id\` | number    | \`users.id\` of the authenticated user performing the write (null when the write is system-initiated). |
   | \`\$old\`     | object    | Previous row as JSON on UPDATE and DELETE; null on INSERT. |
   | \`\$mode\`    | text      | The operation: \`insert\`, \`update\` or \`delete\`. |


   ---

   ### Rollup Fields (aggregates over child records)

   When user says: *"Show each order's total from its lines"*, *"Count the open tickets per customer"*, or *"Show the latest ship date on the order"*

   A rollup field holds a \`sum\`, \`min\`, \`max\`, \`avg\` or \`count\` over the records of a child entity, and the database keeps it current. Use one whenever a value depends on **other** records: \`computed_fields\` only see the record being written. A rollup is not a format: the field keeps an ordinary \`format\`, and its \`rollup\` definition makes it a rollup.

   | Key | Required | Purpose |
   |-----|----------|---------|
   | \`link_field\` | yes | \`<child table_name>.<field_name>\`: a \`reference\` or \`parent\` field of the child that points at this entity (\`90262\`). The child may be this entity itself (a tree). |
   | \`function\` | yes | \`sum\`, \`min\`, \`max\`, \`avg\` or \`count\` (\`90263\`). |
   | \`value_field\` | except with \`count\` | The field of the child to aggregate; not allowed with \`count\` (\`90264\`). It may itself be a rollup, unless the chain comes back to this field (\`90267\`). |
   | \`filter\` | no | JsonLogic over the child record, limited to the subset below (\`90265\`). |
   | \`include_hidden_rows\` | no | \`true\` accepts aggregating child records that readers of this entity may not see. See *Hidden child rows*. |

   The rollup field's \`format\` must fit the result (\`90268\`):

   | \`function\` | \`value_field\` format | Rollup field format |
   |------------|----------------------|---------------------|
   | \`count\` | none | \`int64\` (recommended), another integer format, or \`number\` |
   | \`sum\` | numeric | \`number\` keeps every digit; an integer format can overflow |
   | \`avg\` | numeric | \`number\`, \`float\` or \`double\` |
   | \`min\`, \`max\` | numeric, text-typed, \`date\` or \`date-time\` | same column type as the value field: \`email\` over \`text\` works, \`date\` over \`date-time\` does not |

   A \`sum\` or \`avg\` value field is one of \`number\`, \`integer\`, \`int32\`, \`int64\`, \`float\`, \`double\` or \`rating\`; \`min\` and \`max\` also take any text-typed format, \`date\` and \`date-time\`. Anything else (booleans, times, durations, UUIDs, binaries, JSON) is refused (\`90264\`).

   **Creating one:** the child entity, \`link_field\` and \`value_field\` must already exist, so create the rollup field last. Several rollups can go in one \`create_field\` array. Sample \`data\` item:

   \`\`\`json
   {
     "table_name": "orders",
     "field_name": "open_amount",
     "title": "Open Amount",
     "format": "number",
     "rollup": {
       "link_field": "order_lines.order_id",
       "function": "sum",
       "value_field": "amount",
       "filter": { "==": [{ "var": "status" }, "open"] }
     }
   }
   \`\`\`

   - Omit \`ctype\`: it becomes \`rollup\` by itself. Omit \`precision\` too: it is copied from a \`number\` value field.
   - \`input_type\` \`default\` and \`readonly\` become \`disabled\`; \`hidden\` stays.
   - \`required\`, \`searchable\` and \`unique_value\` are refused (\`90261\`), and so is a definition on a key, a core field, a \`reference\` or \`parent\` field, or a field a \`computed_fields\` rule names.
   - Neither side can be an \`is_a\` or \`has_a\` entity (\`90249\`). On an unmanaged entity the definition is kept as metadata, and takes effect once both sides are managed.

   **The filter** is compiled to SQL, so only this subset is accepted: \`and\`, \`or\`, \`!\`, \`!!\`, \`==\`, \`===\`, \`!=\`, \`!==\`, \`<\`, \`<=\`, \`>\`, \`>=\`, \`in\` with a non-empty list of literals, literals, and \`var\` naming a text, boolean, number, date, time, timestamp, UUID or TypeID column of the child (a bare boolean column or boolean literal also works as a condition, and \`<\` and \`<=\` take three operands). Everything else is refused on save (\`90265\`, and the error names it): other operators such as \`if\`, arithmetic, \`cat\` and \`missing\`, the variables \`\$user_id\`, \`\$now\` and \`\$today\`, dotted paths, and a \`var\` with a default. \`==\` and \`!=\` treat \`null\` as a value; an ordering comparison with a NULL column excludes the record.

   **How it behaves:**
   - The value cannot be written by hand. On create it starts as the empty aggregate, and on update a changed value is recomputed, with no error. Change the child records instead.
   - With no matching child records the value is \`0\` for numbers, \`''\` for text, and NULL for \`date\` and \`date-time\`.
   - A child write that moves a total runs the parent's own \`computed_fields\`, \`validation_rules\`, queue mappings and RACI triggers, with its rules evaluated as the user who wrote the child. So a parent rule can test a rollup (a total under a credit limit) and refuse the child write, and a parent rule that tests the writer's permission blocks child writes by users who cannot edit the parent. A parent computed field can read a rollup (\`total\` = \`subtotal\` + \`freight\`).
   - A child write that changes nothing but rollup columns moves no \`updated_at\` and writes no audit row on the parent.
   - Rollups over a tree (a child that is its own parent) climb from parent to parent, and two such writers can deadlock; the database aborts one write with \`40P01\`, so retry it.

   **Hidden child rows (\`90269\`):** the aggregate covers every child record, and every reader of the parent sees it. When the child has a \`select_rule\`, or a \`view_permission\` other than the parent's, the rollup is refused unless its definition sets \`include_hidden_rows: true\`. That setting shows those readers a sum, count, minimum or maximum over rows they cannot see, so ask the user before setting it. The refusal also applies later: adding a \`select_rule\` to the child, or changing a \`view_permission\` on either side, fails while it would affect a rollup without the flag.

   **Changing and removing:**
   - Saving a new or changed definition recalculates the records whose value differs. This is not an edit: no \`updated_at\`, audit row, queue message or RACI event, on this entity or any rollup parent above it. Those tables take no other writes until the save commits, so warn the user before doing this on a busy table.
   - A definition that needs another column type (\`sum(amount)\` to \`max(ship_date)\`) is a format change (\`90223\`): drop and recreate the field.
   - \`rollup: {}\` removes the definition. The field stays with its last values as ordinary data, \`ctype\` clears, and \`input_type\` stays \`disabled\` until you change it.
   - Renames of the tables and fields a definition names are followed automatically.
   - The \`link_field\`, the value field and the child entity cannot be deleted while another entity's rollup depends on them (\`90266\`, which names the rollups), unless the same module delete removes both sides. The rollup field itself is deleted like any other field.
   - Find rollups with \`read_field(filters: "ctype=eq.rollup")\`. \`get_schema\` shows \`ctype: "rollup"\`, \`is_core: false\` and the definition under \`rollup\`.

   ---

   ### Row-Level Read Access via \`select_rule\`

   Entities can carry an optional \`select_rule\` (JSONB object, default \`{}\`) that is evaluated per row to determine whether the current user is allowed to view the record. **It replaces \`view_permission\` for reads:** the FOR SELECT policy is the rule alone, with no \`view_permission\` check. Only while the rule is \`{}\` does the default policy \`has_permission(view_permission)\` apply. A rule that tests no permission therefore admits every row it matches to every user who can reach the table, and a rule that only compares \`owner_id\` to \`\$user_id\` hides all other rows from administrators too: test a permission inside the rule (\`has_permission\`) for the roles that must see everything.

   Writes keep \`edit_permission\`: UPDATE and DELETE require \`edit_permission\` AND the rule on the existing row (a row the rule hides cannot be updated or deleted), \`WITH CHECK\` is \`edit_permission\` only (a write may move a row out of its own rule), and INSERT needs \`edit_permission\` only.

   - **Result:** the row is visible when the result is truthy: \`false\`, \`0\`, \`null\` and the empty string hide it; non-zero numbers, non-empty strings, non-empty arrays and objects show it. Write the rule to return a boolean. A rule that raises an error hides the row; the query still runs.
   - **Trigger lifecycle:** When \`select_rule\` is non-empty, the platform generates the SELECT, UPDATE and DELETE policies of the table. When the rule is cleared (back to \`{}\`) the default \`view_permission\` policies replace them; when the entity is deleted they are dropped.
   - **Reserved variables:** only \`\$today\`, \`\$now\` and \`\$user_id\`; there is no \`\$old\` and no \`\$mode\` on a read. \`\$user_id\` is the typical anchor for ownership checks.
   - **Use sparingly:** Per-row evaluation runs on every read, so keep the JsonLogic simple — prefer direct comparisons to columns and reserved variables over deep traversals. \`set_record\` (cross-entity lookup) works here but runs an extra SELECT per row of every read.
   - **Broaden with \`has_permission\`, not \`require_permission\`:** \`has_permission\` returns a boolean and composes with \`or\` (\`{"or": [<own rows>, {"has_permission": "<code>"}]}\`); \`require_permission\` throws on a miss, and a rule that throws hides the row.

   Sample (a row is visible if its \`owner_id\` matches the current user, or its \`visibility\` column is \`public\`):

   \`\`\`json
   {
     "or": [
       { "==": [{ "var": "owner_id" }, { "var": "\$user_id" }] },
       { "==": [{ "var": "visibility" }, "public"] }
     ]
   }
   \`\`\`

   ---

   ### Dynamic \`input_type\` via \`input_type_rule\`

   Fields can carry an optional \`input_type_rule\` (JSONB object, default \`{}\`) that dynamically overrides the static \`input_type\` value at runtime. It is useful when a field's editability or visibility depends on the record's state.

   - **Return type:** \`input_type_rule\` MUST evaluate to one of the valid \`input_type\` enum values: \`"default"\`, \`"required"\`, \`"readonly"\`, \`"disabled"\`, \`"hidden"\`. The returned value replaces the static \`input_type\` for that record.
   - **Evaluated client-side** against the current form record; reserved variables (\`\$today\`, \`\$now\`, \`\$user_id\`) are available where relevant.
   - **Falls back** to the static \`input_type\` when the rule is empty (\`{}\`) or evaluates to something other than a valid enum value. No server code evaluates it, so it never blocks a write.
   - **A non-empty rule removes the database \`required\` check** of the field (the rule can turn \`required\` off per record), so \`required\` is then enforced by the client only.

   Sample (an \`approved_at\` field is \`readonly\` once \`status\` is \`approved\`, otherwise standard \`default\`):

   \`\`\`json
   {
     "if": [
       { "==": [{ "var": "status" }, "approved"] },
       "readonly",
       "default"
     ]
   }
   \`\`\`

   ---

   ### Configure RBAC

   When user says: *"Sales managers should be able to edit leads"* or *"Create a viewer role"*

   **Steps:**

   1. **Check if permissions exist**:
      - Use \`read_permission\` to find existing permissions
      - If not found, create with \`create_permission\` using \`<module>:<action>\` naming and field \`permission_name\`

   2. **Create or update role**:
      - Use \`read_role\` to check if role exists
      - Create with \`create_role\` if needed
      - Leave \`origin\` unset on manual creation — it defaults to \`"user"\`. Never set \`origin\` to \`"system"\`, \`"model"\`, or \`"model_master"\` from the agent; those values are reserved for the platform (DB init seed, semantic-model deploys, and the promotion / master-model deploy flow respectively).
      - \`slug\` is optional: when blank the database derives it from \`role_name\` (every run of characters outside \`a-z\`, \`A-Z\` and \`0-9\` becomes one \`_\`, leading and trailing \`_\` are removed, then it is lowercased), and it must match \`^[a-z0-9_]+\$\`. A role name with no ASCII letter or digit derives an empty slug and a second such role collides, so pass \`slug\` in that case or when the user requests a specific one.

   3. **Grant permissions to role**:
      - Use \`create_role_permission\` to grant permissions to the role
      - Use \`create_permission_hierarchy\` if a permission should include another (e.g., \`crm:manage\` implicitly includes \`crm:read\`). Set \`including_permission_name\` to the broader permission (\`crm:manage\`) and \`included_permission_name\` to the narrower one (\`crm:read\`). Leave \`origin\` unset on creation (defaults to \`"user"\`). \`permission_hierarchy.origin\` is strictly immutable after INSERT — no upgrade paths.

   4. **Assign role to user** (if requested):
      - Find user with \`read_user\`
      - Create mapping with \`create_user_role\`

   ---

   ### Role \`slug\` and \`origin\`

   Every role carries two metadata fields used by the scaffold and promotion pipelines:

   - **\`slug\`** — snake_case, unique, NOT NULL. Auto-derived from \`role_name\` via slugify on INSERT when omitted. Always populated. Cannot be changed after creation when \`origin\` is \`"system"\` (\`90204\`); roles of any other origin can be renamed.
   - **\`origin\`** — one of \`"system"\`, \`"model"\`, \`"model_master"\`, or \`"user"\`. Defaults to \`"user"\` for manually created roles. The other three values are reserved for the platform and must never be set by the agent:
     - \`"system"\` — platform built-ins seeded at DB init (e.g. \`Administrator\`, \`User\`). Only its \`origin\` and \`slug\` are locked.
     - \`"model"\` — scaffold role on a domain module, created by a \`*-semantic-model.md\` deploy. The deployer names its slugs \`<module_slug>_viewer\` / \`_manager\` / \`_admin\` (a deployer convention, not a platform rule).
     - \`"model_master"\` — scaffold role on a master module, created by promotion or master-model deploy. Same deployer convention.

   **\`origin\` is set on INSERT and cannot be changed afterwards**: the platform rejects any change with error 90203.

   ### Module permission and role columns

   - **\`module_type\`** — \`"domain"\` (default) or \`"master"\` (promoted for sharing). Its \`input_type\` is \`readonly\`; the database does not block a write.
   - **\`manage_permission\`** / **\`admin_permission\`** — names of the module's manage and admin permissions.
   - **\`default_viewer_role_id\`** / **\`default_manager_role_id\`** / **\`default_admin_role_id\`** — FKs to \`roles.id\` for the module's default viewer, manager and admin roles.

   The last five are regular fields: set them with \`create_module\` or \`update_module\`. They are foreign keys, so the permissions and roles they name must already exist.

   ### Permission hierarchy columns

   A row in \`permission_hierarchy\` encodes one inclusion: the **including** permission implies the **included** permission. Read each row as:

   \`including_permission_name\` ── *includes* ──▶ \`included_permission_name\`

   The same row, read the other way, is "\`included_permission_name\` is *included in* \`including_permission_name\`".

   - **\`including_permission_name\`** — the broader permission, the one doing the including (e.g. \`crm:manage\` in \`crm:manage includes crm:read\`).
   - **\`included_permission_name\`** — the narrower permission, the one being included (e.g. \`crm:read\`).

   Whether a row is intra-master or cross-module is derivable from the \`module_id\` of each side. A row that would make a cycle is refused (\`90210\`), and so is a chain deeper than 11 levels (\`90211\`).

   ### Permission hierarchy \`origin\`

   Every \`permission_hierarchy\` row carries an \`origin\` of \`"system"\`, \`"model"\`, \`"model_master"\`, or \`"user"\` (default for new records):

   - \`"system"\` — platform-seeded at DB init.
   - \`"model"\` — row declared in a model file's §2 Permissions summary table.
   - \`"model_master"\` — auto-created by the deployer as a side effect of promotion or Branch A wire-up; covers both the master's internal chain (\`<master>:manage -> <master>:read\`) and cross-module bridges (\`<consumer>:read -> <master>:read\`).
   - \`"user"\` — manually added by an admin.

   \`permission_hierarchy.origin\` is **strictly immutable after INSERT**, like \`roles.origin\` (error 90205).

   ---

   ### Receive Records from an External System (Webhook Receivers)

   When user says: *"Let our billing system push invoices into Semantius"*

   A webhook receiver accepts one signed HTTP \`POST {api_baseurl}/hook/{webhook_receiver_id}\` per record and writes it to one table (\`api_baseurl\` comes from \`getCurrentUser\`).

   1. \`read_entity\` / \`read_field\` for the target table: the payload is matched to fields by name, unknown keys are ignored, and a \`readonly\` field is dropped. For \`bigint\` and \`text\` keys the sender supplies the \`id\`. A generated key is omitted; a payload that does carry it is used as the record's key and written.
   2. \`create_webhook_receiver\` with \`label\` (the producing system), \`table_name\`, \`auth_type: "hmac"\` and a \`secret\` of at least 32 random characters (\`openssl rand -hex 32\`); give the secret to the sender. The receiver verifies a signature only for \`hmac\` and accepts every request for \`none\` and \`header\`; an \`hmac\` receiver with no secret, or a request without \`webhook-id\` or \`webhook-signature\`, is answered 401. Optional: \`jsonata\`, an expression that reshapes the payload first.
   3. The sender signs \`{webhook-id}.{webhook-timestamp}.{body}\` with HMAC-SHA256 (a secret starting \`whsec_\` is base64-decoded first and the decoded bytes are read as UTF-8 text, so use such a secret only when they are text) and sends \`webhook-id\` (unique per message; with \`hmac\`, a repeat of one that succeeded is ignored), \`webhook-timestamp\` and \`webhook-signature: v1,{base64 signature}\`.
   4. The receiver upserts by the entity's key, then by a \`unique_value\` field. \`read_webhook_receiver_log\` (filter \`webhook_receiver_id\`) shows each delivery: \`result\` 10 success, 20 signature failed, 30 invalid JSON, 40 table not found, 50 write failed, 60 JSONata error, and \`error_message\`.

   ---

   ### Search Records

   When user says: *"Find contacts named Monica"* or *"Search for leads from Allvue"*

   **Steps:**

   1. Check if entity is searchable using \`read_entity\` — look for \`searchable: true\` (this is \`true\` when at least one field has \`searchable: true\`)
   2. Use \`wfts(simple)\` on the \`search_vector\` column: \`?search_vector=wfts(simple).<term>\`
      - \`search_vector\` is a computed column automatically maintained by the system across all searchable fields
      - Always use \`wfts(simple)\` — the \`simple\` text search configuration is language-agnostic and required for multilingual content. Never use bare \`wfts\` or \`fts\`.
   3. Only use field-specific filters (\`ilike\`, \`eq\`, etc.) when the user specifies a particular column or when the table is not searchable
   - For an \`is_a\` or \`has_a\` entity, \`search_vector\` covers the searchable fields of its base as well as its own. That search cannot use an index, so on large tables add a narrowing filter.

   ---

   ### Evolve Existing Model

   When user says: *"Add an email field to customers"* or *"Make status required"*

   **For adding fields:**
   - Use \`create_field\` on existing \`table_name\` (pass an array in \`data\` when adding several fields at once)
   - Safe to add new fields anytime

   **For modifying fields:**
   - Use \`read_field\` first to see current state
   - Use \`update_field\` with only the changed attributes
   - Warn user about risky changes (see Safe Evolution Patterns below)

   **For removing fields:**
   - Check if field is referenced elsewhere: \`read_field\` with \`filters: "reference_table=eq.<table>"\`
   - A field that a rollup of another entity uses as its \`link_field\` or \`value_field\` cannot be deleted (\`90266\`)
   - Warn user about data loss
   - Use \`delete_field\` only after explicit confirmation

   ---

   ## Safe Evolution Patterns

   ### ✅ Low-Risk Changes (do freely)
   - Add new fields
   - Add new permissions/roles/role assignments
   - Update descriptions, labels, UI hints
   - Add \`searchable: true\` to fields
   - Create new entities in new or existing modules

   ### ⚠️ Medium-Risk Changes (warn user before proceeding)
   - Changing \`reference_delete_mode\`
   - Adding view/edit permissions to previously open entities
   - Changing \`enum_values\`
   - Adding or changing a \`select_rule\`: it replaces \`view_permission\` for reads, so a rule that tests no permission shows its rows to every user who can reach the table, and a rule that tests only \`\$user_id\` hides rows from administrators
   - Adding an \`input_type_rule\` to a \`required\` field (the database stops enforcing \`required\` for it)
   - Adding \`unique_value: true\` to an existing field (will fail if duplicate values exist — suggest deduplication first)
   - Adding or changing a \`rollup\` definition or \`computed_fields\` (recalculates existing records with no audit row; the tables written take no other writes until the save commits)
   - These may affect existing data or access patterns

   ### 🛑 High-Risk Changes (require explicit user confirmation)
   - Renaming \`table_name\` or \`field_name\` (breaks all references)
   - Deleting entities or fields (permanent data loss)
   - Removing permissions still in use by roles
   - Changing primary key fields (\`id_type\` cannot change at all; a record's key value cannot change either, the update fails with \`90236\`)
   - Choosing \`is_a\` or \`has_a\` (\`id_refentity\` and an \`is_a\` prefix are fixed at creation; a record's type cannot change later)
   - Deleting an entity that others are based on (refused with \`90248\`; check \`id_refentity=eq.<table_name>\` first)
   - Deleting an entity that fields of other entities reference (refused with \`90260\`; check \`reference_table=eq.<table_name>\` first)
   - Setting \`include_hidden_rows: true\` on a rollup (readers see an aggregate over rows they cannot read)
   - **Always check dependencies before deletion**

   ---

   ## Troubleshooting Common Issues

   ### "Permission denied" errors

   **Diagnosis workflow:**
   1. Call \`getCurrentUser\` to see the user's effective permissions
   2. Call \`read_entity\` on the table to see required \`view_permission\` / \`edit_permission\`
   3. Check if user has the required permission in their list
   4. If not, trace through: user → \`user_roles\` → \`role_permissions\` → \`permission_hierarchy\`

   **Resolution:** Grant the missing permission to the user's role, or assign a role that already has it.

   ---

   ### Fields not displaying correctly

   **Check:**
   - Entity has \`label_column\` set and it matches a real field with \`ctype='label'\`
   - Fields have appropriate \`width\` (see Field Format Quick Reference)
   - Fields have proper \`field_order\` for display sequence
   - \`input_type\` is appropriate for the use case (see Field Format Quick Reference)

   ---

   ## Field Format Quick Reference

   Choose the appropriate \`format\` when creating fields:

   > ⚠️ \`format\` can be changed on a managed entity only to a format with the same physical database type (e.g. \`text\` → \`email\` is safe, both are TEXT; \`text\` → \`number\` is refused with \`90223\`: drop and recreate the field). A reference takes the type of the key it points at, so \`text\` → \`reference\` of a TEXT-keyed entity is allowed. Planning such a change with the user is high-risk work.

   | Category | Values |
   |----------|--------|
   | **Text** | \`string\`, \`text\`, \`multiline\`, \`html\`, \`code\` |
   | **Numbers** | \`integer\`, \`int32\`, \`int64\`, \`number\`, \`float\`, \`double\` — **use \`number\` for all monetary/currency/amount fields; \`float\`/\`double\` only when explicitly requested.** For \`number\` format, set \`precision\` to control decimal places (default 2). |
   | **Dates/Time** | \`date\`, \`time\`, \`date-time\`, \`duration\` |
   | **Relationships** | \`reference\` (cross-entity relationship, independent lifecycle, NULL allowed — default delete: \`restrict\`) |
   | **Composition** | \`parent\` (ownership/composition, child lifecycle bound to parent, NOT NULL — delete mode normally \`cascade\`, \`restrict\` in the rare case of a child with its own permissions; also used for M:N junction FKs) |
   | **Choice** | \`enum\` (requires \`enum_values\`: an array whose entries are a value or a \`{"value", "label"}\` object, e.g. \`["draft", {"value": "on_hold", "label": "On hold", "color": "amber"}]\`. An object may also carry an optional \`description\`, \`color\` (HTML color) and \`icon\` (Lucide icon name, see below) — UI hints only. Records store the value; the label is what the UI shows. Use an object when the value is a code or abbreviation or needs a color or icon. Never an object map like \`{"draft": "Draft"}\`) |
   | **Display** | \`color\` (HTML color, e.g. a hex code or color name), \`icon\` (Lucide icon name or icon URL, see below), \`rating\` (integer 0–5, 0 = not rated; use for star ratings and 5-point scores, not for general integers) |
   | **Boolean** | \`boolean\` |
   | **Structured** | \`json\`, \`jsonlogic\`, \`object\`, \`array\` |
   | **Identifiers** | \`uuid\`, \`email\`, \`uri\`, \`url\` |

   > ℹ️ **Icons are Lucide icons.** An \`icon\` field, the \`icon\` of an enum entry and the \`icon_name\` of a module or entity take a Lucide icon name in kebab-case (e.g. \`circle-check\`, \`users\`, \`shopping-cart\`; never the PascalCase React component name \`CircleCheck\`), or an icon URL. The UI always uses the latest Lucide release, so every current icon is available. To find a name, search https://cdn.jsdelivr.net/npm/lucide-static/tags.json (icon name → search tags, ~1,900 icons): look a name up by key, or an idea up by its tags; search it, don't load it whole.

   > ℹ️ **An enum record stores the value, never the label.** \`enum_values\`, and the \`enum\` list of an enum property in \`get_schema\` output, hold the entries as defined: an entry may be a \`{"value", "label"}\` object, with any \`description\`, \`color\` and \`icon\` it carries, so write its \`value\`. \`get_schema\` also lists \`""\` for an enum that is not required.

   ---

   ### Nullability and Default Values

   > ℹ️ **There is no \`is_nullable\` field: nullability follows \`format\`.** \`default_value\` is optional and may be set. When it is blank, a NOT NULL column gets the zero value shown in the table, and a format with no zero value gets no default, so every insert must send a value.

   | Format(s) | PostgreSQL type | Auto default | Nullable? |
   |-----------|-----------------|--------------|-----------|
   | \`string\`, \`text\`, \`multiline\`, \`html\`, \`code\`, \`email\`, \`url\`, \`uri\`, \`password\`, \`color\`, \`icon\` | TEXT | \`''\` | NOT NULL |
   | \`enum\` | TEXT | \`''\`, which a required enum refuses, so a required enum with no \`default_value\` must be sent on every write | NOT NULL |
   | \`integer\`, \`int32\` / \`int64\` | INTEGER / BIGINT | \`0\` | NOT NULL |
   | \`rating\` | INTEGER | \`0\` (not rated) | NOT NULL — the database does not check the 0–5 range (a client library does) and refuses only \`0\` on a required rating; a required rating needs a value from 1 to 5 |
   | \`number\` | NUMERIC(18, scale) | \`0.0\` | NOT NULL |
   | \`float\` | REAL | \`0.0\` | NOT NULL |
   | \`double\` | DOUBLE PRECISION | \`0.0\` | NOT NULL |
   | \`boolean\` | BOOLEAN | \`FALSE\` | NOT NULL |
   | \`json\`, \`jsonlogic\`, \`object\` | JSONB | \`'{}'\` | NOT NULL |
   | \`array\` | JSONB | \`'[]'\` | NOT NULL |
   | \`uuid\` | UUID | none (no zero value) | NOT NULL |
   | \`time\` | TIME | none (no zero value) | NOT NULL |
   | \`duration\` | INTERVAL | none (no zero value) | NOT NULL |
   | \`binary\` | BYTEA | none (no zero value) | NOT NULL |
   | \`date-time\` | TIMESTAMPTZ | none | NULL allowed |
   | \`date\` | DATE | none | NULL allowed |
   | \`reference\` | FK, type of the referenced entity's key (BIGINT for \`auto_increment\`/\`bigint\`, TEXT, UUID, or the TypeID domain) | none | NULL allowed |
   | \`parent\` | FK, type of the referenced entity's key (as for \`reference\`) | none | NOT NULL |

   ---

   > 🛑 **CRITICAL: \`reference_table\` always requires \`format: "reference"\` or
   > \`format: "parent"\`**
   > If a field has \`reference_table\` set, its \`format\` MUST be either
   > \`"reference"\` or \`"parent"\`. Any other format (\`integer\`, \`uuid\`, \`string\`,
   > etc.) will **always fail**. There are no exceptions.
   > - Use \`"reference"\` for cross-entity relationships with independent lifecycles
   > - Use \`"parent"\` for ownership/composition and M:N junction FKs
   > - **Never** combine \`reference_table\` with any scalar format


   ### \`width\` Values

   Controls the display width of a field in the UI.

   | Value | Meaning |
   |-------|---------|
   | \`default\` | **Default — always use this.** System selects the best width based on \`format\` and screen size. |
   | \`s\` | Small override (short text, booleans, status badges) |
   | \`m\` | Medium override |
   | \`w\` | Wide override (long text, descriptions) |

   > ⚠️ Always set \`width: "default"\` unless the user has a specific layout requirement. Manual width values should be avoided in most cases.

   ---

   ### \`input_type\` Values

   Controls how a field is rendered in forms.

   | Value | Meaning |
   |-------|---------|
   | \`default\` | Standard editable input — use for most fields |
   | \`required\` | Editable and mandatory; the database refuses a missing value |
   | \`readonly\` | Displayed but not editable; a form still submits the value |
   | \`disabled\` | Shown greyed out, not editable, and not submitted by a form |
   | \`hidden\` | Not shown in forms at all |

   On a rollup or computed field, \`default\` and \`readonly\` become \`disabled\` automatically, because a form must not submit a derived value.

   **\`required\` is enforced for every writer, not only forms.** A write that leaves a required field missing fails with error \`90258\`. Missing means:

   - \`NULL\` for \`reference\`, \`date\` and \`date-time\`
   - blank or whitespace-only text, and an empty \`enum\`
   - JSON \`{}\`, \`[]\`, \`null\` or \`""\`
   - an empty \`binary\`, and a \`rating\` of \`0\`

   Numbers and booleans have no missing value, so \`0\` and \`false\` are accepted. A field with an \`input_type_rule\` is not enforced by the database, because the rule can turn \`required\` off per record.

   - **Existing rows:** a row that already lacks a required value stays readable; its UPDATE fails until the value is filled in.
   - **Populated tables:** adding a required field with no real \`default_value\` to a table with rows fails with \`90259\`, and so does changing a field to \`required\` while rows have no value for it. Add the field as \`default\`, backfill it, then change it to \`required\`.
   - **Labels:** the label field a new entity gets automatically is \`required\`. If its writers don't send a label, such as a junction (a connecting record) whose label is composed from the records it relates, set that field's \`input_type\` to \`default\`.
   - **Delete mode:** \`required\` together with \`reference_delete_mode: "clear"\` fails with \`90257\`, because clearing the reference would make every delete of the parent fail.


   ### \`unique_value\` Values

   Controls whether a field must contain a unique value across all records.

   | Value | Meaning |
   |-------|---------|
   | \`true\` | Field value must be unique — duplicates are rejected at the database level |
   | \`false\` | **Default.** No uniqueness constraint applied |

   **When to use:**
   - User-facing identifiers that must not collide (e.g., \`email\` on a contacts table)
   - External system keys imported from other platforms (e.g., \`kunnr\` from SAP, \`external_id\` from Salesforce)
   - Any field where duplicate records would cause data integrity issues

   > ⚠️ Adding \`unique_value: true\` to an existing field is a **medium-risk change** — it will fail if duplicate values already exist in the database. Always warn the user and suggest deduplication before applying.

   ---

   ### \`cube_type\` Values

   Controls how a field participates in OLAP cube generation (only relevant when the entity has \`cube_mode: "auto"\`).

   | Value | Meaning |
   |-------|---------|
   | \`disabled\` | Field excluded from cube |
   | \`auto\` | **Default.** System infers dimension or measure from \`format\` |
   | \`dimension\` | Explicit grouping axis (e.g. category, region, status) |
   | \`measure\` | Explicit numeric aggregation (e.g. revenue, count) |

   ---

   ### \`precision\` Values

   Controls the number of decimal places (scale) of \`number\` fields, which are stored as \`NUMERIC(18, scale)\`. \`float\` and \`double\` ignore it.

   | Value | Meaning |
   |-------|---------|
   | \`0\` | Integer-like storage (no decimals) |
   | \`2\` | **Default.** Suitable for most monetary and percentage values |
   | \`4\`–\`6\` | Higher precision for exchange rates, unit prices, or scientific values |
   | \`18\` | Maximum supported scale |

   > ℹ️ Only set \`precision\` when the default of 2 is not appropriate. Omit it for most fields.

   ---

   ### \`ctype\` Values

   Marks what kind of column a field is. **It is derived, never sent:** a value sent on create is ignored, and changing it on update fails with \`90214\`.

   | Value | Meaning | Protected |
   |-------|---------|-----------|
   | empty | Ordinary field | no |
   | \`id\` | Primary key | yes |
   | \`label\` | Display label | yes, but it may be renamed and its default value changed |
   | \`audit\` | \`created_at\` and \`updated_at\` | yes |
   | \`core\` | Other system columns | yes |
   | \`rollup\` | Value aggregated by the database from the field's \`rollup\` definition | no |
   | \`computed\` | Value written by one of the entity's \`computed_fields\` rules | no |

   A protected column cannot be deleted (\`90217\`) or renamed (\`90218\`), and its format (\`90219\`) and default value (\`90220\`) cannot change; the label column is the exception for renaming and for its default value. A \`rollup\` or \`computed\` field can still be renamed, deleted, or moved to another format with the same column type. \`get_schema\` reports these two with \`is_core: false\`.

   ---

   ## Tool Reference

   ### Priority Rule
   **Always use typed CRUD tools for create, read, update, and delete operations.** Use \`postgrestRequest\` or \`sqlToRest\` only when:
   - A complex multi-filter or aggregation query cannot be expressed through typed tools
   - A bulk mutation must be selected by an arbitrary filter (not by a list of ids), or each row needs different values in one update
   - Business-record rows in the entity tables you modeled: the typed tools cover the catalog tables only, so these go through \`postgrestRequest\` (an array \`body\` is the bulk insert)

   ### Bulk Operations
   **Rule: if more than one record of the same kind is pending, send them in ONE call. Never loop single-record calls.** One array call is one HTTP request and one database transaction; N single calls are N round trips with partial-failure risk and no atomicity.
   - **\`create_*\`**: \`data\` is either one object or a **non-empty array of objects**. **Items do not need the same keys**: the server sends the union of keys and keys omitted from an item take the column default. All rows are inserted in one request and one transaction (all-or-nothing). Example: \`create_field\` with \`data: [ {...description}, {...cost} ]\`.
   - **\`update_*\`**: \`id\` is either one value or a **non-empty array of ids** (for \`update_entity\` the key is \`table_name\`, for \`update_permission\` it is \`permission_name\`). The **same** \`data\` is applied to every listed record. For per-record values, call once per record.
   - **\`delete_*\`**: \`id\` (or \`table_name\` for entities, \`permission_name\` for permissions) is either one value or a **non-empty array**; all listed records are deleted in one request.
   - **Responses** are always an array of the created/updated/deleted records. Never combine an array input with \`accept: application/vnd.pgrst.object+json\` (that Accept value requests exactly one row and fails otherwise).
   - **Duplicate checks still apply**: before a bulk \`create_*\`, run one \`read_*\` with an \`in.(...)\` filter covering all items (e.g. \`field_name=in.(description,cost)&table_name=eq.services\`).
   - Keep batches reasonable (roughly up to 100 rows or ids per call); split larger sets.
   - Typical batches: all fields of a new entity, the \`<module>:read\` + \`<module>:manage\` permissions of a new module, all \`role_permission\` rows of a role, all \`permission_hierarchy\` rows of a module.
   - \`postgrestRequest\` also accepts an array \`body\`, but with raw PostgREST rules: all items must have **identical keys** unless you add \`?columns=col1,col2\` to the path, and omitted keys become NULL (no \`missing=default\`). Prefer the typed tools for bulk writes.

   ### Entity Management
   - **read_entity** — Query entities (use \`filters\` to find by \`table_name\` before creating)
   - **create_entity** — Define a new domain concept
   - **update_entity** — Modify entity metadata or permissions
   - **delete_entity** — Remove entity (check all dependencies first!). Refused with \`90260\` while fields of other entities reference it, whatever their \`reference_delete_mode\`, which governs deleting records rather than the entity: find them with \`read_field(filters: "reference_table=eq.<table_name>")\`, then delete them or point them at another entity. Refused with \`90266\` while a rollup of another entity aggregates over it. It drops the entity's table with all its records.

   ### Field Management
   - **read_field** — Query fields (filter by \`table_name\`; also use to find cross-references before deletion)
   - **create_field** — Add an attribute to an entity, or an aggregate over a child entity (\`rollup\`)
   - **update_field** — Modify field properties. ⚠️ \`format\` can only be changed to a format with the same physical database type (\`90223\` otherwise).
   - **delete_field** — Remove field and drop its column with all stored values (warn user about data loss; require confirmation). Core fields are refused (\`90217\`)

   ### Module Management
   - **read_module** — Check if a module exists before creating one
   - **create_module** — Create a new domain grouping
   - **update_module** — Modify module metadata
   - **delete_module** — Remove module INCLUDING all its entities, fields, and records (automatic cascade; do NOT delete entities first). Confirm with the user and, where the \`semantius\` CLI is available, back up first with its \`export_module\` (\`semantius call utils/export_module\`; it is a CLI tool, not a tool of this server). Refused with \`90260\` while a field of another module references one of its entities, and with \`90266\` while a rollup of another module aggregates over one; references between its own entities do not count. Two modules that reference each other need one such field removed first.

   ### RBAC Tools
   - **read_permission** / **create_permission** — Manage atomic capabilities
   - **read_permission_hierarchy** / **create_permission_hierarchy** — Set up permission inheritance
   - **read_role** / **create_role** — Manage permission bundles
   - **read_role_permission** / **create_role_permission** — Grant permissions to roles
   - **update_permission** / **delete_permission** — keyed by \`permission_name\`; renaming one cascades to every table that names it, and deleting is refused (foreign key violation) while an entity's \`view_permission\` or \`edit_permission\`, a module's \`view_permission\`, or a queue's \`view_permission\` or \`manage_permission\` names it; a module's \`manage_permission\` and \`admin_permission\` are cleared instead. Role grants, user grants and hierarchy entries of the permission are deleted with it
   - **update_permission_hierarchy** / **delete_permission_hierarchy** — keyed by \`id\` (\`"<including>.<included>"\`); \`origin\` never changes
   - **update_role** / **delete_role** — keyed by \`id\`; the \`origin\` never changes and the \`slug\` of a \`system\` role is fixed. Deleting a role also deletes its user assignments and permission grants; it is refused (\`90104\`) for the last enabled Administrator, and by a foreign key violation while a module names it as a default role
   - **update_role_permission** / **delete_role_permission** — keyed by \`id\` (\`"<role_id>.<permission_name>"\`)
   - **read_user** / **create_user** / **update_user** / **delete_user** — User identity management. Deleting a user also deletes their role assignments, direct permission grants and API keys, and is refused (\`90104\`) for the last enabled Administrator
   - **read_user_role** / **create_user_role** / **update_user_role** / **delete_user_role** — Assign roles to users; \`id\` is \`"<user_id>.<role_id>"\`. Every user already holds role 1, which cannot be removed (\`90103\`); the Administrator role cannot be removed from the last enabled Administrator (\`90104\`)

   ### Utilities
   - **getCurrentUser** — Get current user's profile and effective permissions. Also returns \`api_baseurl\` (for webhook/hook endpoints), \`semantius_org\` (the org slug), and \`ui_baseurl\` (the web UI base, e.g. \`https://<org>.semantius.app\`) for building links to the web user interface:
     - List of records for an entity: \`{ui_baseurl}/{module_slug}/{table_name}\` (e.g. \`https://mytest.semantius.app/hiring-starter/job_applications\`)
     - A specific record: \`{ui_baseurl}/{module_slug}/{table_name}/{id}\` (e.g. \`https://mytest.semantius.app/hiring-starter/job_applications/719\`)
   - **create_webhook_receiver** / **read_webhook_receiver** / **update_webhook_receiver** / **delete_webhook_receiver** — Inbound HTTP endpoints for external systems; deleting a receiver deletes its logs (see *Receive Records from an External System*)
   - **create_webhook_receiver_log** / **read_webhook_receiver_log** / **update_webhook_receiver_log** / **delete_webhook_receiver_log** — The delivery log of a receiver; the receiver writes it, you read it
   - **generate_api_key** / **list_api_keys** / **delete_api_key** — API keys of the caller (an admin may act for another user); \`generate_api_key\` returns \`{api_key, key_id}\` and the plaintext key is shown once
   - **get_cli_config** / **get_cli_token** — CLI setup text (creates a new API key on every call) and a short-lived JWT for the \`x-api-key\` header
   - **refresh_schema_cache** — Reloads PostgREST's schema cache; the cache refreshes by itself after structural changes, so call it only when a just-created entity or field is missing from \`postgrestRequest\` responses
   - **sendEmail** — Sends a transactional email (\`to\`, \`subject\`, and \`text\` or \`html\`; \`from\` defaults to the caller's email)
   - **get_schema** is not a tool of this server: it is the database function \`get_schema(p_table_name)\`, called with \`postgrestRequest\` as \`POST /rpc/get_schema\` and \`{"p_table_name": "<table>"}\`. It returns the entity's JSON schema (properties, \`inherited_from\`, \`ctype\`, \`is_core\`, \`rollup\`) and is verbose; a token-optimized tool is planned.
   - **postgrestRequest**: Direct PostgREST API for complex queries, filter-based bulk mutations, or per-row differing updates (typed tools already cover array creates and id-list updates/deletes)
   - **sqlToRest** — Convert SQL to PostgREST format for complex operations

   ---

   ## Common Errors and What to Do

   | Error | Meaning | Do |
   |-------|---------|----|
   | \`23503\` | A foreign key target does not exist | Create it first: base before based entity, permission or role before module wiring |
   | \`90212\` | A field's \`reference_table\` names no entity | Create the referenced entity first |
   | \`90260\` | Delete refused: a field of another entity references it | \`read_field\` with \`reference_table=eq.<table>\`, then delete or repoint those fields |
   | \`90266\` | Delete refused: a rollup uses it | Remove or change the rollup field first |
   | \`90247\` / \`90248\` | An \`is_a\` / \`has_a\` entity or a base still has records / entities are based on it | Delete its records / the based entities first |
   | \`90243\` | A field name repeats the base's | Create only the entity's own fields |
   | \`90241\` / \`90233\` | \`id_refentity\` / \`id_type\` changed on update | Omit them on update |
   | \`PGRST102\` | A bulk array whose rows have different keys (raw \`postgrestRequest\` only) | Give every row the same keys |
   | \`42P10\` | Upsert on an \`is_a\` / \`has_a\` entity | Insert, then PATCH |

   **Naming rules:** \`module_slug\` \`^[a-z0-9][a-z0-9_-]*\$\`; \`permission_name\` one or more segments \`[a-z0-9][a-z0-9_-]*\` joined by \`:\`; role \`slug\` \`^[a-z0-9_]+\$\`; \`field_name\` \`^[a-z_][a-z0-9_]*\$\` (a leading \`_\` is refused, \`90224\`).

   ---

   ## Agent Workflow Tips

   1. **Always read before writing** – Before any \`create_*\`, call the corresponding \`read_*\` to check for duplicates or find existing records. Example: always call \`read_entity\` filtering by \`table_name\` before \`create_entity\`. For a bulk create, one \`read_*\` with an \`in.(...)\` filter covers all items.
   2. **Resolve prerequisites in order** – Module → Permissions → Entity → Fields. Never skip steps.
   3. **Batch related writes** – Put all fields of one entity, both baseline permissions of one module, or all \`role_permission\` rows of one role into a single \`create_*\` call with an array in \`data\`; use an id array for \`update_*\` / \`delete_*\` across several records. Fewer calls, one transaction.
   4. **Be conversational** – Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
   5. **Validate semantic correctness** – Does the model make sense for the user's domain?
   6. **Ask for clarification when needed** – If a user says "add contacts", confirm what fields they need before creating anything.
   7. **Warn before risky changes** – Alert the user to medium/high-risk changes and wait for confirmation before executing.
   8. **Suggest next steps** – After creating an entity, suggest related entities, missing fields, or useful roles.
   9. **Provide link to UI** when you are done with creating or updating entities or fields provide a link to the user so they can verify your changes. Use the \`ui_baseurl\` from \`getCurrentUser\`: a list of records is \`{ui_baseurl}/{module_slug}/{table_name}\` and a specific record is \`{ui_baseurl}/{module_slug}/{table_name}/{id}\` (e.g. \`https://mytest.semantius.app/hiring-starter/job_applications/719\`).
`;
