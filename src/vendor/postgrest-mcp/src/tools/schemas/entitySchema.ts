/**
 * Shared schema for entities table
 * Used by both create_entity and update_entity tools
 */

import { z } from 'zod/v4'

export const entitySchema = z.looseObject({
  table_name: z.string().describe('Physical table name in database (Primary Key)'),
  singular: z.string().optional().describe('Singular form of table name'),
  plural: z.string().optional().describe('Plural form of table name, auto-assigned to table_name'),
  singular_label: z.string().describe('Human-readable singular label for UI/reports'),
  plural_label: z.string().optional().describe('Human-readable plural label for UI/reports'),
  icon_url: z.string().optional().describe('Optional URL or path to icon for this table'),
  description: z.string().optional().describe('Detailed description of the table'),
  module_id: z.number().int().describe('Module this table belongs to'),
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
  id_column: z.string().optional().describe('Name of primary key column'),
  label_column: z.string().optional().describe('Name of label/display column'),
  label_parent: z.string().optional()
    .describe('Composed-label identity spine: names the reference/parent FK field on this entity whose label this record\'s composed _label is built from. Empty = intrinsic/self-identifying (composed label = local label). Must be empty or a column-name identifier; validated against the fields catalog, must name a reference/parent field, and the spine graph must stay acyclic (no self-reference, not a junction entity).'),
  order_column: z.string().optional()
    .describe('Names an INTEGER column on this entity\'s physical table that stores a fixed row order. Empty = no fixed ordering. When set, the column is auto-provisioned and a BEFORE INSERT trigger auto-assigns MAX(order_column)+10. Must be empty or a column-name identifier.'),
  managed: z.boolean().optional().describe('When false, automatic DDL execution is disabled'),
  searchable: z.boolean().optional().describe('Whether table is included in full-text search (auto-computed)'),
  is_child: z.boolean().optional().describe('Whether table has any parent relationships (auto-computed)'),
  edit_mode: z.enum(['auto', 'sidebar', 'modal', 'page']).optional().describe('UI edit mode for records of this table'),
  cube_mode: z.enum(['disabled', 'auto']).optional().describe('Cube mode for OLAP cube generation'),
  audit_log: z.boolean().optional().describe('When TRUE, DML operations on this table are logged to audit_record_logs'),
  computed_fields: z.array(z.any()).optional().describe('Array of computed field definitions evaluated at read time'),
  validation_rules: z.array(z.any()).optional().describe('Array of validation rule definitions enforced on write'),
  select_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule evaluated per row for the FOR SELECT RLS policy. Must return a boolean indicating whether the current user is allowed to view the record (true = visible, false = filtered out). When non-empty, generates a policy function enforcing this rule. Must be a JSON object. Default {}.'),
  entity_type: z.enum(['operational_workflow', 'operational_record', 'catalog', 'junction', 'computed', 'unclassified']).optional()
    .describe('Data-class axis; the write tier derives from it. "unclassified" (default) means absent/derive-locally. Readonly; populated by the deploy pipeline.'),
  catalog_entity_code: z.string().optional()
    .describe('Catalog/blueprint provenance: stable canonical identity this entity realizes (uber-model code, e.g. "vendors"); the rename/dialect/silo join key. table_name holds the deployed name. Write-once (cannot be changed once set). Empty = created outside the deploy pipeline. Populated by the deploy pipeline; do not set manually.'),
  catalog_owner_module: z.string().optional()
    .describe('For an embedded-master placeholder, the slug of the module that should own this entity. Soft pointer (not an FK); empty when this module is the owner or the entity is local.'),
  catalog_entity_aliases: z.array(z.any()).optional()
    .describe('Reuse/merge ledger: JSON array of {alias_code, source_domain, source_module, decided}. Append-only (existing elements cannot be removed or rewritten). Empty array = never a merge target.'),
})
