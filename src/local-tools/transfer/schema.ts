/**
 * generate_module_schema: the JSON Schema (draft-07) of the transfer file that
 * export_entities / export_module write and import_entities / import_module
 * read (format.ts).
 *
 * Nothing here is a second list of columns. Every property comes from the same
 * column lists format.ts writes and reads with (MODULE_COLUMNS, FIELD_COLUMNS,
 * ...), and its type, enum and description from the vendored zod schema of the
 * same name, converted by zod. A column the vendored schemas gain therefore
 * reaches the file and this schema together, and the schema cannot name a
 * column the exporter does not write.
 *
 * What it describes is THIS CLI: the columns it writes and the ones it reads.
 * Both sides copy rows with pick(), so a column outside the lists is dropped
 * silently, and the schema flags it (additionalProperties: false). It says
 * nothing about what a given host accepts, and a record's columns are the
 * entity's own fields, so "records" is only "an object per record".
 *
 * Optional columns are nullable: the exporter writes what PostgREST returns,
 * and an unset column comes back as null.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { entitySchema } from '../../vendor/postgrest-mcp/src/tools/schemas/entitySchema.js';
import { fieldSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/fieldSchema.js';
import { moduleSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/moduleSchema.js';
import { permissionSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/permissionSchema.js';
import { permission_hierarchySchema } from '../../vendor/postgrest-mcp/src/tools/schemas/permission_hierarchySchema.js';
import { roleSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/roleSchema.js';
import {
  ENTITY_COLUMNS,
  ENTITY_CREATE_ONLY,
  FIELD_COLUMNS,
  FIELD_CREATE_ONLY,
  FIELD_READ_ONLY,
  HIERARCHY_COLUMNS,
  MODULE_COLUMNS,
  MODULE_CREATE_ONLY,
  MODULE_ROLE_COLUMNS,
  PERMISSION_COLUMNS,
  ROLE_COLUMNS,
  ROLE_CREATE_ONLY,
  TRANSFER_VERSION,
} from './format.js';

type Json = Record<string, unknown>;

/** Where the CLI writes the schema when the caller names no path. */
export const DEFAULT_SCHEMA_PATH = 'semantius-transfer.schema.json';

const CREATE_ONLY =
  'Create-only: sent when the row is created on the target, never changed by a later import.';
const READ_ONLY =
  'Read-only: exported for information, never written by the import.';

/** A column the file carries as a name where the host has an id. */
interface Substitute {
  schema: Json;
  required?: boolean;
}

interface SectionOptions {
  /** File columns that replace a host id: described here, not by zod. */
  substitutes?: Record<string, Substitute>;
  createOnly?: readonly string[];
  readOnly?: readonly string[];
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** zod bounds every .int() to the safe integers: noise in a schema to read. */
function withoutIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutIntegerBounds);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    const isBound =
      (key === 'minimum' && value === -SAFE_INTEGER) ||
      (key === 'maximum' && value === SAFE_INTEGER);
    if (!isBound) out[key] = withoutIntegerBounds(value);
  }
  return out;
}

function acceptsNull(schema: Json): boolean {
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if (schema.const === null) return true;
  return (
    Array.isArray(schema.anyOf) && schema.anyOf.some((s) => acceptsNull(s))
  );
}

/** Whether the schema says anything about the value: `{}` already takes null. */
function constrainsValue(schema: Json): boolean {
  return ['type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref'].some(
    (key) => key in schema,
  );
}

/** `schema` or null, with its description kept on the outside. */
function nullable(schema: Json): Json {
  if (!constrainsValue(schema) || acceptsNull(schema)) return schema;
  const { description, ...rest } = schema;
  return {
    ...(description === undefined ? {} : { description }),
    anyOf: [rest, { type: 'null' }],
  };
}

function describe(schema: Json, note: string): Json {
  return {
    ...schema,
    description: [schema.description, note].filter(Boolean).join(' '),
  };
}

/**
 * An object schema for one kind of row. `columns` is the file's column list in
 * file order; the type of each comes from `source`, the zod schema it was
 * derived from. A column zod requires is required, the others are nullable.
 */
function rowSchema(
  source: { shape: z.ZodRawShape },
  columns: readonly string[],
  options: SectionOptions = {},
): { schema: Json; required: string[] } {
  const { substitutes = {}, createOnly = [], readOnly = [] } = options;

  const shape: Record<string, z.core.$ZodType> = {};
  for (const column of columns) {
    if (column in substitutes) continue;
    if (!(column in source.shape)) {
      throw new Error(`the vendored schema has no column ${column}`);
    }
    shape[column] = source.shape[column];
  }
  const converted = withoutIntegerBounds(
    z.toJSONSchema(z.object(shape), {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    }),
  ) as { properties: Record<string, Json>; required?: string[] };

  const requiredByZod = new Set(converted.required ?? []);
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const column of columns) {
    const substitute = substitutes[column];
    const isRequired = substitute
      ? Boolean(substitute.required)
      : requiredByZod.has(column);
    if (isRequired) required.push(column);

    let property = substitute
      ? substitute.schema
      : converted.properties[column];
    if (!isRequired) property = nullable(property);
    if (createOnly.includes(column)) property = describe(property, CREATE_ONLY);
    if (readOnly.includes(column)) {
      property = { ...describe(property, READ_ONLY), readOnly: true };
    }
    properties[column] = property;
  }

  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    required,
  };
}

const text = (description: string): Json => ({ type: 'string', description });
const nullableText = (description: string): Json => ({
  anyOf: [{ type: 'string' }, { type: 'null' }],
  description,
});

function moduleSection(): Json {
  const substitutes: Record<string, Substitute> = {};
  for (const [idColumn, slugColumn] of Object.entries(MODULE_ROLE_COLUMNS)) {
    substitutes[slugColumn] = {
      schema: nullableText(
        `slug of the role named by ${idColumn} on the exporting host (a role of this module, or of another module that must exist on the target); null for none`,
      ),
    };
  }
  const { schema } = rowSchema(moduleSchema, MODULE_COLUMNS, {
    substitutes,
    createOnly: MODULE_CREATE_ONLY,
  });
  return {
    ...schema,
    description:
      'The module itself. Present in a file from export_module, absent from export_entities; import_module needs it.',
  };
}

function entitySection(): Json {
  const entity = rowSchema(entitySchema, ENTITY_COLUMNS, {
    substitutes: {
      module_name: {
        schema: text('module_name of the module the entity belongs to'),
        required: true,
      },
    },
    createOnly: ENTITY_CREATE_ONLY,
  });
  const field = rowSchema(fieldSchema, FIELD_COLUMNS, {
    createOnly: FIELD_CREATE_ONLY,
    readOnly: FIELD_READ_ONLY,
  });

  const properties = {
    ...(entity.schema.properties as Record<string, Json>),
    fields: {
      type: 'array',
      description:
        "The entity's fields in field_order. Absent from an export made with exclude_schema, which carries table_name only.",
      items: field.schema,
    },
  };
  return {
    type: 'object',
    description:
      'The entity definition. With exclude_schema the export carries table_name alone; any other entry carries its fields and the required columns.',
    properties,
    required: ['table_name'],
    // A definition (one with fields) needs everything a create needs.
    if: { required: ['fields'] },
    // biome-ignore lint/suspicious/noThenProperty: "then" is the JSON Schema keyword, not a thenable
    then: { required: entity.required },
    additionalProperties: false,
  };
}

function listOf(row: Json, description: string): Json {
  return { type: 'array', description, items: row };
}

/** The whole schema of the transfer file, for the CLI version `generatedBy`. */
export function buildTransferSchema(generatedBy: string): Json {
  const permission = rowSchema(permissionSchema, PERMISSION_COLUMNS);
  const hierarchy = rowSchema(permission_hierarchySchema, HIERARCHY_COLUMNS);
  const role = rowSchema(roleSchema, ROLE_COLUMNS, {
    createOnly: ROLE_CREATE_ONLY,
  });

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: `Generated by semantius ${generatedBy} (generate_module_schema); transfer file version ${TRANSFER_VERSION}.`,
    title: 'Semantius transfer file',
    description: [
      'One JSON document written by export_entities / export_module and read by import_entities / import_module.',
      'Metadata is keyed by names, never by host ids: the module by module_name, roles by slug, permissions by permission_name.',
      'This schema describes what this CLI writes and reads. A column outside it is dropped by the import (so it is flagged here); it says nothing about what a given host accepts.',
      'Layout: the CLI writes metadata pretty-printed and each record as one compact line inside its entity\'s "records" block, which lets the import stream a large file. A file reformatted by hand still imports, but is parsed whole.',
    ].join(' '),
    type: 'object',
    properties: {
      $schema: {
        type: 'string',
        description:
          'Optional: point an editor at this schema. The import ignores it.',
      },
      version: {
        type: 'integer',
        const: TRANSFER_VERSION,
        description: `Format version; this CLI reads ${TRANSFER_VERSION} only.`,
      },
      module: moduleSection(),
      permissions: listOf(
        permission.schema,
        "The module's permissions (module file only).",
      ),
      permission_hierarchy: listOf(
        hierarchy.schema,
        "Hierarchy rows that touch the module's permissions, from either side; the other side must exist on the target (module file only).",
      ),
      roles: listOf(role.schema, "The module's roles (module file only)."),
      role_permissions: listOf(
        {
          type: 'object',
          description: 'A role holding a permission, both by name.',
          properties: {
            role_slug: text('slug of a role in this file'),
            permission_name: text('permission_name of the permission granted'),
          },
          required: ['role_slug', 'permission_name'],
          additionalProperties: false,
        },
        'Grants of the roles above (module file only).',
      ),
      entities: {
        type: 'array',
        description: 'The entities, sorted by table_name.',
        items: {
          type: 'object',
          properties: {
            entity: entitySection(),
            records: {
              type: 'array',
              description:
                'The records, absent from an export made with exclude_data. The id column is included. Each key is a field_name of the entity; a reference to a user is {"external_id": "..."}, any other reference the id of the referenced row. A file written by hand may name a record of an entity with a TypeID key "<prefix>_sr<n>" (cand_sr1), in its id and in the references to it; the import writes its TypeID, and an export never writes that short form.',
              items: { type: 'object' },
            },
          },
          required: ['entity'],
          additionalProperties: false,
        },
      },
    },
    required: ['version', 'entities'],
    additionalProperties: false,
  };
}

/** Writes the schema to `path` (relative to cwd), replacing any file there. */
export async function writeTransferSchema(
  path: string,
  generatedBy: string,
): Promise<{ path: string; bytes: number }> {
  const target = resolve(path);
  const body = `${JSON.stringify(buildTransferSchema(generatedBy), null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, body);
  return { path: target, bytes: Buffer.byteLength(body) };
}
