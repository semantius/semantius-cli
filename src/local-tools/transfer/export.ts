/**
 * export_entities / export_module: the metadata and the records of entities,
 * or of a whole module, into one transfer file (see format.ts).
 *
 * All the metadata is read up front; then the file is written, the records
 * of each table streamed page by page in id order. User references are
 * written as {"external_id": …}, since a user's numeric id differs from host
 * to host.
 */

import { resolve } from 'node:path';
import {
  ENTITY_COLUMNS,
  FIELD_COLUMNS,
  HIERARCHY_COLUMNS,
  MODULE_COLUMNS,
  MODULE_ROLE_COLUMNS,
  PERMISSION_COLUMNS,
  ROLE_COLUMNS,
  type Row,
  SYSTEM_TABLES,
  type TransferContext,
  TransferWriter,
  byKeys,
  pick,
} from './format.js';
import { eq } from './postgrest.js';

const RECORD_PAGE_SIZE = 5000;

export interface ExportEntitiesArgs {
  names: string;
  exclude_schema?: boolean;
  exclude_data?: boolean;
  path: string;
}

export interface ExportModuleArgs {
  name: string;
  exclude_data?: boolean;
  path: string;
}

export interface ExportResult {
  path: string;
  entities: Array<{ table_name: string; fields?: number; records?: number }>;
}

export async function exportEntities(
  ctx: TransferContext,
  args: ExportEntitiesArgs,
): Promise<ExportResult> {
  if (args.exclude_schema && args.exclude_data) {
    throw new Error(
      'exclude_schema and exclude_data are both set: the export would be empty',
    );
  }
  const names = [
    ...new Set(
      args.names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
  if (!names.length) throw new Error('names lists no table');
  refuseSystemTables(names);

  const rows = await ctx.pg.readIn('entities', 'table_name', names, {
    key: 'table_name',
  });
  const found = new Map(rows.map((e) => [e.table_name as string, e]));
  const unknown = names.filter((n) => !found.has(n));
  if (unknown.length) {
    throw new Error(`unknown entities: ${unknown.join(', ')}`);
  }
  return writeExport(
    ctx,
    args.path,
    {},
    names.map((n) => found.get(n) as Row),
    { schema: !args.exclude_schema, data: !args.exclude_data },
  );
}

export async function exportModule(
  ctx: TransferContext,
  args: ExportModuleArgs,
): Promise<ExportResult> {
  const { pg } = ctx;
  const [module] = await pg.readAll('modules', {
    filters: [eq('module_name', args.name)],
    key: 'id',
    expected: 1,
  });
  if (!module) throw new Error(`unknown module: ${args.name}`);
  const moduleId = module.id;

  const permissions = (
    await pg.readAll('permissions', {
      filters: [eq('module_id', moduleId)],
      key: 'permission_name',
    })
  ).sort(byKeys('permission_name'));
  const permissionNames = permissions.map((p) => p.permission_name);

  // The rows that touch the module's permissions, from either side.
  const hierarchy = new Map<unknown, Row>();
  for (const side of [
    'including_permission_name',
    'included_permission_name',
  ]) {
    for (const row of await pg.readIn(
      'permission_hierarchy',
      side,
      permissionNames,
      { key: 'id', unique: false },
    )) {
      hierarchy.set(row.id, row);
    }
  }

  const roles = (
    await pg.readAll('roles', {
      filters: [eq('module_id', moduleId)],
      key: 'id',
    })
  ).sort(byKeys('slug'));
  const slugOf = new Map(roles.map((r) => [r.id, r.slug as string]));
  const grants = await pg.readIn(
    'role_permissions',
    'role_id',
    roles.map((r) => r.id),
    { key: 'id', unique: false },
  );

  // Default roles may belong to another module.
  const defaultRoleIds = Object.keys(MODULE_ROLE_COLUMNS)
    .map((c) => module[c])
    .filter((id) => id !== null && id !== undefined && !slugOf.has(id));
  for (const role of await pg.readIn('roles', 'id', defaultRoleIds, {
    key: 'id',
  })) {
    slugOf.set(role.id, role.slug as string);
  }

  const moduleDoc: Row = {};
  for (const column of MODULE_COLUMNS) {
    const idColumn = Object.keys(MODULE_ROLE_COLUMNS).find(
      (c) => MODULE_ROLE_COLUMNS[c] === column,
    );
    if (!idColumn) {
      if (module[column] !== undefined) moduleDoc[column] = module[column];
      continue;
    }
    const roleId = module[idColumn];
    if (roleId === undefined) continue;
    if (roleId !== null && !slugOf.has(roleId)) {
      throw new Error(
        `module ${args.name}: ${idColumn} ${roleId} names no role this user can read`,
      );
    }
    moduleDoc[column] = roleId === null ? null : slugOf.get(roleId);
  }

  const head: Row = {
    module: moduleDoc,
    permissions: permissions.map((p) => pick(p, PERMISSION_COLUMNS)),
    permission_hierarchy: [...hierarchy.values()]
      .map((h) => pick(h, HIERARCHY_COLUMNS))
      .sort(byKeys('including_permission_name', 'included_permission_name')),
    roles: roles.map((r) => pick(r, ROLE_COLUMNS)),
    role_permissions: grants
      .map((g) => ({
        role_slug: slugOf.get(g.role_id),
        permission_name: g.permission_name,
      }))
      .sort(byKeys('role_slug', 'permission_name')),
  };

  const entities = (
    await pg.readAll('entities', {
      filters: [eq('module_id', moduleId)],
      key: 'table_name',
    })
  ).sort(byKeys('table_name'));
  refuseSystemTables(entities.map((e) => e.table_name as string));
  return writeExport(ctx, args.path, head, entities, {
    schema: true,
    data: !args.exclude_data,
  });
}

function refuseSystemTables(names: readonly string[]): void {
  const refused = names.filter((n) => SYSTEM_TABLES.has(n));
  if (refused.length) {
    throw new Error(
      `${refused.join(', ')}: metadata and system tables cannot be exported, their records would carry host ids`,
    );
  }
}

/** The shared part of both exports: entities, fields and records. */
async function writeExport(
  ctx: TransferContext,
  path: string,
  head: Row,
  entities: Row[],
  include: { schema: boolean; data: boolean },
): Promise<ExportResult> {
  const { pg } = ctx;
  const tables = entities.map((e) => e.table_name as string);

  const fieldsOf = new Map<string, Row[]>(tables.map((t) => [t, []]));
  for (const field of await pg.readIn('fields', 'table_name', tables, {
    key: 'id',
    unique: false,
  })) {
    fieldsOf.get(field.table_name as string)?.push(field);
  }
  for (const fields of fieldsOf.values()) {
    fields.sort(byKeys('field_order', 'field_name'));
  }

  const moduleNames = new Map<unknown, string>();
  if (include.schema) {
    const ids = entities.map((e) => e.module_id);
    for (const m of await pg.readIn('modules', 'id', ids, {
      key: 'id',
      select: ['id', 'module_name'],
    })) {
      moduleNames.set(m.id, m.module_name as string);
    }
  }

  const userColumns = new Map<string, string[]>(
    tables.map((t) => [
      t,
      (fieldsOf.get(t) ?? [])
        .filter((f) => f.reference_table === 'users')
        .map((f) => f.field_name as string),
    ]),
  );
  let externalIds: Map<unknown, string> | undefined;
  if (include.data && [...userColumns.values()].some((c) => c.length)) {
    externalIds = new Map();
    for (const user of await pg.readAll('users', {
      select: ['id', 'external_id'],
      key: 'id',
    })) {
      externalIds.set(user.id, user.external_id as string);
    }
  }

  const writer = await TransferWriter.open(resolve(path));
  const summary: ExportResult['entities'] = [];
  try {
    writer.head(head);
    for (const entity of entities) {
      const table = entity.table_name as string;
      const fields = fieldsOf.get(table) ?? [];
      writer.entity(
        include.schema
          ? entityDoc(entity, moduleNames, fields)
          : { table_name: table },
        include.data,
      );
      const line: ExportResult['entities'][number] = { table_name: table };
      if (include.schema) line.fields = fields.length;
      if (include.data) {
        line.records = await writeRecords(
          ctx,
          writer,
          entity,
          fields,
          userColumns.get(table) ?? [],
          externalIds,
        );
      }
      writer.endEntity();
      summary.push(line);
    }
    await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
  return { path: writer.path, entities: summary };
}

function entityDoc(
  entity: Row,
  moduleNames: Map<unknown, string>,
  fields: Row[],
): Row {
  const doc: Row = {};
  for (const column of ENTITY_COLUMNS) {
    if (column === 'module_name') {
      const name = moduleNames.get(entity.module_id);
      if (name === undefined) {
        throw new Error(
          `entity ${entity.table_name}: its module ${entity.module_id} cannot be read`,
        );
      }
      doc.module_name = name;
    } else if (entity[column] !== undefined) {
      doc[column] = entity[column];
    }
  }
  doc.fields = fields.map((f) => pick(f, FIELD_COLUMNS));
  return doc;
}

/** Stream one table's records into the file; returns how many. */
async function writeRecords(
  ctx: TransferContext,
  writer: TransferWriter,
  entity: Row,
  fields: Row[],
  userColumns: string[],
  externalIds: Map<unknown, string> | undefined,
): Promise<number> {
  const table = entity.table_name as string;
  const idColumn = (entity.id_column as string) || 'id';
  const columns = [
    idColumn,
    ...fields.map((f) => f.field_name as string).filter((c) => c !== idColumn),
  ];
  let count = 0;
  for await (const page of ctx.pg.pages(table, {
    select: columns,
    key: idColumn,
    pageSize: RECORD_PAGE_SIZE,
  })) {
    if (userColumns.length) {
      for (const row of page) {
        for (const column of userColumns) {
          const id = row[column];
          if (id === null || id === undefined) continue;
          const externalId = externalIds?.get(id);
          if (externalId === undefined || externalId === null) {
            throw new Error(
              `${table}.${column}: user ${id} is not among the users this user can read`,
            );
          }
          row[column] = { external_id: externalId };
        }
      }
    }
    await writer.records(page);
    count += page.length;
    ctx.progress(`${table}: ${count} records exported`);
  }
  return count;
}
