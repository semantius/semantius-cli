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
  table_name: z.string().describe('Entity this field belongs to'),
  field_name: z.string().describe('Physical column name in database: lowercase letters, digits and _. Names starting with _ are reserved for generated system columns such as _label.'),
  title: z.string().describe('Human-readable display name for the field'),
  description: z.string().optional().describe('What the field represents. Also written into the column comment, which PostgREST shows in its OpenAPI output.'),
  format: z.enum(FIELD_FORMATS).optional()
    .describe('JSON Schema format or primitive type'),
  is_pk: z.boolean().optional().describe('Whether this field is the primary key; cannot change after the field is created'),
  default_value: z.string().optional().describe('Column default: a literal value or an SQL expression such as CURRENT_TIMESTAMP'),
  field_order: z.number().int().optional().describe('Display order of the field within its entity'),
  input_type: z.enum(['default', 'required', 'readonly', 'disabled', 'hidden']).optional()
    .describe('How the UI presents the field for input; input_type_rule can override it per record'),
  width: z.enum(['default','s', 'm', 'w']).optional().describe('Display width of the field in the UI: default (automatic), s (small), m (medium) or w (wide)'),
  ctype: z.enum(['', 'id', 'label', 'audit', 'core']).optional()
    .describe('Marks a DD-managed core column: empty (normal user field), id (primary key), label (display field), audit (record-versioning columns such as created_at and updated_at) or core (other system columns). A core column cannot be deleted or renamed (the label column may be renamed), and its format and default value cannot change. Set by the DD only and never changed.'),
  searchable: z.boolean().optional().describe('Whether field is included in full-text search'),
  enum_values: z.unknown().optional().nullable().describe('JSON array of the allowed values of an enum field, e.g. ["active", "inactive", "pending"]'),
  reference_table: z.string().optional().describe('Entity this field references, by table name. Required for reference and parent fields, empty for all others, and must name an existing entity.'),
  reference_delete_mode: z.enum(['', 'restrict', 'clear', 'cascade']).optional()
    .describe('What happens to this record when the referenced record is deleted: restrict (the delete is blocked), clear (this field is set to NULL) or cascade (this record is deleted too). Empty on fields that are not a reference or parent; on a reference, empty acts as restrict.'),
  relationship_label: z.string().optional()
    .describe('Verb describing what the referenced entity does to/with this entity (e.g. "employs", "heads"). Used for ER diagram and navigation labels.'),
  singular_label_parent: z.string().optional()
    .describe('Custom singular label for the parent entity when format is parent; overrides the singular_label of the parent entity when set'),
  plural_label_parent: z.string().optional()
    .describe('Custom plural label for the parent entity when format is parent; overrides the plural_label of the parent entity when set'),
  precision: z.number().int().min(0).max(18).optional()
    .describe('Decimal scale (digits after the decimal point) used when generating NUMERIC columns for number formats. Default 2.'),
  unique_value: z.boolean().optional()
    .describe('When TRUE, enforces a partial unique index on this column. For string types, NULL and empty string values are excluded from the uniqueness check.'),
  cube_type: z.enum(['disabled', 'auto', 'dimension', 'measure']).optional()
    .describe('Role of the field in the generated OLAP cube (dimension or measure); auto lets the platform choose, disabled leaves the field out'),
  input_type_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule evaluated client-side against the record being edited. It returns an input_type (default, required, readonly, disabled or hidden) that replaces the static input_type. Empty = no rule.'),
  catalog_field_code: z.string().optional()
    .describe('Stable design-time field identity (blueprint field name, e.g. "status"); the field-rename join key. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'),
})
