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
  table_name: z.string().describe('Entity this field belongs to. On an is_a or has_a entity create only its own fields. A field name must be unique across an entity, its base entities and the entities based on it (90243); the key and created_at/updated_at are exempt.'),
  field_name: z.string().describe('Physical column name in database: lowercase letters, digits and _. Names starting with _ are reserved for generated system columns such as _label.'),
  title: z.string().describe('Human-readable display name for the field'),
  description: z.string().optional().describe('What the field represents. Also written into the column comment, which PostgREST shows in its OpenAPI output.'),
  format: z.enum(FIELD_FORMATS).optional()
    .describe('JSON Schema format or primitive type. May change only to a format with the same column type (for example text to multiline). A change that would alter the column type is refused (90223; drop and recreate the field instead); the format of a core column cannot change at all (90219).'),
  is_pk: z.boolean().optional().describe('Whether this field is the primary key; cannot change after the field is created'),
  // The column is text. A number or boolean is stored as its text ("1", "true"), an object or array as its JSON.
  default_value: z.codec(
    z.union([z.string(), z.number(), z.boolean(), z.array(z.any()), z.record(z.string(), z.any())]),
    z.string(),
    {
      decode: (v) => (typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)),
      encode: (v) => v,
    },
  ).optional()
    .describe('Column default, stored as text. Computed on every insert, in UTC, where the column type fits: on a date field today, tomorrow or yesterday; on a date-time field now, or today, tomorrow or yesterday for midnight of that day; on a time field now. $today, $now, CURRENT_DATE, now() and the other SQL date and time keywords read the same. A day word in any other form ("today + 7", "tomorrow 09:00") is refused (90284). On a uuid field gen_random_uuid(). On a reference or parent field to users CURRENT_USER or $user_id: the signed-in user\'s id, NULL without one, never filled into existing rows, so a required or parent one cannot be added to a table with rows (90259). Elsewhere both are refused (90283), except CURRENT_USER on a field stored as TEXT, which stores the database role name. A value the write sends wins. Any other text is a fixed value cast to the column type. Maximum 200 characters; no ";", "--" or "/*". Empty means the type\'s zero value (reference, date, time, date-time and uuid: no default, the column stays NULL). A number, boolean or JSON value is converted ("1", "true", "{}"). For an enum field give the stored value, never the label.'),
  field_order: z.number().int().optional().describe('Display order of the field within its entity'),
  input_type: z.enum(['default', 'required', 'readonly', 'disabled', 'hidden']).optional()
    .describe('How the UI presents the field for input; input_type_rule can override it per record. On a required field with no input_type_rule, the database also refuses a missing value (90258), except for number, boolean and duration formats, the key, parent fields and a field with an input_type_rule; making a field required while rows lack a value is refused (90259). A rollup, computed or computed_label field keeps the input_type set here: the database overwrites what a form submits, and a client shows a visible derived field disabled because of its ctype.'),
  width: z.enum(['default','s', 'm', 'w']).optional().describe('Display width of the field in the UI: default (automatic), s (small), m (medium) or w (wide)'),
  // Every value of the valid_ctype check is listed so a field read back can be written back unchanged.
  ctype: z.enum(['', 'id', 'label', 'audit', 'core', 'rollup', 'computed', 'computed_label']).optional()
    .describe('Special column type: id, label, computed_label, audit and core mark a column the dictionary protects; rollup marks a field whose value the database aggregates from its rollup definition, computed a field whose value one of the entity\'s computed_fields rules writes, and computed_label the label column when such a rule writes it. A client shows rollup, computed and computed_label fields disabled. Derived, never set by hand. Empty is a normal user field, audit covers record-versioning columns such as created_at and updated_at, and core other system columns. A protected column cannot be deleted or renamed (the label column may be renamed), and its format and default value cannot change (the label column\'s default value may). A rollup or computed field can still be deleted, and a rollup field renamed; a field a rule names (computed, computed_label) cannot be renamed while the rule names it (90275). Ignored on create; changing it on update is refused with 90214.'),
  searchable: z.boolean().optional().describe('Whether the field is included in full-text search. Takes effect for text-like formats only (not numbers, booleans, JSON or references).'),
  enum_values: z.array(z.union([
    z.string(),
    z.object({
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
    }),
  ])).optional().nullable()
    .describe('JSON array in display order. Each entry is a value or a {"value", "label"} object with an optional "description", "color" and "icon", e.g. ["active", {"value": "on_hold", "label": "On hold", "color": "amber"}]. Records store the value; the label, description, color and icon are display hints. color takes an HTML color and icon a Lucide icon name in kebab-case (e.g. "circle-check"; latest Lucide release, names searchable in https://cdn.jsdelivr.net/npm/lucide-static/tags.json), as the color and icon formats do. Use an object when the value is a code or abbreviation or needs a color or icon. An empty or missing list means no value check. Unless the field is required, "" is also allowed and is the default. Removing a value still in use is refused (23514).'),
  reference_table: z.string().optional().describe('Entity this field references, by table name. Required for reference and parent fields, empty for all others, and must name an existing entity.'),
  reference_delete_mode: z.enum(['', 'restrict', 'clear', 'cascade']).optional()
    .describe('What happens to this record when the referenced record is deleted: restrict (the delete is blocked; the default when omitted, on every format), clear (this field is set to NULL) or cascade (this record is deleted too; refused on a field of an is_a entity, 90249). Only reference and parent fields use it; elsewhere it is ignored. A required reference cannot use clear (90257).'),
  relationship_label: z.string().optional()
    .describe('Verb describing what the referenced entity does to/with this entity (e.g. "employs", "heads"). Used for ER diagram and navigation labels.'),
  singular_label_parent: z.string().optional()
    .describe('Custom singular label for the parent entity when format is parent; overrides the singular_label of the parent entity when set'),
  plural_label_parent: z.string().optional()
    .describe('Custom plural label for the parent entity when format is parent; overrides the plural_label of the parent entity when set'),
  precision: z.number().int().min(0).max(18).optional()
    .describe('Decimal scale of the NUMERIC(18, n) column for format number (0-18, default 2); other formats ignore it. A change alters the column: lowering it rounds the stored values, and any change of scale rewrites the table under an exclusive lock. A rollup over the field keeps the precision it copied until the rollup is saved again with a change of its definition, format or precision.'),
  unique_value: z.boolean().optional()
    .describe('When TRUE, enforces a partial unique index on this column. For string types, NULL and empty string values are excluded from the uniqueness check.'),
  cube_type: z.enum(['disabled', 'auto', 'dimension', 'measure']).optional()
    .describe('Role of the field in the generated OLAP cube (dimension or measure); auto lets the platform choose, disabled leaves the field out'),
  input_type_rule: z.record(z.string(), z.any()).optional()
    .describe('JsonLogic rule evaluated client-side against the record being edited. It returns an input_type (default, required, readonly, disabled or hidden) that replaces the static input_type. Empty = no rule.'),
  catalog_field_code: z.string().optional()
    .describe('Stable design-time field identity (blueprint field name, e.g. "status"); the field-rename join key. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'),
  rollup: z.record(z.string(), z.any()).optional()
    .describe('Rollup definition, empty for an ordinary field. Keys: link_field (<child entity>.<reference or parent field pointing at this entity>), function (sum, min, max, avg or count), value_field (a field of the child; not with count), filter (JsonLogic over the child record, restricted to and, or, !, comparisons, in and var; optional) and include_hidden_rows (true accepts aggregating child records that readers of this entity may not see). The field keeps an ordinary format that fits the result: int64 (or int32, integer, number) for count, the value field\'s own format for min and max, number, integer, int32, int64, float, double or rating for sum, number, float or double for avg (90268 if the format does not fit); precision is copied from the value field when that is a number field. The database maintains the column and sets ctype to rollup. The child entity, link_field and value_field must already exist. A rollup cannot be required, searchable or unique_value (90261), and neither side can be an is_a or has_a entity (90249). Send {} to remove the definition: the field stays, with its last values as ordinary data.'),
})
