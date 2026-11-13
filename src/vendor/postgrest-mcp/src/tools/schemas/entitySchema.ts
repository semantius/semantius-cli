/**
 * Shared schema for entities table
 * Used by both create_entity and update_entity tools
 */

import { z } from 'zod/v4'

export const entitySchema = z.looseObject({
  table_name: z.string().describe('Physical table name: lowercase letters, digits and _, starting with a letter or _, and not ending in _ext (reserved). Primary key. Changing it on update renames the physical table.'),
  singular: z.string().optional().describe('Singular form of table name (on create, auto-derived from table_name when blank)'),
  plural: z.string().optional().describe('Plural form of table name, auto-assigned to table_name'),
  singular_label: z.string().optional().describe('Human-readable singular noun for UI/reports (e.g. Customer), symmetric with plural_label. On create, when blank it is derived from singular (service becomes "Service"), so pass it whenever that is not the right noun. It does not set the title of the label field: that is label_column_label.'),
  plural_label: z.string().optional().describe('Human-readable plural label for UI/reports (e.g. Customers)'),
  icon_name: z.string().optional().describe('Icon shown for the entity: a Lucide icon name in kebab-case (e.g. "users"; latest Lucide release, names searchable in https://cdn.jsdelivr.net/npm/lucide-static/tags.json) or an icon URL'),
  name_sort: z.string().optional().describe('Sort key that orders entities in navigation'),
  description: z.string().optional().describe('What the entity represents'),
  module_id: z.number().int().describe('Module this entity belongs to'),
  view_permission: z
    .string()
    .optional()
    .describe(
      'Permission required to SELECT from this table, by name. It must already exist: this is a foreign key to permissions(permission_name), so an unregistered name is rejected with a foreign-key error rather than accepted. Create the permission first, then the entity. A rollup between two entities with different view permissions needs include_hidden_rows (90269).'
    ),
  edit_permission: z
    .string()
    .optional()
    .describe(
      'Permission required to INSERT/UPDATE/DELETE from this table, by name. Same foreign key as view_permission: the permission must already exist. A permission an entity names cannot be deleted while the entity stands.'
    ),
  id_column: z.string().optional().describe('Name of the primary key column (default id), created automatically. Set on create and locked afterwards (a change is refused with 90253); omit it on update.'),
  // Optional rather than .default(): this schema also serves update_entity, and
  // a default would send id_type with every update, which the database refuses
  // for any entity whose key type is not the default.
  id_type: z.enum(['auto_increment', 'bigint', 'text', 'uuid', 'typeid', 'is_a', 'has_a', 'computed']).optional()
    .describe('Key type of the table, set on create and locked afterwards (changing it is refused with 90233); omit it on update. auto_increment (the default when omitted): a 64-bit number the database assigns. bigint: a 64-bit number the caller supplies on every insert. text: a text key the caller supplies. uuid: a time-ordered UUIDv7 the database assigns. typeid: a prefixed, sortable TypeID such as acct_01h455vb4pex5vsknk084sn02q, assigned by the database; requires id_prefix. is_a: a subtype of the typeid or is_a entity named in id_refentity; each record is exactly one type, shares the key of its base record and carries the subtype\'s own prefix; requires id_prefix and id_refentity. has_a: an optional extension of the typeid entity named in id_refentity; a base record has at most one, and it takes the base record\'s key; requires id_refentity. computed: system tables only, refused for a new entity (90234). The id field itself is created automatically; never create it with create_field. is_a and has_a entities cannot set label_column, label_column_label, label_parent or order_column.'),
  id_prefix: z.string().optional()
    .describe('TypeID prefix, required when id_type is typeid or is_a and empty otherwise: up to 63 lowercase letters and underscores, starting and ending with a letter (e.g. acct). Unique among entities. A typeid entity may change it later: new ids take the new prefix, existing ids keep theirs, and an id with a former prefix can no longer be inserted. An is_a entity keeps the prefix it was created with (90245), because the prefix is what says which subtype a record is.'),
  // Optional with no default, like id_type: it is set on create only, and an
  // update that sent it would be refused (90241).
  id_refentity: z.string().optional()
    .describe('The entity an is_a or has_a entity is based on, whose key its records share. An is_a entity is based on a typeid or is_a entity, a has_a entity on a typeid entity. Set when the entity is created and never changed; empty for every other key type. Omit it on update (a change is refused with 90241).'),
  label_column: z.string().optional().describe('Name of the label/display column, created automatically'),
  // Optional with no default: an update that sent '' would reset the label
  // field's title to the derived default.
  label_column_label: z.string().optional()
    .describe('Title of the label field. Give it in the same call that creates the entity (e.g. "Offer #" for label_column offer_number); no update_field call is needed. Left empty, it is derived from label_column without the entity\'s own name (company_name on companies gives "Name", region_description on regions gives "Description"), except that a column ending in _number, _no, _id or _code keeps it (offer_number gives "Offer Number"). Always equal to the label field\'s title: changing either one changes both. is_a and has_a entities take it from their base (90242).'),
  label_parent: z.string().optional()
    .describe('Reference or parent field of this entity whose record label the composed _label is built from (the identity spine). Empty = self-identifying: the composed label is the local label. Not allowed on a junction entity, and the spine must stay acyclic. Changing it re-points the composed label; no data is migrated.'),
  order_column: z.string().optional()
    .describe('Name of an integer column that stores a fixed row order. Setting it creates an INTEGER NOT NULL column (default 0) on a managed entity, and a record inserted with no value or 0 gets MAX + 10 (10 for the first). Renaming or clearing it drops the old column and its data. Not available for is_a or has_a entities (90249). Empty = no fixed order.'),
  managed: z.boolean().optional().describe('When false, automatic DDL execution for table and field changes is disabled'),
  searchable: z.boolean().optional().describe('Whether table is included in full-text search (auto-computed)'),
  is_child: z.boolean().optional().describe('Whether table has any parent relationships (auto-computed)'),
  edit_mode: z.enum(['auto', 'sidebar', 'modal', 'page']).optional().describe('UI edit mode for records of this table: auto, sidebar, modal, or page'),
  cube_mode: z.enum(['disabled', 'auto']).optional().describe('Cube mode for OLAP cube generation. Default auto.'),
  audit_log: z.boolean().optional().describe('When TRUE, DML operations on this table are logged to audit_record_logs'),
  computed_fields: z.array(z.any()).optional().describe('Ordered list of {name, jsonlogic, description?} entries (name and jsonlogic are required), evaluated and stored on every insert and update: each entry derives the named field from the same record before the write. Saving applies the rules to existing records, and a record that cannot take its new value refuses the save (90908). A named field gets ctype computed, and input_type default or readonly becomes disabled. A rule cannot name a rollup field (90907). Default []. On update the list replaces the stored list: send the full list; [] removes the rules.'),
  validation_rules: z.array(z.any()).optional().describe('Ordered list of {code, message, jsonlogic, hint?, description?} entries. code, message and jsonlogic are required; code must be a five-digit class 99 code such as "99001" (otherwise refused with 90905). Each rule must evaluate truthy for the write to succeed. Default []. On update the list replaces the stored list: send the full list; [] removes the rules.'),
  select_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule evaluated per row for the FOR SELECT RLS policy: true = the current user may see the record. Empty = no per-row rule. Setting a rule on an entity that a rollup aggregates over needs include_hidden_rows on that rollup (90269).'),
  entity_type: z.enum(['operational_workflow', 'operational_record', 'catalog', 'junction', 'computed', 'unclassified']).optional()
    .describe('What kind of data this entity holds. operational_workflow: records move through a gated lifecycle (even one gated step such as draft to submitted counts). operational_record: everyday business records without such a lifecycle. catalog: reference or lookup data maintained by admins. junction: a pure connecting record between entities with no fields of its own; the platform labels its rows by the records they relate. computed: every field is derived and never written directly. unclassified: not classified yet (the default). Set it on create or change it on update like any other column.'),
  catalog_entity_code: z.string().optional()
    .describe('Stable canonical identity this entity realizes (domain-map code, e.g. "vendors"); the rename/dialect/silo join key. table_name holds the deployed name. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'),
  catalog_owner_module: z.string().optional()
    .describe('For an embedded-master placeholder, the slug of the module that should own this entity. Soft pointer (not an FK); empty when this module is the owner or the entity is local.'),
  catalog_entity_aliases: z.array(z.any()).optional()
    .describe('Reuse/merge record: JSON array of {alias_code, source_domain, source_module, decided}. Append-only. Empty array = never a merge target.'),
})
