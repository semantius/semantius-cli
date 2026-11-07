/**
 * Tests for generate_module_schema (src/local-tools/transfer/schema.ts): the
 * JSON Schema of the transfer file. What the real exporters write is checked
 * against it in transfer.test.ts, beside the fake host that produces it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Ajv from 'ajv';
import { version as VERSION } from '../package.json' with { type: 'json' };
import { createBuiltinConnection } from '../src/local-tools/connection';
import {
  ENTITY_COLUMNS,
  FIELD_COLUMNS,
  HIERARCHY_COLUMNS,
  MODULE_COLUMNS,
  PERMISSION_COLUMNS,
  ROLE_COLUMNS,
  TRANSFER_VERSION,
} from '../src/local-tools/transfer/format';
import {
  DEFAULT_SCHEMA_PATH,
  buildTransferSchema,
} from '../src/local-tools/transfer/schema';

const schema = buildTransferSchema('test') as any;
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

/** Where the validator complained, e.g. "/entities/0/entity/fields/0 must NOT …". */
const problems = () =>
  (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('\n');

function accepts(doc: unknown): void {
  if (!validate(doc)) throw new Error(`rejected:\n${problems()}`);
}

function rejects(doc: unknown, containing: string): void {
  expect(validate(doc)).toBe(false);
  expect(problems()).toContain(containing);
}

const FIELD = { field_name: 'name', title: 'Name' };
const ENTITY = {
  table_name: 'accounts',
  module_name: 'CRM',
  fields: [FIELD],
};
const file = (overrides: Record<string, unknown> = {}) => ({
  version: TRANSFER_VERSION,
  entities: [{ entity: ENTITY }],
  ...overrides,
});

const entityEntry = schema.properties.entities.items.properties.entity;
const props = (s: any) => Object.keys(s.properties);

describe('the generated schema', () => {
  test('its properties are the column lists the exporter writes: no second list', () => {
    expect(props(schema.properties.module)).toEqual(MODULE_COLUMNS);
    expect(props(entityEntry)).toEqual([...ENTITY_COLUMNS, 'fields']);
    expect(props(entityEntry.properties.fields.items)).toEqual(FIELD_COLUMNS);
    expect(props(schema.properties.permissions.items)).toEqual(
      PERMISSION_COLUMNS,
    );
    expect(props(schema.properties.permission_hierarchy.items)).toEqual(
      HIERARCHY_COLUMNS,
    );
    expect(props(schema.properties.roles.items)).toEqual(ROLE_COLUMNS);
    expect(props(schema.properties.role_permissions.items)).toEqual([
      'role_slug',
      'permission_name',
    ]);
  });

  test('it is draft-07, names the CLI version, and pins the format version', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$comment).toContain('semantius test');
    expect(schema.properties.version.const).toBe(TRANSFER_VERSION);
    expect(schema.required).toEqual(['version', 'entities']);
  });

  test('descriptions come through, without zod\'s safe-integer bounds', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toContain('9007199254740991');
    expect(entityEntry.properties.module_name.description).toContain('module');
    expect(
      entityEntry.properties.fields.items.properties.format.description,
    ).toContain('JSON Schema format');
  });

  test('create-only and read-only columns say so', () => {
    const fields = entityEntry.properties.fields.items.properties;
    expect(schema.properties.module.properties.module_type.description).toContain(
      'Create-only',
    );
    expect(entityEntry.properties.id_type.description).toContain('Create-only');
    expect(fields.catalog_field_code.description).toContain('Create-only');
    expect(fields.ctype.readOnly).toBe(true);
    expect(fields.ctype.description).toContain('Read-only');
    expect(schema.properties.roles.items.properties.slug.description).toContain(
      'Create-only',
    );
  });
});

describe('accepts what the exporters write', () => {
  test('the smallest file', () => {
    accepts({ version: 1, entities: [] });
  });

  test('a data-only entry (exclude_schema): table_name and records', () => {
    accepts(
      file({
        entities: [
          { entity: { table_name: 'accounts' }, records: [{ id: 1, name: 'a' }] },
        ],
      }),
    );
  });

  test('a schema-only entry (exclude_data): no records block', () => {
    accepts(file());
  });

  test('a module file with every section', () => {
    accepts(
      file({
        module: {
          module_name: 'CRM',
          module_type: 'domain',
          default_viewer_role_slug: 'crm_viewer',
        },
        permissions: [{ permission_name: 'crm:read' }],
        permission_hierarchy: [
          {
            including_permission_name: 'crm:manage',
            included_permission_name: 'crm:read',
          },
        ],
        roles: [{ role_name: 'Viewer', slug: 'crm_viewer' }],
        role_permissions: [
          { role_slug: 'crm_viewer', permission_name: 'crm:read' },
        ],
      }),
    );
  });

  test('null in every optional column: PostgREST returns null for an unset one', () => {
    accepts(
      file({
        module: {
          module_name: 'CRM',
          description: null,
          logo_color: null,
          settings: null,
          default_viewer_role_slug: null,
          default_manager_role_slug: null,
          default_admin_role_slug: null,
        },
        entities: [
          {
            entity: {
              ...ENTITY,
              description: null,
              icon_name: null,
              id_prefix: null,
              label_column: null,
              computed_fields: null,
              validation_rules: null,
              select_rule: null,
              fields: [
                {
                  ...FIELD,
                  description: null,
                  format: null,
                  default_value: null,
                  enum_values: null,
                  reference_table: null,
                  rollup: null,
                  precision: null,
                },
              ],
            },
            records: [],
          },
        ],
      }),
    );
  });

  test('an editor "$schema" key', () => {
    accepts(file({ $schema: './semantius-transfer.schema.json' }));
  });
});

describe('rejects what the import would drop or refuse', () => {
  test('another format version, or no entities', () => {
    rejects(file({ version: 2 }), '/version');
    rejects({ version: 1 }, "required property 'entities'");
    rejects({ entities: [] }, "required property 'version'");
  });

  test('a column no list names, anywhere in the file', () => {
    const fieldWithTypo = { ...FIELD, descripion: 'x' };
    rejects(
      file({ entities: [{ entity: { ...ENTITY, fields: [fieldWithTypo] } }] }),
      'must NOT have additional properties',
    );
    rejects(file({ extra: 1 }), 'must NOT have additional properties');
    rejects(
      file({ roles: [{ role_name: 'R', slug: 'r', id: 5 }] }),
      '/roles/0 must NOT have additional properties',
    );
  });

  test('a host id where the file carries a name', () => {
    rejects(
      file({ entities: [{ entity: { ...ENTITY, module_id: 3 } }] }),
      'must NOT have additional properties',
    );
    rejects(
      file({ module: { module_name: 'CRM', default_viewer_role_id: 7 } }),
      '/module must NOT have additional properties',
    );
  });

  test('an entity definition without its module_name, but not a data-only entry', () => {
    rejects(
      file({
        entities: [{ entity: { table_name: 'accounts', fields: [FIELD] } }],
      }),
      "required property 'module_name'",
    );
    accepts(file({ entities: [{ entity: { table_name: 'accounts' } }] }));
  });

  test('a missing required column, or null in one', () => {
    rejects(
      file({
        entities: [
          { entity: { ...ENTITY, fields: [{ title: 'Name' }] } },
        ],
      }),
      "required property 'field_name'",
    );
    rejects(
      file({
        entities: [
          {
            entity: { ...ENTITY, fields: [{ field_name: null, title: 'Name' }] },
          },
        ],
      }),
      '/entities/0/entity/fields/0/field_name',
    );
    rejects(
      file({ role_permissions: [{ role_slug: 'viewer' }] }),
      "required property 'permission_name'",
    );
  });

  test('a value outside an enum', () => {
    rejects(
      file({
        entities: [
          {
            entity: { ...ENTITY, fields: [{ ...FIELD, width: 'huge' }] },
          },
        ],
      }),
      '/entities/0/entity/fields/0/width',
    );
    rejects(
      file({ module: { module_name: 'CRM', module_type: 'galaxy' } }),
      '/module/module_type',
    );
  });
});

describe('the generate_module_schema tool', () => {
  let dir: string;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'semantius-transfer-schema-'));
    realFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  /** Calls the tool in-process, with the network closed: it needs no host. */
  async function generate(args: Record<string, unknown>) {
    globalThis.fetch = (() => {
      throw new Error('generate_module_schema must not touch the network');
    }) as unknown as typeof fetch;
    const conn = await createBuiltinConnection('utils', { builtin: true });
    try {
      return (await conn.callTool('generate_module_schema', args)) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
    } finally {
      await conn.close();
    }
  }

  const textOf = (r: { content: Array<{ text?: string }> }) =>
    r.content.map((c) => c.text ?? '').join('\n');

  test('is listed with an optional path', async () => {
    const conn = await createBuiltinConnection('utils', { builtin: true });
    try {
      const tool = (await conn.listTools()).find(
        (t) => t.name === 'generate_module_schema',
      );
      expect(tool?.description).toContain('JSON Schema');
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['path']);
      expect(tool?.inputSchema.required ?? []).not.toContain('path');
    } finally {
      await conn.close();
    }
  });

  test('writes the schema to path and returns where and how big', async () => {
    const path = join(dir, 'transfer.schema.json');
    const result = await generate({ path });
    expect(result.isError).toBeFalsy();

    const written = JSON.parse(textOf(result));
    expect(written.path).toBe(path);
    const body = await readFile(path, 'utf8');
    expect(written.bytes).toBe(Buffer.byteLength(body));
    expect(body.endsWith('}\n')).toBe(true);
    expect(body).not.toContain('\r');
    expect(JSON.parse(body)).toEqual(
      JSON.parse(JSON.stringify(buildTransferSchema(VERSION))),
    );
  });

  test('a relative path, in directories that do not exist yet', async () => {
    const path = join(dir, 'a', 'b', 'schema.json');
    const result = await generate({ path: relative(process.cwd(), path) });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(await readFile(path, 'utf8')).title).toBe(
      'Semantius transfer file',
    );
  });

  test('replaces a file already there', async () => {
    const path = join(dir, 'schema.json');
    await writeFile(path, 'old');
    await generate({ path });
    expect(JSON.parse(await readFile(path, 'utf8')).$schema).toContain(
      'json-schema.org',
    );
  });

  test(`without a path it writes ${DEFAULT_SCHEMA_PATH} in the current directory`, async () => {
    const before = process.cwd();
    process.chdir(dir);
    try {
      const result = await generate({});
      expect(result.isError).toBeFalsy();
    } finally {
      process.chdir(before);
    }
    expect(await Bun.file(join(dir, DEFAULT_SCHEMA_PATH)).exists()).toBe(true);
  });

  test('a path it cannot write is an error result, not a throw', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'a file where a directory is needed');
    const result = await generate({ path: join(blocker, 'schema.json') });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: /);
  });
});
