/**
 * import_entities / import_module: replay a transfer file onto the host as an
 * upsert.
 *
 * Every step reads the target first and writes only what differs, so an
 * import is idempotent: a re-run after a failure resumes cheaply, and a
 * re-import of unchanged data sends no write at all.
 *
 *   1. module, permissions, hierarchy, roles, grants (import_module only);
 *   2. schema: entities, fields, then the entity columns that name fields
 *      (validation rules and select_rule among them, so every record is
 *      written under the rules, on a first import as on a re-import);
 *   3. the schema cache, when the schema changed on a cloud host;
 *   4. records, table by table in foreign-key order, keyed on the id column;
 *      fix_id_sequence after each table.
 *
 * Metadata is matched by name, never by host id, and never written with
 * ON CONFLICT: an upsert would put create-only columns (origin, slug,
 * catalog_*) into its SET list and fire their triggers.
 */

import { resolve } from 'node:path';
import { bulkInsertOptions } from '../../vendor/postgrest-mcp/src/utils/bulk.js';
import { resetSchemaCache } from '../../vendor/postgrest-mcp/src/utils/resetSchemaCache.js';
import { buildToolContext, setCurrentContext } from '../crud/context.js';
import {
  CORE_FIELD_FIXED,
  ENTITY_COLUMNS,
  ENTITY_CREATE_ONLY,
  ENTITY_DEFERRED,
  FIELD_COLUMNS,
  FIELD_CREATE_ONLY,
  FIELD_READ_ONLY,
  HIERARCHY_COLUMNS,
  MODULE_COLUMNS,
  MODULE_CREATE_ONLY,
  MODULE_DEFERRED,
  MODULE_PERMISSION_COLUMNS,
  MODULE_ROLE_COLUMNS,
  PERMISSION_COLUMNS,
  ROLE_COLUMNS,
  ROLE_CREATE_ONLY,
  type Row,
  type TransferContext,
  type TransferDoc,
  type TransferFile,
  omit,
  pick,
  readTransferFile,
} from './format.js';
import { type Reference, SelfReferences, planWrites } from './graph.js';
import {
  type PostgrestClient,
  PostgrestError,
  columnList,
  eq,
} from './postgrest.js';

const INSERT_CHUNK = 100;
const BATCH_ROWS = 2000;
const BATCH_BYTES = 1_000_000;
const IN_FLIGHT = 4;

type Status = 'created' | 'updated' | 'unchanged';

export interface Counts {
  created: number;
  updated: number;
  unchanged: number;
}

export interface InsertCounts {
  created: number;
  unchanged: number;
}

export interface EntityResult {
  table_name: string;
  entity?: Status;
  fields?: Counts;
  records?: { written: number; unchanged: number; rewritten?: number };
  sequence_next?: number | null;
}

export interface ImportResult {
  module?: Status;
  permissions?: Counts;
  permission_hierarchy?: InsertCounts;
  roles?: Counts;
  role_permissions?: InsertCounts;
  entities: EntityResult[];
}

export async function importTransfer(
  ctx: TransferContext,
  args: { path: string },
  kind: 'entities' | 'module',
): Promise<ImportResult> {
  const path = resolve(args.path);
  const file = await readTransferFile(path);
  const { doc } = file;
  if (kind === 'module' && !doc.module) {
    throw new Error(
      `${path} carries no module; import it with import_entities`,
    );
  }

  const moduleResult = kind === 'module' ? await importModule(ctx, doc) : {};
  const outcomes = new Map<string, EntityResult>(
    doc.entities.map((e) => [
      e.entity.table_name,
      { table_name: e.entity.table_name },
    ]),
  );
  const result: ImportResult = {
    ...moduleResult,
    entities: [...outcomes.values()],
  };

  const schemaChanged = await importSchema(ctx, doc, outcomes);
  const cache = schemaCacheRefresher(ctx);
  if (schemaChanged) await cache.refresh();
  ctx.pg.onSchemaMiss = cache.refreshOnce;

  await importRecords(ctx, file, outcomes);
  return result;
}

// ------------------------------------------------------------------ helpers

/** The columns of `wanted` that differ from `current`, or undefined. */
function changes(
  wanted: Row,
  current: Row,
  columns: readonly string[],
): Row | undefined {
  const out: Row = {};
  for (const column of columns) {
    if (wanted[column] === undefined) continue;
    // A column the target does not have (an older platform) is left alone.
    if (!(column in current)) continue;
    if (!Bun.deepEquals(wanted[column], current[column])) {
      out[column] = wanted[column];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Bulk inserts, INSERT_CHUNK rows per request; returns the created rows. */
async function insertRows(
  pg: PostgrestClient,
  table: string,
  rows: Row[],
  select?: string,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { path, additionalHeaders } = bulkInsertOptions(`/${table}`, chunk);
    const url = select
      ? `${path}${path.includes('?') ? '&' : '?'}select=${select}`
      : path;
    const created = await pg.request('POST', url, {
      body: chunk,
      prefer: additionalHeaders?.prefer,
      retry: 'insert',
    });
    if (Array.isArray(created)) out.push(...(created as Row[]));
  }
  return out;
}

async function patch(
  pg: PostgrestClient,
  table: string,
  filters: string[],
  change: Row,
): Promise<void> {
  await pg.request('PATCH', `/${table}?${filters.join('&')}`, {
    body: change,
    prefer: 'return=minimal',
  });
}

function indexBy(rows: Row[], ...keys: string[]): Map<string, Row> {
  return new Map(
    rows.map((r) => [keys.map((k) => String(r[k])).join('\n'), r]),
  );
}

/** Prefix a failure with what the import was doing. */
function withContext<T>(what: string, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    throw error instanceof PostgrestError
      ? new PostgrestError(message, error.status, error.code)
      : new Error(message);
  });
}

/**
 * The id of the user who imports: granted_by of the grants it inserts.
 * get_userinfo answers {user_id, external_id, email, …}.
 */
async function importingUserId(pg: PostgrestClient): Promise<number> {
  const info = await pg.rpc('get_userinfo', {});
  const user = (Array.isArray(info) ? info[0] : info) as Row | undefined;
  const id = user?.user_id;
  if (typeof id !== 'number') {
    throw new Error('get_userinfo returned no user_id');
  }
  return id;
}

// ------------------------------------------------------------------ module

async function importModule(
  ctx: TransferContext,
  doc: TransferDoc,
): Promise<Omit<ImportResult, 'entities'>> {
  const { pg } = ctx;
  const file = doc.module as Row;
  const name = file.module_name;
  if (typeof name !== 'string' || !name) {
    throw new Error('the module in the file has no module_name');
  }
  ctx.progress(`module ${name}`);

  // 1. The module, without the columns that name permissions and roles.
  const base = omit(file, MODULE_DEFERRED);
  let [target] = await pg.readAll('modules', {
    filters: [eq('module_name', name)],
    key: 'id',
    expected: 1,
  });
  let status: Status;
  if (!target) {
    [target] = await withContext(`creating module ${name}`, () =>
      insertRows(pg, 'modules', [base]),
    );
    if (!target) throw new Error(`creating module ${name} returned no row`);
    status = 'created';
  } else {
    const change = changes(
      base,
      target,
      MODULE_COLUMNS.filter(
        (c) => c !== 'module_name' && !MODULE_CREATE_ONLY.includes(c),
      ),
    );
    if (change) {
      await withContext(`updating module ${name}`, () =>
        patch(pg, 'modules', [eq('id', target.id)], change),
      );
    }
    status = change ? 'updated' : 'unchanged';
  }
  const moduleId = target.id;

  // 2. Permissions.
  const permissions: Counts = { created: 0, updated: 0, unchanged: 0 };
  const filePermissions = doc.permissions ?? [];
  const targetPermissions = indexBy(
    await pg.readIn(
      'permissions',
      'permission_name',
      filePermissions.map((p) => p.permission_name),
      { key: 'permission_name' },
    ),
    'permission_name',
  );
  const newPermissions: Row[] = [];
  for (const p of filePermissions) {
    const current = targetPermissions.get(String(p.permission_name));
    if (!current) {
      newPermissions.push({
        ...pick(p, PERMISSION_COLUMNS),
        module_id: moduleId,
      });
      continue;
    }
    const change = changes(
      p,
      current,
      PERMISSION_COLUMNS.filter((c) => c !== 'permission_name'),
    );
    if (change) {
      await withContext(`updating permission ${p.permission_name}`, () =>
        patch(
          pg,
          'permissions',
          [eq('permission_name', p.permission_name)],
          change,
        ),
      );
      permissions.updated++;
    } else {
      permissions.unchanged++;
    }
  }
  await withContext('creating permissions', () =>
    insertRows(pg, 'permissions', newPermissions),
  );
  permissions.created = newPermissions.length;

  // 3. Hierarchy: missing rows are inserted, never updated (origin is immutable).
  const fileHierarchy = doc.permission_hierarchy ?? [];
  const targetHierarchy = indexBy(
    await pg.readIn(
      'permission_hierarchy',
      'including_permission_name',
      fileHierarchy.map((h) => h.including_permission_name),
      { key: 'id', unique: false },
    ),
    'including_permission_name',
    'included_permission_name',
  );
  const newHierarchy = fileHierarchy
    .filter(
      (h) =>
        !targetHierarchy.has(
          `${h.including_permission_name}\n${h.included_permission_name}`,
        ),
    )
    .map((h) => pick(h, HIERARCHY_COLUMNS));
  await withContext('creating permission_hierarchy rows', () =>
    insertRows(pg, 'permission_hierarchy', newHierarchy),
  );

  // 4. Roles, by slug.
  const roles: Counts = { created: 0, updated: 0, unchanged: 0 };
  const fileRoles = doc.roles ?? [];
  const roleIds = new Map<string, unknown>();
  const targetRoles = indexBy(
    await pg.readIn(
      'roles',
      'slug',
      fileRoles.map((r) => r.slug),
      {
        key: 'id',
        unique: false,
      },
    ),
    'slug',
  );
  const newRoles: Row[] = [];
  for (const r of fileRoles) {
    const current = targetRoles.get(String(r.slug));
    if (!current) {
      newRoles.push({ ...pick(r, ROLE_COLUMNS), module_id: moduleId });
      continue;
    }
    roleIds.set(String(r.slug), current.id);
    const change = changes(
      r,
      current,
      ROLE_COLUMNS.filter((c) => !ROLE_CREATE_ONLY.includes(c)),
    );
    if (change) {
      await withContext(`updating role ${r.slug}`, () =>
        patch(pg, 'roles', [eq('id', current.id)], change),
      );
      roles.updated++;
    } else {
      roles.unchanged++;
    }
  }
  for (const created of await withContext('creating roles', () =>
    insertRows(pg, 'roles', newRoles, 'id,slug'),
  )) {
    roleIds.set(String(created.slug), created.id);
  }
  roles.created = newRoles.length;

  // Grants and default roles may name roles of other modules.
  const fileGrants = doc.role_permissions ?? [];
  const wantedSlugs = [
    ...fileGrants.map((g) => g.role_slug),
    ...Object.values(MODULE_ROLE_COLUMNS).map((c) => file[c]),
  ].filter((s): s is string => typeof s === 'string' && !roleIds.has(s));
  for (const role of await pg.readIn('roles', 'slug', wantedSlugs, {
    key: 'id',
    unique: false,
  })) {
    roleIds.set(String(role.slug), role.id);
  }
  const roleId = (slug: unknown, what: string) => {
    const id = roleIds.get(String(slug));
    if (id === undefined) {
      throw new Error(`${what}: no role with slug ${slug} on the target`);
    }
    return id;
  };

  // 5. Grants: missing ones are inserted, granted by the user who imports.
  const grantRows = fileGrants.map((g) => ({
    role_id: roleId(g.role_slug, `grant of ${g.permission_name}`),
    permission_name: g.permission_name,
  }));
  const targetGrants = indexBy(
    await pg.readIn(
      'role_permissions',
      'role_id',
      grantRows.map((g) => g.role_id),
      { key: 'id', unique: false },
    ),
    'role_id',
    'permission_name',
  );
  const newGrants = grantRows.filter(
    (g) => !targetGrants.has(`${g.role_id}\n${g.permission_name}`),
  );
  if (newGrants.length) {
    const grantedBy = await importingUserId(pg);
    await withContext('creating role_permissions', () =>
      insertRows(
        pg,
        'role_permissions',
        newGrants.map((g) => ({ ...g, granted_by: grantedBy })),
      ),
    );
  }

  // 6. The module's permission and default-role columns.
  const deferred: Row = pick(file, MODULE_PERMISSION_COLUMNS);
  for (const [idColumn, slugColumn] of Object.entries(MODULE_ROLE_COLUMNS)) {
    if (!(slugColumn in file)) continue;
    const slug = file[slugColumn];
    deferred[idColumn] =
      slug === null ? null : roleId(slug, `module ${name}: ${slugColumn}`);
  }
  const [current] = await pg.readAll('modules', {
    filters: [eq('id', moduleId)],
    key: 'id',
    expected: 1,
  });
  const change = current && changes(deferred, current, Object.keys(deferred));
  if (change) {
    await withContext(`updating module ${name}`, () =>
      patch(pg, 'modules', [eq('id', moduleId)], change),
    );
    if (status === 'unchanged') status = 'updated';
  }

  return {
    module: status,
    permissions,
    permission_hierarchy: {
      created: newHierarchy.length,
      unchanged: fileHierarchy.length - newHierarchy.length,
    },
    roles,
    role_permissions: {
      created: newGrants.length,
      unchanged: grantRows.length - newGrants.length,
    },
  };
}

// ------------------------------------------------------------------ schema

/** Entities with their schema in the file (not exported with exclude_schema). */
function schemaEntries(doc: TransferDoc) {
  return doc.entities
    .map((e) => e.entity)
    .filter((e): e is Row & { table_name: string; fields: Row[] } =>
      Array.isArray(e.fields),
    );
}

function markUpdated(outcome: EntityResult | undefined): void {
  if (outcome && outcome.entity === 'unchanged') outcome.entity = 'updated';
}

/** Entities, then fields, then the entity columns that name fields. */
async function importSchema(
  ctx: TransferContext,
  doc: TransferDoc,
  outcomes: Map<string, EntityResult>,
): Promise<boolean> {
  const { pg } = ctx;
  const names = doc.entities.map((e) => e.entity.table_name);
  const targetEntities = indexBy(
    await pg.readIn('entities', 'table_name', names, { key: 'table_name' }),
    'table_name',
  );
  const entities = schemaEntries(doc);
  const withSchema = new Set(entities.map((e) => e.table_name));
  const absent = names.filter(
    (n) => !withSchema.has(n) && !targetEntities.has(n),
  );
  if (absent.length) {
    throw new Error(
      `${absent.join(', ')}: not on the target, and the file carries no schema for them`,
    );
  }
  if (!entities.length) return false;
  ctx.progress('schema');

  const moduleNames = [...new Set(entities.map((e) => e.module_name))];
  for (const e of entities) {
    if (typeof e.module_name !== 'string') {
      throw new Error(`entity ${e.table_name} has no module_name`);
    }
  }
  const modules = indexBy(
    await pg.readIn('modules', 'module_name', moduleNames, {
      key: 'id',
      select: ['id', 'module_name'],
    }),
    'module_name',
  );
  const noModule = entities.filter((e) => !modules.has(String(e.module_name)));
  if (noModule.length) {
    const missing = noModule
      .map((e) => `module ${e.module_name} (of ${e.table_name})`)
      .join(', ');
    throw new Error(`${missing} not on the target`);
  }

  let changed = false;

  // 1. Entities.
  const writable = ENTITY_COLUMNS.filter(
    (c) => c !== 'module_name' && !ENTITY_DEFERRED.includes(c),
  );
  const updatable = writable.filter(
    (c) => c !== 'table_name' && !ENTITY_CREATE_ONLY.includes(c),
  );
  const newEntities: Row[] = [];
  for (const e of entities) {
    const row = {
      ...pick(e, writable),
      module_id: modules.get(String(e.module_name))?.id,
    };
    const outcome = outcomes.get(e.table_name) as EntityResult;
    const current = targetEntities.get(e.table_name);
    if (!current) {
      newEntities.push(row);
      outcome.entity = 'created';
      continue;
    }
    const change = changes(row, current, [...updatable, 'module_id']);
    if (change) {
      await withContext(`updating entity ${e.table_name}`, () =>
        patch(pg, 'entities', [eq('table_name', e.table_name)], change),
      );
      changed = true;
    }
    outcome.entity = change ? 'updated' : 'unchanged';
  }
  if (newEntities.length) {
    await withContext('creating entities', () =>
      insertRows(pg, 'entities', newEntities),
    );
    changed = true;
  }

  // 2. Fields. The platform creates the core fields with the entity, so
  //    they are only ever patched, and never in their fixed columns.
  const targetFields = indexBy(
    await pg.readIn('fields', 'table_name', [...withSchema], {
      key: 'id',
      unique: false,
    }),
    'table_name',
    'field_name',
  );
  const insertable = FIELD_COLUMNS.filter((c) => !FIELD_READ_ONLY.includes(c));
  const newFields: Row[] = [];
  for (const e of entities) {
    const counts: Counts = { created: 0, updated: 0, unchanged: 0 };
    (outcomes.get(e.table_name) as EntityResult).fields = counts;
    for (const f of e.fields) {
      const current = targetFields.get(`${e.table_name}\n${f.field_name}`);
      const core = Boolean(f.ctype) || Boolean(current?.ctype);
      if (!current) {
        if (core) continue;
        newFields.push({ table_name: e.table_name, ...pick(f, insertable) });
        counts.created++;
        continue;
      }
      const fixed = [
        'field_name',
        ...FIELD_READ_ONLY,
        ...FIELD_CREATE_ONLY,
        ...(core ? CORE_FIELD_FIXED : []),
      ];
      const change = changes(
        f,
        current,
        FIELD_COLUMNS.filter((c) => !fixed.includes(c)),
      );
      if (change) {
        await withContext(
          `updating field ${e.table_name}.${f.field_name}`,
          () =>
            patch(
              pg,
              'fields',
              [eq('table_name', e.table_name), eq('field_name', f.field_name)],
              change,
            ),
        );
        counts.updated++;
        changed = true;
      } else {
        counts.unchanged++;
      }
    }
  }
  if (newFields.length) {
    await withContext('creating fields', () =>
      insertRows(pg, 'fields', newFields),
    );
    changed = true;
  }

  // 3. The entity columns that name fields.
  const current = indexBy(
    await pg.readIn('entities', 'table_name', [...withSchema], {
      key: 'table_name',
    }),
    'table_name',
  );
  for (const e of entities) {
    const target = current.get(e.table_name);
    const change = target && changes(e, target, ENTITY_DEFERRED);
    if (!change) continue;
    await withContext(`updating entity ${e.table_name}`, () =>
      patch(pg, 'entities', [eq('table_name', e.table_name)], change),
    );
    markUpdated(outcomes.get(e.table_name));
    changed = true;
  }
  return changed;
}

/**
 * A cloud host's PostgREST cache does not see a new table or column until it
 * is told to reload (self-hosted reloads by itself). Refreshed once after the
 * schema changed, and at most once more when a write still meets a stale
 * cache (a re-run after a failure has no schema change to trigger it).
 */
function schemaCacheRefresher(ctx: TransferContext) {
  const { pg } = ctx;
  const refresh = async (): Promise<void> => {
    if (pg.host.mode !== 'cloud') return;
    ctx.progress('refreshing the schema cache');
    setCurrentContext(pg.host, buildToolContext(pg.host, pg.token));
    try {
      await resetSchemaCache('', pg.token);
    } catch {
      // The writes wait out a stale cache (schemaWait) and report it.
    }
  };
  let again: Promise<void> | undefined;
  return {
    refresh,
    refreshOnce: (): Promise<void> => {
      again ??= refresh();
      return again;
    },
  };
}

// ----------------------------------------------------------------- records

interface TableState {
  table: string;
  index: number;
  count: number;
  idColumn: string;
  /** Target catalog: field name → field. */
  catalog: Map<string, Row>;
  /** Audit and computed columns: the platform sets them. */
  skip: Set<string>;
  /** Columns written, from the first record. */
  columns?: string[];
  userColumns: string[];
  result: NonNullable<EntityResult['records']>;
  maxWritten?: number;
}

/**
 * A small pool: at most `limit` tasks at once, the first error wins. `settle`
 * waits for every task still running, so no batch is left writing after the
 * import has reported its error.
 */
class InFlight {
  private readonly running = new Set<Promise<void>>();
  private error: unknown;
  private failed = false;

  constructor(private readonly limit: number) {}

  async add(task: () => Promise<void>): Promise<void> {
    while (this.running.size >= this.limit) await Promise.race(this.running);
    this.check();
    const run: Promise<void> = task()
      .catch((error) => {
        if (!this.failed) {
          this.failed = true;
          this.error = error;
        }
      })
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  async settle(): Promise<void> {
    await Promise.all(this.running);
  }

  check(): void {
    if (this.failed) throw this.error;
  }
}

async function importRecords(
  ctx: TransferContext,
  file: TransferFile,
  outcomes: Map<string, EntityResult>,
): Promise<void> {
  const { pg } = ctx;
  const entries = file.doc.entities
    .map((e, index) => ({ table: e.entity.table_name, index }))
    .filter((e) => file.recordCount(e.index) > 0);
  if (!entries.length) return;
  const tables = entries.map((e) => e.table);

  // The target's catalog, after the schema step.
  const entities = indexBy(
    await pg.readIn('entities', 'table_name', tables, { key: 'table_name' }),
    'table_name',
  );
  const fieldsOf = new Map<string, Row[]>(tables.map((t) => [t, []]));
  for (const field of await pg.readIn('fields', 'table_name', tables, {
    key: 'id',
    unique: false,
  })) {
    fieldsOf.get(field.table_name as string)?.push(field);
  }

  const states = new Map<string, TableState>();
  const references: Reference[] = [];
  for (const { table, index } of entries) {
    const entity = entities.get(table);
    if (!entity) throw new Error(`${table} is not on the target`);
    const fields = fieldsOf.get(table) ?? [];
    const computed = Array.isArray(entity.computed_fields)
      ? (entity.computed_fields as Row[]).map((c) => c?.name)
      : [];
    const skip = new Set<string>([
      ...fields
        .filter((f) => f.ctype === 'audit')
        .map((f) => f.field_name as string),
      ...computed.filter((n): n is string => typeof n === 'string'),
    ]);
    const result = { written: 0, unchanged: 0 };
    (outcomes.get(table) as EntityResult).records = result;
    states.set(table, {
      table,
      index,
      count: file.recordCount(index),
      idColumn: (entity.id_column as string) || 'id',
      catalog: new Map(fields.map((f) => [f.field_name as string, f])),
      skip,
      userColumns: [],
      result,
    });
    for (const f of fields) {
      if (
        (f.format === 'reference' || f.format === 'parent') &&
        typeof f.reference_table === 'string' &&
        !skip.has(f.field_name as string)
      ) {
        references.push({
          table,
          column: f.field_name as string,
          target: f.reference_table,
          format: f.format,
        });
      }
    }
  }

  const plan = planWrites(tables, references);
  const writer = new RecordWriter(ctx, file, outcomes);
  for (const step of plan.steps) {
    const state = states.get(step.table) as TableState;
    const relink = await withContext(`records of ${step.table}`, () =>
      writer.writeTable(
        state,
        step.pass,
        plan.deferred.get(step.table) ?? [],
        step.pass === 1 ? (plan.selfReferences.get(step.table) ?? []) : [],
      ),
    );
    // A reference to a later row of the same table was written null: every
    // row exists now, so write them in full. A table in a cycle gets its
    // second pass from the plan anyway.
    const planned = plan.steps.some(
      (s) => s.table === step.table && s.pass === 2,
    );
    if (relink && !planned) {
      await withContext(`records of ${step.table}`, () =>
        writer.writeTable(state, 2, [], []),
      );
    }
  }
}

class RecordWriter {
  private users?: Promise<Map<string, unknown>>;
  private probe?: Promise<unknown>;

  constructor(
    private readonly ctx: TransferContext,
    private readonly file: TransferFile,
    private readonly outcomes: Map<string, EntityResult>,
  ) {}

  /**
   * One pass over a table's records. Returns whether a reference to a later
   * row of the same table was written null, so a second pass must follow.
   */
  async writeTable(
    state: TableState,
    pass: 1 | 2,
    deferred: readonly string[],
    selfReferences: readonly Reference[],
  ): Promise<boolean> {
    const self = selfReferences.length
      ? new SelfReferences(state.table, state.idColumn, selfReferences)
      : undefined;
    // Batches of a self-referencing table wait for each other: a later
    // batch may point at rows of an earlier one.
    const flight = new InFlight(self ? 1 : IN_FLIGHT);
    const count = pass === 1 ? 'first' : 'second';
    let columns: string[] | undefined;
    let batch: Row[] = [];
    let bytes = 0;
    const flush = async () => {
      const rows = batch;
      batch = [];
      bytes = 0;
      if (rows.length) {
        await flight.add(() =>
          this.writeBatch(state, rows, columns as string[], count, self),
        );
      }
    };

    try {
      for await (const line of this.file.records(state.index)) {
        const row = await this.prepare(state, line.row);
        columns ??= (state.columns as string[]).filter(
          (c) => pass === 2 || !deferred.includes(c),
        );
        batch.push(row);
        bytes += line.bytes;
        if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
      }
      await flush();
    } finally {
      await flight.settle();
    }
    flight.check();

    // Rows held back for a parent later in the file: every other row exists now.
    if (self?.size && columns) {
      for (const chunk of self.drain(BATCH_ROWS)) {
        await this.upsert(state, chunk, columns);
      }
    }

    if (pass === 1 && state.maxWritten !== undefined) {
      const next = await this.fixSequence(state.table);
      if (typeof next === 'number' && next <= state.maxWritten) {
        throw new Error(
          `fix_id_sequence left the id sequence at ${next}, not past the highest id written, ${state.maxWritten}`,
        );
      }
      (this.outcomes.get(state.table) as EntityResult).sequence_next = next;
    }
    return self?.relink ?? false;
  }

  /** Check the record against the target's columns; map user references. */
  private async prepare(state: TableState, row: Row): Promise<Row> {
    if (!state.columns) {
      const keys = Object.keys(row);
      if (!keys.includes(state.idColumn)) {
        throw new Error(
          `the records carry no ${state.idColumn}, the target's id column`,
        );
      }
      const unknown = keys.filter(
        (k) => k !== state.idColumn && !state.catalog.has(k),
      );
      if (unknown.length) {
        throw new Error(`the target has no column ${unknown.join(', ')}`);
      }
      state.columns = keys.filter(
        (k) => k === state.idColumn || !state.skip.has(k),
      );
      state.userColumns = state.columns.filter(
        (c) => state.catalog.get(c)?.reference_table === 'users',
      );
    }
    for (const column of state.columns) {
      if (!(column in row)) {
        throw new Error(
          `record ${JSON.stringify(row[state.idColumn])} has no ${column}`,
        );
      }
    }
    if (!state.userColumns.length) return row;

    const users = await this.userIds();
    const mapped = { ...row };
    for (const column of state.userColumns) {
      const value = row[column];
      if (value === null) continue;
      const externalId =
        value && typeof value === 'object'
          ? (value as Row).external_id
          : undefined;
      if (typeof externalId !== 'string') {
        throw new Error(
          `${column}: expected {"external_id": …} for a user, got ${JSON.stringify(value)}`,
        );
      }
      const id = users.get(externalId);
      if (id === undefined) {
        throw new Error(
          `${column}: no user with external_id ${JSON.stringify(externalId)} on the target`,
        );
      }
      mapped[column] = id;
    }
    return mapped;
  }

  /** The target's users by external_id, read once. */
  private userIds(): Promise<Map<string, unknown>> {
    this.users ??= this.ctx.pg
      .readAll('users', { select: ['id', 'external_id'], key: 'id' })
      .then(
        (users) => new Map(users.map((u) => [u.external_id as string, u.id])),
      );
    return this.users;
  }

  /**
   * Diff a batch against the target and upsert the new and changed rows.
   * A dense batch is read back by id range, a sparse one by in.() lists:
   * its range could span any number of target rows.
   */
  private async writeBatch(
    state: TableState,
    rows: Row[],
    columns: string[],
    count: 'first' | 'second',
    self: SelfReferences | undefined,
  ): Promise<void> {
    const { pg } = this.ctx;
    const { table, idColumn } = state;
    const ids = rows.map((r) => r[idColumn]);
    const numeric = ids.every((id) => Number.isInteger(id));
    const low = numeric ? Math.min(...(ids as number[])) : 0;
    const high = numeric ? Math.max(...(ids as number[])) : 0;
    const dense = numeric && high - low + 1 <= 2 * rows.length;
    const current = indexBy(
      dense
        ? await pg.readAll(table, {
            select: columns,
            filters: [`${idColumn}=gte.${low}`, `${idColumn}=lte.${high}`],
            key: idColumn,
            pageSize: BATCH_ROWS,
            expected: high - low + 1,
            schemaWait: true,
          })
        : await pg.readIn(table, idColumn, ids, {
            select: columns,
            key: idColumn,
            pageSize: BATCH_ROWS,
            schemaWait: true,
          }),
      idColumn,
    );

    const changed = rows.filter((row) => {
      const target = current.get(String(row[idColumn]));
      return !target || columns.some((c) => !Bun.deepEquals(row[c], target[c]));
    });
    if (count === 'first') {
      state.result.written += changed.length;
      state.result.unchanged += rows.length - changed.length;
    } else {
      state.result.rewritten = (state.result.rewritten ?? 0) + changed.length;
    }

    let writing = changed;
    if (self) {
      // A parent later in the file may already be on the target.
      const batchHigh = self.observe(rows);
      const unknown = self.unknownParents(changed, batchHigh);
      const found = new Set(
        (
          await pg.readIn(table, idColumn, unknown, {
            select: [idColumn],
            key: idColumn,
            schemaWait: true,
          })
        ).map((r) => String(r[idColumn])),
      );
      writing = self.split(
        changed,
        batchHigh,
        (id) => current.has(String(id)) || found.has(String(id)),
      );
    }
    if (writing.length) await this.upsert(state, writing, columns);
    const done = state.result.written + state.result.unchanged;
    this.ctx.progress(
      `${table}: ${Math.min(done, state.count)}/${state.count} records`,
    );
  }

  /** Upsert rows known to be new or changed, keyed on the id column. */
  private async upsert(
    state: TableState,
    rows: Row[],
    columns: string[],
  ): Promise<void> {
    const { table, idColumn } = state;
    // Before the first record anywhere: a target without a working
    // fix_id_sequence would keep records behind a stale id sequence.
    this.probe ??= this.fixSequence(table);
    await this.probe;
    await this.ctx.pg.request(
      'POST',
      `/${table}?on_conflict=${encodeURIComponent(idColumn)}&columns=${columnList(columns)}`,
      {
        body: rows.map((row) => pick(row, columns)),
        prefer: 'resolution=merge-duplicates,missing=default,return=minimal',
        schemaWait: true,
      },
    );
    for (const row of rows) {
      const id = row[idColumn];
      if (
        typeof id === 'number' &&
        (state.maxWritten === undefined || id > state.maxWritten)
      ) {
        state.maxWritten = id;
      }
    }
  }

  /**
   * POST /rpc/fix_id_sequence: the next id the sequence hands out, or null
   * when there is nothing to fix. A missing function (PGRST202) means the
   * platform is too old; 42501 (permission denied) is reported as is.
   */
  private async fixSequence(table: string): Promise<number | null> {
    let next: unknown;
    try {
      next = await this.ctx.pg.rpc('fix_id_sequence', { p_table: table });
    } catch (error) {
      if (error instanceof PostgrestError && error.code === 'PGRST202') {
        throw new Error(
          'the target platform lacks fix_id_sequence: it is too old (0.5.0-beta1 databases lack it until they are rebuilt) and must be rebuilt or upgraded before records can be imported. No record was written.',
        );
      }
      throw error;
    }
    if (next === null || next === undefined) return null;
    const number = typeof next === 'string' ? Number(next) : next;
    if (typeof number !== 'number' || Number.isNaN(number)) {
      throw new Error(
        `fix_id_sequence answered ${JSON.stringify(next)}, not a number`,
      );
    }
    return number;
  }
}
