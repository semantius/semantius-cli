/**
 * Shared schema for entities table
 * Used by both create_entity and update_entity tools
 */

import { z } from 'zod/v4'

export const entitySchema = z.looseObject({
  table_name: z.string().describe('Physical table name in database: lowercase letters, digits and _, starting with a letter or _. Primary key.'),
  singular: z.string().optional().describe('Singular form of table name (auto-derived from table_name when blank)'),
  plural: z.string().optional().describe('Plural form of table name, auto-assigned to table_name'),
  singular_label: z.string().describe('Human-readable singular label for UI/reports (e.g. Customer)'),
  plural_label: z.string().optional().describe('Human-readable plural label for UI/reports (e.g. Customers)'),
  icon_url: z.string().optional().describe('Optional URL or path to icon for this table'),
  description: z.string().optional().describe('What the entity represents'),
  module_id: z.number().int().describe('Module this entity belongs to'),
  view_permission: z
    .string()
    .optional()
    .describe(
      'Permission required to SELECT from this table, by name. It must already exist: this is a foreign key to permissions(permission_name), so an unregistered name is rejected with a foreign-key error rather than accepted. Create the permission first, then the entity.'
    ),
  edit_permission: z
    .string()
    .optional()
    .describe(
      'Permission required to INSERT/UPDATE/DELETE from this table, by name. Same foreign key as view_permission: the permission must already exist. A permission an entity names cannot be deleted while the entity stands.'
    ),
  id_column: z.string().optional().describe('Name of the primary key column, created automatically'),
  // Optional rather than .default(): this schema also serves update_entity, and
  // a default would send id_type with every update, which the database refuses
  // for any entity whose key type is not the default.
  id_type: z.enum(['auto_increment', 'bigint', 'text', 'uuid', 'typeid', 'computed']).optional()
    .describe('Key type of the table, set on create and locked afterwards (changing it is refused with 90233); omit it on update. auto_increment (the default when omitted): a 64-bit number the database assigns. bigint: a 64-bit number the caller supplies on every insert. text: a text key the caller supplies. uuid: a time-ordered UUIDv7 the database assigns. typeid: a prefixed, sortable TypeID such as acct_01h455vb4pex5vsknk084sn02q, assigned by the database; requires id_prefix. computed: system tables only, refused for a new entity (90234). The id field itself is created automatically; never create it with create_field.'),
  id_prefix: z.string().optional()
    .describe('TypeID prefix, required when id_type is typeid and empty otherwise: up to 63 lowercase letters and underscores, starting and ending with a letter (e.g. acct). Unique among entities. May be changed later: new ids take the new prefix, existing ids keep theirs, and an id with a former prefix can no longer be inserted.'),
  label_column: z.string().optional().describe('Name of the label/display column, created automatically'),
  label_parent: z.string().optional()
    .describe('Reference or parent field of this entity whose record label the composed _label is built from (the identity spine). Empty = self-identifying: the composed label is the local label. Not allowed on a junction entity, and the spine must stay acyclic.'),
  order_column: z.string().optional()
    .describe('Name of an integer column that stores a fixed row order. Setting it creates the column, and a record inserted without a value gets MAX + 10. Empty = no fixed order.'),
  managed: z.boolean().optional().describe('When false, automatic DDL execution for table and field changes is disabled'),
  searchable: z.boolean().optional().describe('Whether table is included in full-text search (auto-computed)'),
  is_child: z.boolean().optional().describe('Whether table has any parent relationships (auto-computed)'),
  edit_mode: z.enum(['auto', 'sidebar', 'modal', 'page']).optional().describe('UI edit mode for records of this table: auto, sidebar, modal, or page'),
  cube_mode: z.enum(['disabled', 'auto']).optional().describe('Cube mode for OLAP cube generation'),
  audit_log: z.boolean().optional().describe('When TRUE, DML operations on this table are logged to audit_record_logs'),
  computed_fields: z.array(z.any()).optional().describe('Ordered list of {name, jsonlogic, description?} entries, evaluated and stored on every insert and update: each entry derives the named field from the same record before the write'),
  validation_rules: z.array(z.any()).optional().describe('Ordered list of {code, message, jsonlogic, description?} entries; each must evaluate truthy for the write to succeed'),
  select_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule evaluated per row for the FOR SELECT RLS policy: true = the current user may see the record. Empty = no per-row rule.'),
  entity_type: z.enum(['operational_workflow', 'operational_record', 'catalog', 'junction', 'computed', 'unclassified']).optional()
    .describe('What kind of data this entity holds. operational_workflow: records move through a gated lifecycle (even one gated step such as draft to submitted counts). operational_record: everyday business records without such a lifecycle. catalog: reference or lookup data maintained by admins. junction: a pure link between entities with no fields of its own; the platform labels its rows by the records they link. computed: every field is derived and never written directly. unclassified: not classified yet (the default). Set it on create or change it on update like any other column.'),
  catalog_entity_code: z.string().optional()
    .describe('Stable canonical identity this entity realizes (uber-model code, e.g. "vendors"); the rename/dialect/silo join key. table_name holds the deployed name. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'),
  catalog_owner_module: z.string().optional()
    .describe('For an embedded-master placeholder, the slug of the module that should own this entity. Soft pointer (not an FK); empty when this module is the owner or the entity is local.'),
  catalog_entity_aliases: z.array(z.any()).optional()
    .describe('Reuse/merge record: JSON array of {alias_code, source_domain, source_module, decided}. Append-only. Empty array = never a merge target.'),
})
