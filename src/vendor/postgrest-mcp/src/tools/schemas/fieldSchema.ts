/**
 * Shared schema for fields table
 * Used by both create_field and update_field tools
 */

import { z } from 'zod/v4'
import formats from './formats.json' with { type: 'json' }

/**
 * The only valid field formats, taken verbatim from sem-schema's format catalog.
 * `src/tools/schemas/formats.json` is a copy: never edit it here, change it in
 * sem-schema and copy the file again.
 *
 * Every field must have a format; `null` is not one of them.
 */
export const FIELD_FORMATS = Object.keys(formats) as [string, ...string[]]

export const fieldSchema = z.looseObject({
  id: z.string().optional().describe('Generated identifier (table_name.field_name) - Auto-generated'),
  table_name: z.string().describe('Table this field belongs to'),
  field_name: z.string().describe('Physical column name in database'),
  title: z.string().describe('Human-readable display name for the field'),
  description: z.string().optional().describe('Detailed description of the field'),
  format: z.enum(FIELD_FORMATS).optional()
    .describe('JSON Schema format or primitive type'),
  is_pk: z.boolean().optional().describe('Whether this field is the primary key'),
  default_value: z.string().optional().describe('Default value for the field'),
  field_order: z.number().int().optional().describe('Display order for the field'),
  input_type: z.enum(['default', 'required', 'readonly', 'disabled', 'hidden']).optional()
    .describe('Input type for UI rendering'),
  width: z.enum(['default','s', 'm', 'w']).optional().describe('Display width for UI rendering'),
  ctype: z.enum(['', 'id', 'label', 'audit', 'core']).optional()
    .describe('Special column type and the single marker of a DD-managed core column: empty string (normal user-editable field), "id" (primary key), "label" (display field), "audit" (managed record-versioning columns like created_at/updated_at), or "core" (other system/metadata columns). A non-empty ctype marks the column as core and protects it against rename/format/default/delete (the label column rename being the one allowed exception). ctype is immutable and can only be set by privileged DD code; do not set or change it manually. The former is_core flag is derived as (ctype <> \'\').'),
  searchable: z.boolean().optional().describe('Whether field is included in full-text search'),
  enum_values: z.unknown().optional().nullable().describe('JSON array of allowed enum values'),
  reference_table: z.string().optional().describe('Table name for foreign key relationships'),
  reference_delete_mode: z.enum(['', 'restrict', 'clear', 'cascade']).optional()
    .describe('ON DELETE behavior: empty string (none), restrict, clear, or cascade'),
  relationship_label: z.string().optional()
    .describe('Verb describing what the referenced entity does to/with this entity (e.g. "employs", "heads"). Used for ER diagram and navigation labels.'),
  singular_label_parent: z.string().optional()
    .describe('Custom singular label for the parent entity when format is "parent". Overrides the default singular_label from the parent entity when set.'),
  plural_label_parent: z.string().optional()
    .describe('Custom plural label for the parent entity when format is "parent". Overrides the default plural_label from the parent entity when set.'),
  precision: z.number().int().min(0).max(18).optional()
    .describe('Decimal scale (digits after the decimal point) used when generating NUMERIC columns for number formats. Default 2.'),
  unique_value: z.boolean().optional()
    .describe('When TRUE, enforces a partial unique index on this column. For string types, NULL and empty string values are excluded from the uniqueness check.'),
  cube_type: z.enum(['disabled', 'auto', 'dimension', 'measure']).optional()
    .describe('Cube type for OLAP cube generation'),
  input_type_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule that dynamically overrides the static input_type. Must return one of the valid input_type enum values ("default", "required", "readonly", "disabled", "hidden"); the returned value replaces the static input_type at runtime. Must be a JSON object. Default {}.'),
  catalog_field_code: z.string().optional()
    .describe('Catalog/blueprint provenance: stable design-time field identity (blueprint field name, e.g. "status"); the field-rename join key. Write-once (cannot be changed once set). Empty = created outside the deploy pipeline. Populated by the deploy pipeline; do not set manually.'),
})
