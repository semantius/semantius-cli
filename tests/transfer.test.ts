/**
 * Tests for the transfer tools of the utils server (src/local-tools/transfer/):
 * export_entities, export_module, import_entities, import_module.
 *
 * The tools run through createBuiltinConnection, as `semantius call utils/…`
 * runs them, against in-memory PostgREST fakes (tests/helpers/fake-postgrest)
 * behind a fetch stub. The hosts are self-hosted, so they resolve without a
 * network; a static SEMANTIUS_JWT supplies the token.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { setEnvPrefix, setHostFlag } from '../src/config';
import { resolveHost } from '../src/host';
import { setHostsIndexDirForTests } from '../src/hosts-index';
import { createBuiltinConnection } from '../src/local-tools/connection';
import { exportEntities } from '../src/local-tools/transfer/export';
import { ENTITY_CREATE_ONLY } from '../src/local-tools/transfer/format';
import {
  SelfReferences,
  orderRollups,
  planWrites,
} from '../src/local-tools/transfer/graph';
import { PostgrestClient } from '../src/local-tools/transfer/postgrest';
import {
  isTypeId,
  padSampleId,
  typeIdPrefix,
} from '../src/local-tools/transfer/sample-id';
import { buildTransferSchema } from '../src/local-tools/transfer/schema';
import {
  FakePostgrest,
  type Row,
  installFakes,
} from './helpers/fake-postgrest';

const VARS = [
  'SEMANTIUS_HOST',
  'SEMANTIUS_ORG',
  'SEMANTIUS_JWT',
  'SEMANTIUS_API_KEY',
  'SEMANTIUS_TIMEOUT',
  'SEMANTIUS_DEBUG',
  'SEMANTIUS_CRUD_MCP',
];

function makeJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: 'none' })}.${b64({ exp, sub: 'tester' })}.sig`;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let saved: Record<string, string | undefined>;
let dir: string;
let hostsDir: string;
let fakes: FakePostgrest[];
let restoreFetch: () => void;

beforeEach(async () => {
  saved = {};
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  setEnvPrefix('SEMANTIUS');
  setHostFlag(undefined);
  // Per AGENTS.md: a real current host in hosts.json would win over
  // SEMANTIUS_HOST and send the tools elsewhere.
  hostsDir = await mkdtemp(join(tmpdir(), 'semantius-transfer-hosts-'));
  setHostsIndexDirForTests(hostsDir);
  dir = await mkdtemp(join(tmpdir(), 'semantius-transfer-'));
  process.env.SEMANTIUS_JWT = makeJwt();
  fakes = [];
  restoreFetch = installFakes(fakes);
});

afterEach(async () => {
  restoreFetch();
  setHostsIndexDirForTests(undefined);
  for (const v of VARS) {
    if (saved[v] !== undefined) process.env[v] = saved[v];
    else delete process.env[v];
  }
  await rm(dir, { recursive: true, force: true });
  await rm(hostsDir, { recursive: true, force: true });
});

function fake(
  host: string,
  options?: ConstructorParameters<typeof FakePostgrest>[1],
) {
  const f = new FakePostgrest(host, options);
  fakes.push(f);
  return f;
}

/** Call a utils tool against `host`; the parsed result, or throws its error text. */
async function call(
  host: FakePostgrest,
  tool: string,
  args: Row,
): Promise<any> {
  const result = (await callRaw(host, tool, args)) as ToolResult;
  const text = result.content.map((c) => c.text ?? '').join('\n');
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

async function callRaw(host: FakePostgrest, tool: string, args: Row) {
  process.env.SEMANTIUS_HOST = host.host;
  const conn = await createBuiltinConnection('utils', { builtin: true });
  try {
    return await conn.callTool(tool, args);
  } finally {
    await conn.close();
  }
}

async function callError(
  host: FakePostgrest,
  tool: string,
  args: Row,
): Promise<string> {
  const result = (await callRaw(host, tool, args)) as ToolResult;
  expect(result.isError).toBe(true);
  return result.content.map((c) => c.text ?? '').join('\n');
}

const exists = (path: string) => Bun.file(path).exists();

/** The users both hosts know, with different ids on each. */
function seedUsers(f: FakePostgrest, ids: { alice: number; bob: number }) {
  f.insert('users', [
    { id: ids.alice, external_id: 'auth0|alice', email: 'alice@example.test' },
    { id: ids.bob, external_id: 'auth0|bob', email: 'bob@example.test' },
  ]);
}

/**
 * A CRM module: permissions, a hierarchy row, two roles with grants, default
 * roles, and two entities —
 *   accounts: label account_name, parent_id → accounts (a tree), owner_id → users
 *   contacts: label full_name, account_id → accounts (parent), label_parent
 * Account 3's parent (5) comes later in id order, and account 4's parent is 3.
 */
function seedCrm(f: FakePostgrest, options: { accounts?: number } = {}) {
  seedUsers(f, { alice: 1, bob: 2 });
  const [crm] = f.insert('modules', [
    {
      module_name: 'CRM',
      module_slug: 'crm',
      description: 'Customers',
      // A nested "records" array prints the same line as a records block.
      settings: { records: [1, 2], theme: 'blue' },
    },
  ]);
  f.insert('permissions', [
    { permission_name: 'crm:read', description: 'Read CRM', module_id: crm.id },
    {
      permission_name: 'crm:manage',
      description: 'Manage CRM',
      module_id: crm.id,
    },
  ]);
  f.insert('permission_hierarchy', [
    {
      including_permission_name: 'crm:manage',
      included_permission_name: 'crm:read',
      origin: 'model',
    },
  ]);
  const [viewer, manager] = f.insert('roles', [
    {
      role_name: 'CRM Viewer',
      slug: 'crm_viewer',
      description: 'Reads',
      origin: 'model',
      module_id: crm.id,
    },
    {
      role_name: 'CRM Manager',
      slug: 'crm_manager',
      description: 'Manages',
      origin: 'model',
      module_id: crm.id,
    },
  ]);
  f.insert('role_permissions', [
    { role_id: viewer.id, permission_name: 'crm:read', granted_by: 1 },
    { role_id: manager.id, permission_name: 'crm:manage', granted_by: 1 },
  ]);
  f.update('modules', crm.id, {
    view_permission: 'crm:read',
    manage_permission: 'crm:manage',
    default_viewer_role_id: viewer.id,
    default_manager_role_id: manager.id,
  });
  f.insert('entities', [
    {
      table_name: 'accounts',
      singular_label: 'Account',
      plural_label: 'Accounts',
      module_id: crm.id,
      view_permission: 'crm:read',
      edit_permission: 'crm:manage',
      label_column: 'account_name',
    },
    {
      table_name: 'contacts',
      singular_label: 'Contact',
      plural_label: 'Contacts',
      module_id: crm.id,
      view_permission: 'crm:read',
      edit_permission: 'crm:manage',
      label_column: 'full_name',
      // Not the default, so the round trip shows it travels.
      entity_type: 'operational_record',
    },
  ]);
  // A core field whose non-fixed columns were edited.
  f.update('fields', 'accounts.account_name', {
    title: 'Account name',
    description: 'The legal name',
  });
  f.insert('fields', [
    {
      table_name: 'accounts',
      field_name: 'industry',
      title: 'Industry',
      format: 'text',
      field_order: 2,
    },
    {
      table_name: 'accounts',
      field_name: 'parent_id',
      title: 'Parent',
      format: 'reference',
      reference_table: 'accounts',
      field_order: 3,
    },
    {
      table_name: 'accounts',
      field_name: 'owner_id',
      title: 'Owner',
      format: 'reference',
      reference_table: 'users',
      field_order: 4,
    },
    {
      table_name: 'contacts',
      field_name: 'account_id',
      title: 'Account',
      format: 'parent',
      reference_table: 'accounts',
      reference_delete_mode: 'cascade',
      field_order: 2,
    },
    {
      table_name: 'contacts',
      field_name: 'email',
      title: 'Email',
      format: 'email',
      field_order: 3,
    },
  ]);
  f.update('entities', 'contacts', { label_parent: 'account_id' });

  f.insert('accounts', [
    {
      id: 1,
      account_name: 'Acme',
      industry: 'Tools',
      parent_id: null,
      owner_id: 1,
    },
    {
      id: 5,
      account_name: 'Hooli',
      industry: 'Tech',
      parent_id: null,
      owner_id: null,
    },
  ]);
  f.insert('accounts', [
    {
      id: 2,
      account_name: 'Globex',
      industry: 'Energy',
      parent_id: 1,
      owner_id: 2,
    },
    {
      id: 3,
      account_name: 'Initech',
      industry: 'Software',
      parent_id: 5,
      owner_id: 1,
    },
    {
      id: 4,
      account_name: 'Umbrella',
      industry: 'Pharma',
      parent_id: 3,
      owner_id: null,
    },
  ]);
  const extra = options.accounts ?? 0;
  if (extra) {
    const rows: Row[] = [];
    for (let i = 0; i < extra; i++) {
      rows.push({
        id: 100 + i,
        account_name: `Bulk ${i}`,
        industry: 'Bulk',
        parent_id: 1,
        owner_id: i % 2 ? 1 : 2,
      });
    }
    f.insert('accounts', rows);
  }
  f.insert('contacts', [
    { id: 1, full_name: 'Ann', account_id: 2, email: 'ann@example.test' },
    { id: 2, full_name: 'Ben', account_id: 3, email: 'ben@example.test' },
  ]);
}

/** A target: the users (other ids), nothing else. */
function emptyTarget(options?: ConstructorParameters<typeof FakePostgrest>[1]) {
  const f = fake('target.example.test', options);
  seedUsers(f, { alice: 11, bob: 10 });
  return f;
}

/** The records of a table, without the audit columns the target sets itself. */
function records(f: FakePostgrest, table: string): Row[] {
  return f.rows(table).map(({ created_at, updated_at, ...rest }) => rest);
}

describe('round trip', () => {
  test('export_module A → import_module B → export_module B: identical but for audit columns', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const first = join(dir, 'crm.json');
    const second = join(dir, 'crm-again.json');

    await call(source, 'export_module', { name: 'CRM', path: first });
    const imported = await call(target, 'import_module', { path: first });
    expect(imported.module).toBe('created');
    await call(target, 'export_module', { name: 'CRM', path: second });

    const strip = (doc: any) => {
      for (const e of doc.entities) {
        for (const r of e.records ?? []) {
          delete r.created_at;
          delete r.updated_at;
        }
      }
      return doc;
    };
    const a = strip(JSON.parse(await readFile(first, 'utf8')));
    const b = strip(JSON.parse(await readFile(second, 'utf8')));
    expect(b).toEqual(a);
  });
});

/** A target that already has the CRM module and its permissions. */
function targetWithModule(
  options?: ConstructorParameters<typeof FakePostgrest>[1],
) {
  const f = emptyTarget(options);
  const [crm] = f.insert('modules', [
    { module_name: 'CRM', module_slug: 'crm' },
  ]);
  f.insert('permissions', [
    { permission_name: 'crm:read', module_id: crm.id },
    { permission_name: 'crm:manage', module_id: crm.id },
  ]);
  return f;
}

/** Upserts to a data table since request `from`, in order. */
function upserts(f: FakePostgrest, table: string, from = 0) {
  return f.requests
    .slice(from)
    .filter((r) => r.method === 'POST' && r.target === table)
    .map((r) => ({
      columns: r.url.searchParams.get('columns')?.split(',') ?? [],
      ids: (r.body as Row[]).map((row) => row.id),
      body: r.body as Row[],
    }));
}

function firstRequest(
  f: FakePostgrest,
  method: string,
  target: string,
): number {
  return f.requests.findIndex(
    (r) => r.method === method && r.target === target,
  );
}

function lastRequest(f: FakePostgrest, method: string, target: string): number {
  return f.requests.findLastIndex(
    (r) => r.method === method && r.target === target,
  );
}

/** Owners as the target has them: alice is 11 there, bob 10. */
function onTarget(rows: Row[]): Row[] {
  const ids: Record<number, number> = { 1: 11, 2: 10 };
  return rows.map((r) => ({
    ...r,
    owner_id: r.owner_id == null ? null : ids[r.owner_id as number],
  }));
}

describe('export', () => {
  test('one compact record per line, LF, in names order, the same bytes twice', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');

    const result = await call(source, 'export_entities', {
      names: 'contacts, accounts',
      path: a,
    });
    expect(result.path).toBe(a);
    expect(result.entities).toEqual([
      { table_name: 'contacts', fields: 6, records: 2 },
      { table_name: 'accounts', fields: 7, records: 5 },
    ]);
    await call(source, 'export_entities', {
      names: 'contacts,accounts',
      path: b,
    });

    const text = await readFile(a, 'utf8');
    expect(await readFile(b, 'utf8')).toBe(text);
    expect(text).not.toContain('\r');
    const recordLines = text
      .split('\n')
      .filter((l) => l.startsWith('        {"id":'));
    expect(recordLines).toHaveLength(7);
    for (const line of recordLines) {
      expect(JSON.parse(line.trim().replace(/,$/, ''))).toBeObject();
    }
    const doc = JSON.parse(text);
    expect(Object.keys(doc)).toEqual(['version', 'entities']);
    expect(doc.version).toBe(1);
    expect(doc.entities.map((e: any) => e.entity.table_name)).toEqual([
      'contacts',
      'accounts',
    ]);
    expect(doc.entities[1].records.map((r: Row) => r.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test('metadata carries names, never host ids', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    const doc = JSON.parse(await readFile(path, 'utf8'));

    expect(doc.module).not.toHaveProperty('id');
    expect(doc.module).not.toHaveProperty('default_viewer_role_id');
    expect(doc.module).toMatchObject({
      view_permission: 'crm:read',
      default_viewer_role_slug: 'crm_viewer',
      default_manager_role_slug: 'crm_manager',
      default_admin_role_slug: null,
    });
    expect(doc.permissions).toEqual([
      { permission_name: 'crm:manage', description: 'Manage CRM' },
      { permission_name: 'crm:read', description: 'Read CRM' },
    ]);
    expect(doc.permission_hierarchy).toEqual([
      {
        including_permission_name: 'crm:manage',
        included_permission_name: 'crm:read',
        origin: 'model',
      },
    ]);
    expect(doc.roles.map((r: Row) => r.slug)).toEqual([
      'crm_manager',
      'crm_viewer',
    ]);
    for (const role of doc.roles) {
      expect(role).not.toHaveProperty('id');
      expect(role).not.toHaveProperty('module_id');
    }
    expect(doc.role_permissions).toEqual([
      { role_slug: 'crm_manager', permission_name: 'crm:manage' },
      { role_slug: 'crm_viewer', permission_name: 'crm:read' },
    ]);
    const accounts = doc.entities[0].entity;
    expect(accounts.module_name).toBe('CRM');
    expect(accounts).not.toHaveProperty('module_id');
    expect(accounts).not.toHaveProperty('searchable');
    for (const field of accounts.fields) {
      expect(field).not.toHaveProperty('id');
      expect(field).not.toHaveProperty('table_name');
    }
    // By field_order, then field_name.
    expect(accounts.fields.map((f: Row) => f.field_name)).toEqual([
      'id',
      'account_name',
      'industry',
      'parent_id',
      'owner_id',
      'created_at',
      'updated_at',
    ]);
  });

  test('user references are written as external_id', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = join(dir, 'accounts.json');
    await call(source, 'export_entities', { names: 'accounts', path });
    const doc = JSON.parse(await readFile(path, 'utf8'));
    expect(doc.entities[0].records.map((r: Row) => r.owner_id)).toEqual([
      { external_id: 'auth0|alice' },
      { external_id: 'auth0|bob' },
      { external_id: 'auth0|alice' },
      null,
      null,
    ]);
  });

  test('exclude_schema keeps only table_name, exclude_data drops the records', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const dataOnly = join(dir, 'data.json');
    const schemaOnly = join(dir, 'schema.json');
    await call(source, 'export_entities', {
      names: 'accounts',
      exclude_schema: true,
      path: dataOnly,
    });
    await call(source, 'export_entities', {
      names: 'accounts',
      exclude_data: true,
      path: schemaOnly,
    });

    const data = JSON.parse(await readFile(dataOnly, 'utf8')).entities[0];
    expect(data.entity).toEqual({ table_name: 'accounts' });
    expect(data.records).toHaveLength(5);
    const schema = JSON.parse(await readFile(schemaOnly, 'utf8')).entities[0];
    expect(schema.entity.fields).toHaveLength(7);
    expect(schema).not.toHaveProperty('records');
  });

  test('every export validates against the schema generate_module_schema writes', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(
      buildTransferSchema('test'),
    );
    const cases: Array<[string, Row]> = [
      ['export_module', { name: 'CRM' }],
      ['export_module', { name: 'CRM', exclude_data: true }],
      ['export_entities', { names: 'accounts' }],
      ['export_entities', { names: 'accounts', exclude_schema: true }],
      ['export_entities', { names: 'accounts', exclude_data: true }],
    ];
    for (const [i, [tool, args]] of cases.entries()) {
      const path = join(dir, `case-${i}.json`);
      await call(source, tool, { ...args, path });
      const doc = JSON.parse(await readFile(path, 'utf8'));
      if (!validate(doc)) {
        throw new Error(
          `${tool} ${JSON.stringify(args)} does not validate: ${JSON.stringify(validate.errors)}`,
        );
      }
    }
  });

  test('refuses both excludes, unknown names and system tables, writing nothing', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = join(dir, 'x.json');
    expect(
      await callError(source, 'export_entities', {
        names: 'accounts',
        exclude_schema: true,
        exclude_data: true,
        path,
      }),
    ).toContain('the export would be empty');
    expect(
      await callError(source, 'export_entities', {
        names: 'accounts,nope,gone',
        path,
      }),
    ).toContain('unknown entities: nope, gone');
    expect(
      await callError(source, 'export_entities', {
        names: 'accounts,users,roles',
        path,
      }),
    ).toContain('users, roles: metadata and system tables cannot be exported');
    expect(
      await callError(source, 'export_module', { name: 'Nope', path }),
    ).toContain('unknown module: Nope');
    expect(await exists(path)).toBe(false);
  });

  test('a failure leaves neither a temp file nor a changed output', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = join(dir, 'out.json');
    await writeFile(path, 'previous export');
    source.intercept = (r) =>
      r.method === 'GET' && r.target === 'contacts'
        ? new Response(JSON.stringify({ code: 'XX000', message: 'boom' }), {
            status: 500,
          })
        : undefined;
    expect(
      await callError(source, 'export_entities', {
        names: 'accounts,contacts',
        path,
      }),
    ).toContain('(XX000) boom');
    expect(await readFile(path, 'utf8')).toBe('previous export');
    expect(await exists(`${path}.tmp`)).toBe(false);
  });

  test('a table larger than the server row cap is exported completely', async () => {
    const source = fake('source.example.test');
    seedCrm(source, { accounts: 2500 });
    const path = join(dir, 'accounts.json');
    const result = await call(source, 'export_entities', {
      names: 'accounts',
      path,
    });
    expect(result.entities[0].records).toBe(2505);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    const ids = doc.entities[0].records.map((r: Row) => r.id as number);
    expect(new Set(ids).size).toBe(2505);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
  });

  test('a module with more than 1000 fields is exported with all of them', async () => {
    const source = fake('source.example.test');
    const [m] = source.insert('modules', [
      { module_name: 'Wide', module_slug: 'wide' },
    ]);
    source.insert('entities', [
      { table_name: 'wide_a', singular_label: 'A', module_id: m.id },
      { table_name: 'wide_b', singular_label: 'B', module_id: m.id },
    ]);
    const fields: Row[] = [];
    for (let i = 0; i < 600; i++) {
      for (const table of ['wide_a', 'wide_b']) {
        fields.push({
          table_name: table,
          field_name: `c${i}`,
          title: `C${i}`,
          field_order: i + 1,
        });
      }
    }
    source.insert('fields', fields);
    const result = await call(source, 'export_module', {
      name: 'Wide',
      path: join(dir, 'wide.json'),
      exclude_data: true,
    });
    // 600 fields each, plus id, created_at and updated_at.
    expect(result.entities).toEqual([
      { table_name: 'wide_a', fields: 603 },
      { table_name: 'wide_b', fields: 603 },
    ]);
  });

  test('a transient 503 is retried', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    let failures = 0;
    source.intercept = (r) =>
      r.method === 'GET' && r.target === 'accounts' && failures++ === 0
        ? new Response('busy', { status: 503 })
        : undefined;
    const result = await call(source, 'export_entities', {
      names: 'accounts',
      path: join(dir, 'a.json'),
    });
    expect(result.entities[0].records).toBe(5);
    expect(failures).toBeGreaterThan(1);
  });
});

describe('import', () => {
  async function exportCrm(source: FakePostgrest): Promise<string> {
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    return path;
  }

  test('into an empty target: referenced tables first, a tree in one statement, users by external_id', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = targetWithModule();
    const path = join(dir, 'entities.json');
    await call(source, 'export_entities', { names: 'contacts,accounts', path });

    const result = await call(target, 'import_entities', { path });
    expect(result).not.toHaveProperty('module');
    expect(result.entities).toEqual([
      {
        table_name: 'contacts',
        entity: 'created',
        fields: { created: 2, updated: 0, unchanged: 4 },
        records: { written: 2, unchanged: 0 },
        sequence_next: 3,
      },
      {
        table_name: 'accounts',
        entity: 'created',
        fields: { created: 3, updated: 1, unchanged: 3 },
        records: { written: 5, unchanged: 0 },
        sequence_next: 6,
      },
    ]);
    expect(records(target, 'accounts')).toEqual(
      onTarget(records(source, 'accounts')),
    );
    expect(records(target, 'contacts')).toEqual(records(source, 'contacts'));

    // accounts before contacts, although the file lists contacts first. 3
    // points at 5, later in the same batch: one statement, no hold-back, and
    // parents first within it (for BEFORE triggers that read the parent).
    expect(upserts(target, 'accounts').map((u) => u.ids)).toEqual([
      [1, 5, 2, 3, 4],
    ]);
    expect(lastRequest(target, 'POST', 'accounts')).toBeLessThan(
      firstRequest(target, 'POST', 'contacts'),
    );
  });

  test('core fields are patched, never created, and label_parent waits for the fields', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });

    const fieldPosts = target.requests.filter(
      (r) => r.method === 'POST' && r.target === 'fields',
    );
    const posted = fieldPosts.flatMap((r) =>
      (r.body as Row[]).map((f) => `${f.table_name}.${f.field_name}`),
    );
    expect(posted.sort()).toEqual([
      'accounts.industry',
      'accounts.owner_id',
      'accounts.parent_id',
      'contacts.account_id',
      'contacts.email',
    ]);
    for (const request of fieldPosts) {
      for (const field of request.body as Row[])
        expect(field).not.toHaveProperty('ctype');
    }
    expect(target.row('fields', 'accounts.account_name')).toMatchObject({
      title: 'Account name',
      description: 'The legal name',
      ctype: 'label',
    });
    const labelParent = target.requests.findIndex(
      (r) =>
        r.method === 'PATCH' &&
        r.target === 'entities' &&
        (r.body as Row).label_parent === 'account_id',
    );
    expect(labelParent).toBeGreaterThan(firstRequest(target, 'POST', 'fields'));
    expect(target.row('entities', 'contacts')?.label_parent).toBe('account_id');
  });

  test('module, permissions, hierarchy, roles and grants by name; granted by the importing user', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget({ userId: 77 });
    // The same slug is already there, under another id and name.
    target.insert('roles', [
      { role_name: 'Old viewer', slug: 'crm_viewer', origin: 'user' },
    ]);

    const result = await call(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(Object.keys(result)).toEqual([
      'module',
      'permissions',
      'permission_hierarchy',
      'roles',
      'role_permissions',
      'entities',
    ]);
    expect(result.module).toBe('created');
    expect(result.permissions).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(result.permission_hierarchy).toEqual({ created: 1, unchanged: 0 });
    expect(result.roles).toEqual({ created: 1, updated: 1, unchanged: 0 });
    expect(result.role_permissions).toEqual({ created: 2, unchanged: 0 });

    const roleId = (slug: string) =>
      target.rows('roles').find((r) => r.slug === slug)?.id;
    expect(target.rows('modules')[0]).toMatchObject({
      module_name: 'CRM',
      view_permission: 'crm:read',
      manage_permission: 'crm:manage',
      default_viewer_role_id: roleId('crm_viewer'),
      default_manager_role_id: roleId('crm_manager'),
      settings: { records: [1, 2], theme: 'blue' },
    });
    // Updated in place; origin is create-only.
    expect(
      target.rows('roles').find((r) => r.slug === 'crm_viewer'),
    ).toMatchObject({
      role_name: 'CRM Viewer',
      origin: 'user',
    });
    const grants = target.rows('role_permissions');
    expect(grants).toHaveLength(2);
    for (const grant of grants) expect(grant.granted_by).toBe(77);
  });

  test('a re-run writes nothing, with batches larger than the server row cap', async () => {
    const source = fake('source.example.test');
    seedCrm(source, { accounts: 2500 });
    const target = emptyTarget();
    const path = await exportCrm(source);

    const first = await call(target, 'import_module', { path });
    expect(first.entities[0].records).toEqual({ written: 2505, unchanged: 0 });
    expect(target.rows('accounts')).toHaveLength(2505);

    const mark = target.requests.length;
    const again = await call(target, 'import_module', { path });
    expect(target.writesSince(mark)).toEqual([]);
    expect(again.module).toBe('unchanged');
    expect(again.entities[0]).toEqual({
      table_name: 'accounts',
      entity: 'unchanged',
      fields: { created: 0, updated: 0, unchanged: 7 },
      records: { written: 0, unchanged: 2505 },
    });
  });

  test('only changed records are written', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const path = await exportCrm(source);
    await call(target, 'import_module', { path });

    target.update('accounts', 2, { industry: 'Changed on the target' });
    const mark = target.requests.length;
    const result = await call(target, 'import_module', { path });
    expect(upserts(target, 'accounts', mark).map((u) => u.ids)).toEqual([[2]]);
    expect(upserts(target, 'contacts', mark)).toEqual([]);
    expect(result.entities[0].records).toEqual({ written: 1, unchanged: 4 });
    expect(target.row('accounts', 2)?.industry).toBe('Energy');
  });

  test('a dense batch is read back by id range, a sparse one with in.()', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const crm = source.rows('modules')[0];
    source.insert('entities', [
      {
        table_name: 'events',
        singular_label: 'Event',
        module_id: crm.id,
        label_column: 'title',
      },
    ]);
    source.insert('events', [
      { id: 1, title: 'first' },
      { id: 500000, title: 'middle' },
      { id: 1000000, title: 'last' },
    ]);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });

    const reads = (table: string) =>
      target.requests
        .filter((r) => r.method === 'GET' && r.target === table)
        .map((r) => decodeURIComponent(r.url.search));
    expect(reads('events').length).toBeGreaterThan(0);
    for (const query of reads('events')) {
      expect(query).toContain('id=in.(1,500000,1000000)');
    }
    expect(reads('accounts').some((q) => q.includes('id=gte.1&id=lte.5'))).toBe(
      true,
    );
    expect(records(target, 'events')).toEqual(records(source, 'events'));
  });

  test('tables in a cycle: pass 1 leaves the reference column out, pass 2 writes it', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.insert('fields', [
      {
        table_name: 'accounts',
        field_name: 'primary_contact_id',
        title: 'Primary contact',
        format: 'reference',
        reference_table: 'contacts',
        field_order: 5,
      },
    ]);
    source.update('accounts', 2, { primary_contact_id: 1 });
    const target = targetWithModule();
    const path = join(dir, 'cycle.json');
    await call(source, 'export_entities', { names: 'accounts,contacts', path });

    const result = await call(target, 'import_entities', { path });
    const writes = upserts(target, 'accounts');
    expect(writes[0].columns).not.toContain('primary_contact_id');
    const pass2 = writes[writes.length - 1];
    expect(pass2.columns).toContain('primary_contact_id');
    expect(pass2.ids).toEqual([2]);
    expect(lastRequest(target, 'POST', 'accounts')).toBeGreaterThan(
      firstRequest(target, 'POST', 'contacts'),
    );
    expect(target.row('accounts', 2)?.primary_contact_id).toBe(1);
    expect(result.entities[0].records).toEqual({
      written: 5,
      unchanged: 0,
      rewritten: 1,
    });

    // A re-run writes nothing in either pass.
    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(target.writesSince(mark)).toEqual([]);
  });

  test('validation rules are written before the records, and a record they reject stops every run', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.update('accounts', 5, { industry: 'Legacy' });
    const rule = {
      name: 'no_legacy',
      jsonlogic: { '!=': [{ var: 'industry' }, 'Legacy'] },
      message: 'legacy accounts are closed',
    };
    source.update('entities', 'accounts', { validation_rules: [rule] });
    const target = emptyTarget();
    const path = await exportCrm(source);

    expect(await callError(target, 'import_module', { path })).toContain(
      'legacy accounts are closed',
    );
    expect(target.row('entities', 'accounts')?.validation_rules).toEqual([
      rule,
    ]);
    const rules = target.requests.findIndex(
      (r) =>
        r.method === 'PATCH' &&
        r.target === 'entities' &&
        'validation_rules' in (r.body as Row),
    );
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(rules).toBeLessThan(firstRequest(target, 'POST', 'accounts'));
    expect(target.row('accounts', 5)).toBeUndefined();

    // A re-run, the entity now on the target, fails the same way.
    expect(await callError(target, 'import_module', { path })).toContain(
      'legacy accounts are closed',
    );
    expect(target.row('accounts', 5)).toBeUndefined();
  });

  test('computed columns are not written; a field disabled by hand is', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.insert('fields', [
      {
        table_name: 'accounts',
        field_name: 'employees',
        title: 'Employees',
        format: 'integer',
        field_order: 6,
      },
      {
        table_name: 'accounts',
        field_name: 'score',
        title: 'Score',
        format: 'integer',
        field_order: 7,
        input_type: 'disabled',
      },
      {
        table_name: 'accounts',
        field_name: 'notes',
        title: 'Notes',
        format: 'text',
        field_order: 8,
        input_type: 'disabled',
      },
    ]);
    source.update('entities', 'accounts', {
      computed_fields: [
        { name: 'score', jsonlogic: { '*': [{ var: 'employees' }, 2] } },
      ],
    });
    for (const id of [1, 2, 3, 4, 5]) {
      source.update('accounts', id, {
        employees: id * 10,
        notes: `note ${id}`,
      });
    }
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });

    const writes = upserts(target, 'accounts');
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.columns).toContain('notes');
      expect(write.columns).not.toContain('score');
      expect(write.columns).not.toContain('created_at');
    }
    expect(target.row('accounts', 3)).toMatchObject({
      employees: 30,
      score: 60,
      notes: 'note 3',
    });
  });

  test('an unknown external_id is an error naming the column', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = fake('target.example.test');
    target.insert('users', [
      { id: 11, external_id: 'auth0|alice', email: 'alice@example.test' },
    ]);
    const error = await callError(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(error).toContain(
      'records of accounts: owner_id: no user with external_id "auth0|bob" on the target',
    );
    expect(upserts(target, 'accounts')).toEqual([]);
  });

  test('a file of another version is refused before any request', async () => {
    const target = emptyTarget();
    const path = join(dir, 'v2.json');
    await writeFile(path, JSON.stringify({ version: 2, entities: [] }));
    const mark = target.requests.length;
    expect(await callError(target, 'import_entities', { path })).toContain(
      'has version 2',
    );
    expect(target.requests.length).toBe(mark);
  });

  test('a target without fix_id_sequence (PGRST202) aborts before any record', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget({ fixIdSequence: 'missing' });
    const error = await callError(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(error).toContain('lacks fix_id_sequence');
    expect(error).toContain('rebuilt or upgraded');
    expect(upserts(target, 'accounts')).toEqual([]);
    expect(upserts(target, 'contacts')).toEqual([]);
  });

  test('a denied fix_id_sequence (42501) aborts before any record, without a retry', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget({ fixIdSequence: 'denied' });
    const error = await callError(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(error).toContain(
      '(42501) Permission denied: cannot fix the id sequence of accounts',
    );
    expect(
      target.requests.filter((r) => r.target === 'rpc/fix_id_sequence'),
    ).toHaveLength(1);
    expect(upserts(target, 'accounts')).toEqual([]);
  });

  test('a null fix_id_sequence result is accepted', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget({ fixIdSequence: 'null' });
    const result = await call(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(result.entities[0].sequence_next).toBeNull();
    expect(target.rows('accounts')).toHaveLength(5);
  });

  test('an insert after the import gets a fresh id', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });
    const [fresh] = target.insert('accounts', [
      { account_name: 'Fresh', industry: 'New' },
    ]);
    expect(fresh.id).toBe(6);
  });

  test('import_entities takes a module file; import_module refuses an entity file', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = targetWithModule();
    const result = await call(target, 'import_entities', {
      path: await exportCrm(source),
    });
    expect(result).not.toHaveProperty('module');
    expect(result.entities.map((e: Row) => e.entity)).toEqual([
      'created',
      'created',
    ]);
    expect(target.rows('roles')).toEqual([]);

    const entityFile = join(dir, 'entities.json');
    await call(source, 'export_entities', {
      names: 'accounts',
      path: entityFile,
    });
    expect(
      await callError(target, 'import_module', { path: entityFile }),
    ).toContain('carries no module; import it with import_entities');
  });

  test('entities whose module is missing on the target are refused', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    expect(
      await callError(target, 'import_entities', {
        path: await exportCrm(source),
      }),
    ).toContain(
      'module CRM (of accounts), module CRM (of contacts) not on the target',
    );
  });

  test('a data-only file needs the table on the target', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const path = join(dir, 'data.json');
    await call(source, 'export_entities', {
      names: 'accounts',
      exclude_schema: true,
      path,
    });
    expect(await callError(target, 'import_entities', { path })).toContain(
      'accounts: not on the target, and the file carries no schema for them',
    );
  });

  test('a reformatted file is parsed whole; CRLF line endings still stream', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = await exportCrm(source);
    const text = await readFile(path, 'utf8');
    const pretty = join(dir, 'pretty.json');
    await writeFile(pretty, JSON.stringify(JSON.parse(text), null, 4));
    const crlf = join(dir, 'crlf.json');
    await writeFile(crlf, text.replaceAll('\n', '\r\n'));

    for (const file of [pretty, crlf]) {
      const target = emptyTarget();
      await call(target, 'import_module', { path: file });
      expect(records(target, 'accounts')).toEqual(
        onTarget(records(source, 'accounts')),
      );
      expect(target.rows('modules')[0].settings).toEqual({
        records: [1, 2],
        theme: 'blue',
      });
      fakes.splice(fakes.indexOf(target), 1);
    }
  });
});

describe('import: tables that reference themselves', () => {
  async function exportTable(source: FakePostgrest, names: string) {
    const path = join(dir, `${names}.json`);
    await call(source, 'export_entities', { names, path });
    return path;
  }

  /** A CRM source plus an entity `table` (module CRM, label `name`). */
  function withTable(source: FakePostgrest, table: string, fields: Row[]) {
    const crm = source.rows('modules')[0];
    source.insert('entities', [
      {
        table_name: table,
        singular_label: table,
        module_id: crm.id,
        label_column: 'name',
      },
    ]);
    source.insert(
      'fields',
      fields.map((f, i) => ({ table_name: table, field_order: i + 2, ...f })),
    );
  }

  test('rows of one batch that point at each other are written in one statement, and a re-run writes nothing', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    withTable(source, 'pairs', [
      {
        field_name: 'partner_id',
        title: 'Partner',
        format: 'reference',
        reference_table: 'pairs',
      },
    ]);
    source.insert('pairs', [
      { id: 1, name: 'a', partner_id: 2 },
      { id: 2, name: 'b', partner_id: 1 },
    ]);
    const target = targetWithModule();
    const path = await exportTable(source, 'pairs');

    const result = await call(target, 'import_entities', { path });
    expect(result.entities[0].records).toEqual({ written: 2, unchanged: 0 });
    expect(upserts(target, 'pairs').map((u) => u.ids)).toEqual([[1, 2]]);
    expect(records(target, 'pairs')).toEqual(records(source, 'pairs'));

    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(target.writesSince(mark)).toEqual([]);
  });

  test('a chain pointing forward across batches: nulled at the batch edge, relinked once, linear in requests', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    withTable(source, 'steps', [
      {
        field_name: 'next_id',
        title: 'Next',
        format: 'reference',
        reference_table: 'steps',
      },
    ]);
    const rows: Row[] = [];
    for (let i = 1; i <= 5000; i++) {
      rows.push({ id: i, name: `step ${i}`, next_id: i < 5000 ? i + 1 : null });
    }
    source.insert('steps', rows);
    const target = targetWithModule();
    const path = await exportTable(source, 'steps');

    const result = await call(target, 'import_entities', { path });
    // Batches of 2000: 2000 → 2001 and 4000 → 4001 cross a batch edge.
    expect(result.entities[0].records).toEqual({
      written: 5000,
      unchanged: 0,
      rewritten: 2,
    });
    // Three batches, then the relink pass rewrites the two nulled rows.
    const writes = upserts(target, 'steps');
    expect(writes.map((u) => u.ids.length)).toEqual([2000, 2000, 1000, 1, 1]);
    expect(writes.slice(3).map((u) => u.ids)).toEqual([[2000], [4000]]);
    // Each next row is the parent: the batch goes in reverse, the edge row
    // (its next in the following batch, so written null) first.
    expect(writes[0].body[0]).toMatchObject({ id: 2000, next_id: null });
    expect(writes[0].ids.at(-1)).toBe(1);
    expect(records(target, 'steps')).toEqual(records(source, 'steps'));

    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(target.writesSince(mark)).toEqual([]);
  });

  test('a computed field that reads the parent sees it: parents go first in a statement', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.insert('fields', [
      {
        table_name: 'accounts',
        field_name: 'parent_name',
        title: 'Parent name',
        field_order: 9,
        input_type: 'disabled',
      },
    ]);
    source.update('entities', 'accounts', {
      computed_fields: [
        {
          name: 'parent_name',
          jsonlogic: {
            get: ['accounts', { var: 'parent_id' }, 'account_name'],
          },
        },
      ],
    });
    for (const id of [1, 2, 3, 4, 5]) source.update('accounts', id, {});
    expect(source.row('accounts', 3)?.parent_name).toBe('Hooli');
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });

    await call(target, 'import_module', { path });
    // 3's parent (5) comes later in the file but earlier in the statement.
    expect(target.row('accounts', 3)?.parent_name).toBe('Hooli');
    expect(target.row('accounts', 4)?.parent_name).toBe('Initech');
  });

  test('a parent chain pointing forward is held and drained parent-first, linear in requests', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    withTable(source, 'links', [
      {
        field_name: 'parent_link_id',
        title: 'Parent',
        format: 'parent',
        reference_table: 'links',
      },
    ]);
    const rows: Row[] = [];
    for (let i = 1; i <= 5000; i++) {
      rows.push({
        id: i,
        name: `link ${i}`,
        parent_link_id: i < 5000 ? i + 1 : i,
      });
    }
    source.insert('links', rows);
    const target = targetWithModule();
    const path = await exportTable(source, 'links');

    const started = Date.now();
    const result = await call(target, 'import_entities', { path });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.entities[0].records).toEqual({ written: 5000, unchanged: 0 });
    // The last batch goes first; the two held batches follow, parents first.
    expect(upserts(target, 'links').map((u) => u.ids.length)).toEqual([
      1000, 2000, 2000,
    ]);
    expect(records(target, 'links')).toEqual(records(source, 'links'));

    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(target.writesSince(mark)).toEqual([]);
  });

  test('a parent column pointing at a later batch holds the row until the end', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    withTable(source, 'nodes', [
      {
        field_name: 'parent_node_id',
        title: 'Parent',
        format: 'parent',
        reference_table: 'nodes',
      },
    ]);
    const rows: Row[] = [{ id: 1, name: 'root', parent_node_id: 1 }];
    for (let i = 2; i <= 2500; i++) {
      // Node 2 hangs below the last node; everything else below the root.
      rows.push({
        id: i,
        name: `node ${i}`,
        parent_node_id: i === 2 ? 2500 : 1,
      });
    }
    source.insert('nodes', rows);
    const target = targetWithModule();
    const path = await exportTable(source, 'nodes');

    const result = await call(target, 'import_entities', { path });
    expect(result.entities[0].records).toEqual({ written: 2500, unchanged: 0 });
    const writes = upserts(target, 'nodes');
    expect(writes[writes.length - 1].ids).toEqual([2]);
    expect(records(target, 'nodes')).toEqual(records(source, 'nodes'));

    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(target.writesSince(mark)).toEqual([]);
  });
});

describe('import: retries and failures', () => {
  async function exportCrm(source: FakePostgrest): Promise<string> {
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    return path;
  }

  test('a busy table (90232) from fix_id_sequence is retried', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    target.busy = 2;
    const result = await call(target, 'import_module', {
      path: await exportCrm(source),
    });
    expect(result.entities[0].sequence_next).toBe(6);
    // Twice busy, then the probe and one call per table.
    expect(
      target.requests.filter((r) => r.target === 'rpc/fix_id_sequence'),
    ).toHaveLength(5);
  });

  test('a 401 refreshes the token once, and the request goes through', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    delete process.env.SEMANTIUS_JWT;
    process.env.SEMANTIUS_API_KEY = 'key-secret';
    process.env.SEMANTIUS_DISABLE_JWT_CACHE = '1';
    try {
      let expired = false;
      source.intercept = (r) => {
        if (r.method === 'GET' && r.target === 'accounts' && !expired) {
          expired = true;
          source.rejected.add(source.issued[0]);
        }
        return undefined;
      };
      const result = await call(source, 'export_entities', {
        names: 'accounts',
        path: join(dir, 'a.json'),
      });
      expect(result.entities[0].records).toBe(5);
      expect(source.issued).toHaveLength(2);
    } finally {
      delete process.env.SEMANTIUS_API_KEY;
      delete process.env.SEMANTIUS_DISABLE_JWT_CACHE;
    }
  });

  test('an insert is retried on 503 (it never ran), not on 502', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = await exportCrm(source);
    const once = (f: FakePostgrest, status: number) => {
      let sent = false;
      f.intercept = (r) => {
        if (r.method !== 'POST' || r.target !== 'modules' || sent)
          return undefined;
        sent = true;
        return new Response('gateway', { status });
      };
    };

    const unavailable = emptyTarget();
    once(unavailable, 503);
    await call(unavailable, 'import_module', { path });
    expect(
      unavailable.requests.filter(
        (r) => r.method === 'POST' && r.target === 'modules',
      ),
    ).toHaveLength(2);
    fakes.splice(fakes.indexOf(unavailable), 1);

    const badGateway = emptyTarget();
    once(badGateway, 502);
    expect(await callError(badGateway, 'import_module', { path })).toContain(
      '(HTTP 502)',
    );
    expect(
      badGateway.requests.filter(
        (r) => r.method === 'POST' && r.target === 'modules',
      ),
    ).toHaveLength(1);
  });

  test('a stale schema cache (PGRST205) on a new table is waited out', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    let stale = 2;
    target.intercept = (r) =>
      r.method === 'GET' && r.target === 'accounts' && stale-- > 0
        ? new Response(
            JSON.stringify({
              code: 'PGRST205',
              message:
                "Could not find the table 'public.accounts' in the schema cache",
            }),
            { status: 404 },
          )
        : undefined;
    await call(target, 'import_module', { path: await exportCrm(source) });
    expect(target.rows('accounts')).toHaveLength(5);
  });

  test('cancelling an export removes its temp file', async () => {
    const source = fake('source.example.test');
    seedCrm(source, { accounts: 2500 });
    process.env.SEMANTIUS_HOST = source.host;
    const controller = new AbortController();
    const pg = new PostgrestClient(
      await resolveHost(),
      'token',
      controller.signal,
    );
    let pages = 0;
    source.intercept = (r) => {
      if (r.method === 'GET' && r.target === 'accounts' && ++pages === 2)
        controller.abort();
      return undefined;
    };
    const path = join(dir, 'cancelled.json');
    await expect(
      exportEntities({ pg, progress: () => {} }, { names: 'accounts', path }),
    ).rejects.toThrow('cancelled');
    expect(await exists(`${path}.tmp`)).toBe(false);
    expect(await exists(path)).toBe(false);
  });
});

describe('import: files and schema', () => {
  test('a BOM, and multi-byte characters across the read chunks', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const crm = source.rows('modules')[0];
    source.insert('entities', [
      {
        table_name: 'notes',
        singular_label: 'Note',
        module_id: crm.id,
        label_column: 'name',
      },
    ]);
    const rows: Row[] = [];
    for (let i = 1; i <= 4000; i++) {
      rows.push({ id: i, name: `Grüße ${i} — 😀 € ${'ä'.repeat(i % 40)}` });
    }
    source.insert('notes', rows);
    const path = join(dir, 'notes.json');
    await call(source, 'export_entities', { names: 'notes', path });
    await writeFile(path, `﻿${await readFile(path, 'utf8')}`);

    const target = targetWithModule();
    await call(target, 'import_entities', { path });
    expect(records(target, 'notes')).toEqual(records(source, 'notes'));
  });

  test('a small records block early in a large file yields only its own records', async () => {
    // Bun on Windows streams a small slice of a large file past its end.
    const source = fake('source.example.test');
    seedCrm(source, { accounts: 2500 });
    const path = join(dir, 'large.json');
    await call(source, 'export_entities', { names: 'contacts,accounts', path });
    expect(Bun.file(path).size).toBeGreaterThan(200_000);

    const target = targetWithModule();
    const result = await call(target, 'import_entities', { path });
    expect(result.entities.map((e: Row) => e.records)).toEqual([
      { written: 2, unchanged: 0 },
      { written: 2505, unchanged: 0 },
    ]);
    expect(records(target, 'contacts')).toEqual(records(source, 'contacts'));
  });

  test('a records block with far more of the file after it ends', async () => {
    // Bun on Linux delivers such a slice, then never closes its stream.
    const source = fake('source.example.test');
    seedCrm(source);
    source.insert(
      'contacts',
      Array.from({ length: 12000 }, (_, i) => ({
        id: 1000 + i,
        full_name: `Contact ${i}`,
        account_id: 2,
        email: `c${i}@example.test`,
      })),
    );
    const path = join(dir, 'large.json');
    await call(source, 'export_entities', { names: 'accounts,contacts', path });
    expect(Bun.file(path).size).toBeGreaterThan(1_000_000);

    const target = targetWithModule();
    const result = await call(target, 'import_entities', { path });
    expect(result.entities.map((e: Row) => e.records)).toEqual([
      { written: 5, unchanged: 0 },
      { written: 12002, unchanged: 0 },
    ]);
  });

  test('a schema-only file, then a changed field', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const path = join(dir, 'schema.json');
    await call(source, 'export_module', {
      name: 'CRM',
      path,
      exclude_data: true,
    });
    const first = await call(target, 'import_module', { path });
    expect(first.entities[0]).not.toHaveProperty('records');
    expect(target.rows('accounts')).toEqual([]);

    source.update('fields', 'accounts.industry', { title: 'Sector' });
    await call(source, 'export_module', {
      name: 'CRM',
      path,
      exclude_data: true,
    });
    const second = await call(target, 'import_module', { path });
    expect(second.entities[0].fields).toEqual({
      created: 0,
      updated: 1,
      unchanged: 6,
    });
    expect(target.row('fields', 'accounts.industry')?.title).toBe('Sector');
  });

  test('entity_type is written on create and updated when it changed', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    await call(target, 'import_module', { path });
    expect(target.row('entities', 'contacts')?.entity_type).toBe(
      'operational_record',
    );

    source.update('entities', 'contacts', { entity_type: 'junction' });
    await call(source, 'export_module', { name: 'CRM', path });
    const again = await call(target, 'import_module', { path });
    expect(target.row('entities', 'contacts')?.entity_type).toBe('junction');
    expect(again.entities[1]).toMatchObject({
      table_name: 'contacts',
      entity: 'updated',
    });
  });

  test('id_type is sent on create and left out of the update: patching it is refused with 90233', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.update('entities', 'accounts', {
      id_type: 'typeid',
      id_prefix: 'acct',
    });
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });

    await call(target, 'import_module', { path });
    expect(target.row('entities', 'accounts')?.id_type).toBe('typeid');
    const created = target.requests.find(
      (r) => r.method === 'POST' && r.target === 'entities',
    );
    const createdRows = [created?.body].flat() as Row[];
    expect(
      createdRows.some((r) => r?.table_name === 'accounts' && r.id_type),
    ).toBe(true);

    // A re-import updates the entity that now exists. id_type is locked once
    // the table is created, so it must not appear in the PATCH.
    source.update('entities', 'accounts', { singular_label: 'Account!' });
    await call(source, 'export_module', { name: 'CRM', path });
    const from = target.requests.length;
    const again = await call(target, 'import_module', { path });
    expect(again.entities).toContainEqual(
      expect.objectContaining({ table_name: 'accounts', entity: 'updated' }),
    );
    const patches = target.requests
      .slice(from)
      .filter((r) => r.method === 'PATCH' && r.target === 'entities');
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      expect(p.body as Row).not.toHaveProperty('id_type');
    }
    // id_prefix stays updatable: a TypeID prefix may be changed later.
    expect(ENTITY_CREATE_ONLY).toContain('id_type');
    expect(ENTITY_CREATE_ONLY).not.toContain('id_prefix');
  });

  test('id_refentity is sent on create and never patched: changing it is refused with 90241', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    source.update('entities', 'accounts', {
      id_type: 'typeid',
      id_prefix: 'acct',
    });
    source.update('entities', 'contacts', {
      id_type: 'has_a',
      id_refentity: 'accounts',
    });
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', {
      name: 'CRM',
      path,
      exclude_data: true,
    });

    await call(target, 'import_module', { path });
    expect(target.row('entities', 'contacts')?.id_refentity).toBe('accounts');

    // The target's entity names another base: the platform would refuse the
    // patch, so a re-import leaves the column alone.
    target.update('entities', 'contacts', { id_refentity: null });
    const from = target.requests.length;
    const again = await call(target, 'import_module', { path });
    expect(again.entities).toContainEqual(
      expect.objectContaining({ table_name: 'contacts', entity: 'unchanged' }),
    );
    const patches = target.requests
      .slice(from)
      .filter((r) => r.method === 'PATCH' && r.target === 'entities');
    for (const p of patches) {
      expect(p.body as Row).not.toHaveProperty('id_refentity');
    }
    expect(ENTITY_CREATE_ONLY).toContain('id_refentity');
  });

  test('select_rule is written before the records, with the validation rules', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const selectRule = { '!=': [{ var: 'industry' }, 'Hidden'] };
    source.update('entities', 'accounts', { select_rule: selectRule });
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    await call(target, 'import_module', { path });

    expect(target.row('entities', 'accounts')?.select_rule).toEqual(selectRule);
    const patch = target.requests.findIndex(
      (r) =>
        r.method === 'PATCH' &&
        r.target === 'entities' &&
        'select_rule' in (r.body as Row),
    );
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(patch).toBeLessThan(firstRequest(target, 'POST', 'accounts'));
  });
});

describe('import: rollup and computed fields', () => {
  /** A module and its entities, with nothing but their core fields. */
  function seedEntities(
    f: FakePostgrest,
    module_name: string,
    tables: string[],
  ): void {
    const [module] = f.insert('modules', [
      {
        module_name,
        module_slug: module_name.toLowerCase(),
        description: '',
      },
    ]);
    f.insert(
      'entities',
      tables.map((table_name) => ({
        table_name,
        singular_label: table_name,
        plural_label: table_name,
        module_id: module.id,
      })),
    );
  }

  /** A field by its id, `<table>.<field>`. */
  const field = (id: string, format: string, extra: Row = {}): Row => {
    const [table_name, field_name] = id.split('.');
    return { table_name, field_name, title: field_name, format, ...extra };
  };

  const COUNT_ORDERS = { link_field: 'orders.customer_id', function: 'count' };
  const SUM_SUBTOTALS = {
    link_field: 'orders.customer_id',
    function: 'sum',
    value_field: 'subtotal',
  };

  /**
   * A module whose names sort against its dependencies, as Northwind's
   * customers over orders would:
   *   customers: order_count, and two rollups that read the rollup
   *              orders.subtotal, orders_total (its value) and big_orders (a filter)
   *   order_lines: order_id → orders, amount (computed)
   *   orders: customer_id → customers, subtotal (over order_lines)
   */
  function seedSales(
    f: FakePostgrest,
    options: { customers?: number; lines?: number } = {},
  ): void {
    seedEntities(f, 'Sales', ['customers', 'order_lines', 'orders']);
    f.insert('fields', [
      field('customers.name', 'text', { field_order: 1 }),
      field('orders.customer_id', 'reference', {
        reference_table: 'customers',
        field_order: 1,
      }),
      field('order_lines.order_id', 'parent', {
        reference_table: 'orders',
        reference_delete_mode: 'cascade',
        field_order: 1,
      }),
      field('order_lines.quantity', 'integer', { field_order: 2 }),
      field('order_lines.amount', 'number', { field_order: 3 }),
    ]);
    f.update('entities', 'order_lines', {
      computed_fields: [
        { name: 'amount', jsonlogic: { '*': [{ var: 'quantity' }, 10] } },
      ],
    });
    f.insert('fields', [
      field('orders.subtotal', 'number', {
        field_order: 2,
        rollup: {
          link_field: 'order_lines.order_id',
          function: 'sum',
          value_field: 'amount',
        },
      }),
    ]);
    f.insert('fields', [
      field('customers.big_orders', 'int64', {
        field_order: 2,
        rollup: { ...COUNT_ORDERS, filter: { '>': [{ var: 'subtotal' }, 100] } },
      }),
      field('customers.order_count', 'int64', {
        field_order: 3,
        rollup: COUNT_ORDERS,
      }),
      field('customers.orders_total', 'number', {
        field_order: 4,
        rollup: SUM_SUBTOTALS,
      }),
    ]);
    f.insert(
      'customers',
      Array.from({ length: options.customers ?? 2 }, (_, i) => ({
        id: i + 1,
        name: `Customer ${i + 1}`,
      })),
    );
    f.insert('orders', [
      { id: 1, customer_id: 1 },
      { id: 2, customer_id: 2 },
    ]);
    f.insert(
      'order_lines',
      Array.from({ length: options.lines ?? 3 }, (_, i) => ({
        id: i + 1,
        order_id: i % 2 ? 2 : 1,
        quantity: 1 + (i % 3),
      })),
    );
    // What the platform would have calculated: the fake never aggregates.
    f.setStored('orders', 1, { subtotal: 120 });
    f.setStored('customers', 1, {
      big_orders: 1,
      order_count: 1,
      orders_total: 120,
    });
  }

  async function exportSales(
    source: FakePostgrest,
    options: Row = {},
  ): Promise<string> {
    const path = join(dir, 'sales.json');
    await call(source, 'export_module', { name: 'Sales', path, ...options });
    return path;
  }

  /** The CRM, with accounts.score computed from accounts.employees. */
  function seedScore(f: FakePostgrest): void {
    seedCrm(f);
    f.insert('fields', [
      field('accounts.employees', 'integer', { field_order: 6 }),
      field('accounts.score', 'integer', { field_order: 7 }),
    ]);
    f.update('entities', 'accounts', {
      computed_fields: [
        { name: 'score', jsonlogic: { '*': [{ var: 'employees' }, 2] } },
      ],
    });
    for (const id of [1, 2, 3, 4, 5]) {
      f.update('accounts', id, { employees: id * 10 });
    }
  }

  async function exportCrm(
    source: FakePostgrest,
    options: Row = {},
  ): Promise<string> {
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path, ...options });
    return path;
  }

  /** The field_name of each field POSTed, in request order. */
  const postedFields = (f: FakePostgrest): Row[] =>
    f.requests
      .filter((r) => r.method === 'POST' && r.target === 'fields')
      .flatMap((r) => r.body as Row[]);

  test('a computed field is created from the file, with records and without', async () => {
    const source = fake('source.example.test');
    seedScore(source);

    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });
    expect(target.row('fields', 'accounts.score')).toMatchObject({
      ctype: 'computed',
      input_type: 'disabled',
    });
    expect(target.row('accounts', 3)).toMatchObject({
      employees: 30,
      score: 60,
    });

    const schemaOnly = fake('schema-only.example.test');
    await call(schemaOnly, 'import_module', {
      path: await exportCrm(source, { exclude_data: true }),
    });
    expect(schemaOnly.row('fields', 'accounts.score')).toMatchObject({
      ctype: 'computed',
    });
  });

  test('an existing computed field takes a changed format; a label field still does not', async () => {
    const source = fake('source.example.test');
    seedScore(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportCrm(source) });

    source.update('fields', 'accounts.score', { format: 'number' });
    source.update('fields', 'accounts.account_name', { format: 'email' });
    await call(target, 'import_module', { path: await exportCrm(source) });
    expect(target.row('fields', 'accounts.score')).toMatchObject({
      format: 'number',
    });
    expect(target.row('fields', 'accounts.account_name')).toMatchObject({
      format: 'text',
    });
  });

  test('rollups round trip, written after the fields they name and before computed_fields', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    const result = await call(target, 'import_module', {
      path: await exportSales(source),
    });

    for (const id of [
      'orders.subtotal',
      'customers.big_orders',
      'customers.order_count',
      'customers.orders_total',
    ]) {
      expect(target.row('fields', id)).toMatchObject({
        ctype: 'rollup',
        input_type: 'disabled',
        rollup: source.row('fields', id)?.rollup as Row,
      });
    }
    expect(target.row('fields', 'order_lines.amount')).toMatchObject({
      ctype: 'computed',
    });
    expect(result.entities[0].fields).toEqual({
      created: 4,
      updated: 0,
      unchanged: 3,
    });

    const posted = postedFields(target).map((f) => f.field_name);
    expect(posted.indexOf('customer_id')).toBeLessThan(
      posted.indexOf('order_count'),
    );
    const lastRollup = target.requests.findLastIndex(
      (r) =>
        r.method === 'POST' &&
        r.target === 'fields' &&
        Object.keys(((r.body as Row[])[0].rollup as Row) ?? {}).length > 0,
    );
    const computed = target.requests.findIndex(
      (r) =>
        r.method === 'PATCH' &&
        r.target === 'entities' &&
        'computed_fields' in (r.body as Row),
    );
    expect(lastRollup).toBeLessThan(computed);
  });

  test('a rollup waits for the rollup it reads, through its value field or its filter', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    // The customers come first in the file: the fake refuses 90264 and 90265.
    await call(target, 'import_module', { path: await exportSales(source) });

    const posted = postedFields(target).map((f) => f.field_name);
    expect(posted.indexOf('subtotal')).toBeLessThan(
      posted.indexOf('orders_total'),
    );
    expect(posted.indexOf('subtotal')).toBeLessThan(
      posted.indexOf('big_orders'),
    );
  });

  test('a rollup added to an existing field follows its new link field, its format in the same PATCH', async () => {
    const source = fake('source.example.test');
    seedEntities(source, 'Sales', ['customers', 'orders']);
    source.insert('fields', [
      field('customers.order_count', 'integer', { field_order: 1 }),
    ]);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportSales(source) });

    source.insert('fields', [
      field('orders.customer_id', 'reference', {
        reference_table: 'customers',
        field_order: 1,
      }),
    ]);
    source.update('fields', 'customers.order_count', {
      format: 'int64',
      rollup: COUNT_ORDERS,
    });
    const mark = target.requests.length;
    await call(target, 'import_module', { path: await exportSales(source) });

    const writes = target.writesSince(mark).filter((r) => r.target === 'fields');
    expect(writes.map((r) => r.method)).toEqual(['POST', 'PATCH']);
    expect(writes[1].body).toMatchObject({
      format: 'int64',
      rollup: COUNT_ORDERS,
    });
    expect(target.row('fields', 'customers.order_count')).toMatchObject({
      ctype: 'rollup',
      format: 'int64',
    });
  });

  test('rollup: {} removes a definition on re-import; the field and its values stay', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportSales(source) });

    source.update('fields', 'customers.order_count', { rollup: {} });
    const mark = target.requests.length;
    await call(target, 'import_module', { path: await exportSales(source) });

    const patches = target
      .writesSince(mark)
      .filter((r) => r.method === 'PATCH' && r.target === 'fields');
    expect(patches.map((r) => r.body)).toEqual([{ rollup: {} }]);
    expect(target.row('fields', 'customers.order_count')).toMatchObject({
      ctype: '',
      rollup: {},
      input_type: 'disabled',
    });
    // An ordinary column now, so its value comes from the file.
    expect(target.row('customers', 1)).toMatchObject({ order_count: 1 });
  });

  test('a new ordinary field is POSTed without rollup, a rollup with it and alone, neither with ctype', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportSales(source) });

    const posted = new Map(postedFields(target).map((f) => [f.field_name, f]));
    expect(posted.get('name')).not.toHaveProperty('rollup');
    expect(posted.get('amount')).not.toHaveProperty('rollup');
    expect(posted.get('subtotal')).toHaveProperty('rollup');
    for (const f of posted.values()) expect(f).not.toHaveProperty('ctype');
    for (const request of target.requests) {
      if (request.method !== 'POST' || request.target !== 'fields') continue;
      const body = request.body as Row[];
      if (body.some((f) => 'rollup' in f)) expect(body).toHaveLength(1);
    }
  });

  test('rollup columns are not written, and a target total that differs is not a change', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    await call(target, 'import_module', { path: await exportSales(source) });

    const writes = upserts(target, 'customers').filter((w) =>
      w.columns.includes('name'),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      for (const column of ['big_orders', 'order_count', 'orders_total']) {
        expect(write.columns).not.toContain(column);
      }
    }
    // The file says 1; nothing on the target has aggregated.
    expect(target.row('customers', 1)).toMatchObject({ order_count: 0 });
  });

  test('re-importing an unchanged file with both kinds of field writes nothing', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    const path = await exportSales(source);
    await call(target, 'import_module', { path });

    const mark = target.requests.length;
    const again = await call(target, 'import_module', { path });
    expect(target.writesSince(mark)).toEqual([]);
    expect(again.entities[0].records).toEqual({ written: 0, unchanged: 2 });
  });

  test('the marker without a definition is refused before any request', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const path = await exportSales(source);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    for (const { entity } of doc.entities) {
      for (const f of entity.fields) delete f.rollup;
    }
    await writeFile(path, JSON.stringify(doc));

    const target = emptyTarget();
    const mark = target.requests.length;
    for (const tool of ['import_module', 'import_entities']) {
      const error = await callError(target, tool, { path });
      expect(error).toContain(
        'customers.big_orders: the file marks it as a rollup',
      );
      expect(error).toContain('Export it again');
    }
    expect(target.requests.length).toBe(mark);
  });

  test('a file from before rollups, with no such key, still imports', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const path = await exportCrm(source);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    for (const { entity } of doc.entities) {
      for (const f of entity.fields) delete f.rollup;
    }
    await writeFile(path, JSON.stringify(doc));

    const target = emptyTarget();
    await call(target, 'import_module', { path });
    expect(target.rows('accounts')).toHaveLength(5);
    expect(target.row('fields', 'contacts.email')).toMatchObject({
      rollup: {},
    });
  });

  test('a table a rollup aggregates over is written one batch at a time; any other table is not', async () => {
    const source = fake('source.example.test');
    seedSales(source, { customers: 4100, lines: 4100 });
    const path = await exportSales(source);
    const target = emptyTarget();
    target.latency = 20;
    await call(target, 'import_module', { path });

    expect(target.rows('order_lines')).toHaveLength(4100);
    expect(target.peakWrites.get('order_lines')).toBe(1);
    expect(target.peakWrites.get('customers')).toBeGreaterThan(1);
  });

  test('so is one whose parent is not in the file', async () => {
    const source = fake('source.example.test');
    seedSales(source, { lines: 4100 });
    const target = emptyTarget();
    await call(target, 'import_module', {
      path: await exportSales(source, { exclude_data: true }),
    });
    const parents = join(dir, 'parents.json');
    await call(source, 'export_entities', {
      names: 'customers,orders',
      path: parents,
    });
    await call(target, 'import_entities', { path: parents });

    const lines = join(dir, 'lines.json');
    await call(source, 'export_entities', { names: 'order_lines', path: lines });
    target.latency = 20;
    await call(target, 'import_entities', { path: lines });

    expect(target.rows('order_lines')).toHaveLength(4100);
    expect(target.peakWrites.get('order_lines')).toBe(1);
  });

  test('a deadlock (40P01) on an upsert is replayed', async () => {
    const source = fake('source.example.test');
    seedSales(source);
    const target = emptyTarget();
    let deadlocks = 1;
    target.intercept = (request) => {
      if (
        request.method !== 'POST' ||
        request.target !== 'order_lines' ||
        !deadlocks
      ) {
        return undefined;
      }
      deadlocks--;
      return Response.json(
        { code: '40P01', message: 'deadlock detected' },
        { status: 500 },
      );
    };
    await call(target, 'import_module', { path: await exportSales(source) });

    expect(deadlocks).toBe(0);
    expect(upserts(target, 'order_lines')).toHaveLength(2);
    expect(target.rows('order_lines')).toHaveLength(3);
  });

  test('modules that depend on each other through a rollup are restored by re-running each', async () => {
    const source = fake('source.example.test');
    seedEntities(source, 'Crm', ['customers']);
    seedEntities(source, 'Sales', ['orders']);
    source.insert('fields', [
      field('customers.name', 'text', { field_order: 1 }),
      field('orders.customer_id', 'reference', {
        reference_table: 'customers',
        field_order: 1,
      }),
    ]);
    source.insert('fields', [
      field('customers.order_count', 'int64', {
        field_order: 2,
        rollup: COUNT_ORDERS,
      }),
    ]);
    source.insert('customers', [{ id: 1, name: 'Acme' }]);
    source.insert('orders', [{ id: 1, customer_id: 1 }]);
    const crm = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'Crm', path: crm });
    const sales = join(dir, 'sales.json');
    await call(source, 'export_module', { name: 'Sales', path: sales });

    const target = emptyTarget();
    const first = await callError(target, 'import_module', { path: crm });
    expect(first).toContain(
      'creating rollup field customers.order_count: (90262) Rollup order_count on customers: link_field orders.customer_id must name',
    );
    expect(first).not.toContain('${');
    expect(await callError(target, 'import_module', { path: sales })).toContain(
      '(23503)',
    );
    await call(target, 'import_module', { path: crm });
    await call(target, 'import_module', { path: sales });

    expect(target.row('fields', 'customers.order_count')).toMatchObject({
      ctype: 'rollup',
    });
    expect(target.rows('customers')).toHaveLength(1);
    expect(target.rows('orders')).toHaveLength(1);
  });
});

/**
 * A recruiting module, without records, whose entities are keyed by a TypeID:
 *   candidates (cand): label candidate_name, source (enum)
 *   job_openings (jo): label job_opening_title
 *   applications (appl): label application_name, candidate_id → candidates,
 *     job_opening_id → job_openings (parent), owner_id → users, workflow_state
 *   interviews (int): label interview_name, application_id → applications
 *     (parent), interview_type (enum), rating
 *   candidate_skills: a junction keyed by a number, candidate_id (parent)
 */
function seedRecruiting(f: FakePostgrest) {
  const [module] = f.insert('modules', [
    { module_name: 'Recruiting', module_slug: 'recruiting' },
  ]);
  const typeid = (table: string, prefix: string, label: string) => ({
    table_name: table,
    singular_label: table,
    plural_label: table,
    module_id: module.id,
    label_column: label,
    id_type: 'typeid',
    id_prefix: prefix,
  });
  f.insert('entities', [
    typeid('candidates', 'cand', 'candidate_name'),
    typeid('job_openings', 'jo', 'job_opening_title'),
    typeid('applications', 'appl', 'application_name'),
    typeid('interviews', 'int', 'interview_name'),
    {
      table_name: 'candidate_skills',
      singular_label: 'Skill',
      plural_label: 'Skills',
      module_id: module.id,
      label_column: 'skill',
    },
  ]);
  f.insert('fields', [
    {
      table_name: 'candidates',
      field_name: 'source',
      title: 'Source',
      format: 'enum',
      enum_values: ['referral', { value: 'job_board', label: 'Job board' }],
    },
    {
      table_name: 'applications',
      field_name: 'candidate_id',
      title: 'Candidate',
      format: 'reference',
      reference_table: 'candidates',
    },
    {
      table_name: 'applications',
      field_name: 'job_opening_id',
      title: 'Job opening',
      format: 'parent',
      reference_table: 'job_openings',
    },
    {
      table_name: 'applications',
      field_name: 'owner_id',
      title: 'Owner',
      format: 'reference',
      reference_table: 'users',
    },
    {
      table_name: 'applications',
      field_name: 'workflow_state',
      title: 'State',
      format: 'enum',
      enum_values: ['new', 'interview', 'hired'],
      input_type: 'required',
    },
    {
      table_name: 'interviews',
      field_name: 'application_id',
      title: 'Application',
      format: 'parent',
      reference_table: 'applications',
    },
    {
      table_name: 'interviews',
      field_name: 'interview_type',
      title: 'Type',
      format: 'enum',
      enum_values: ['phone_screen', 'onsite'],
    },
    {
      table_name: 'interviews',
      field_name: 'rating',
      title: 'Rating',
      format: 'rating',
    },
    {
      table_name: 'interviews',
      field_name: 'scheduled_at',
      title: 'Scheduled at',
      format: 'date-time',
    },
    {
      table_name: 'candidate_skills',
      field_name: 'candidate_id',
      title: 'Candidate',
      format: 'parent',
      reference_table: 'candidates',
    },
  ]);
}

/** A records-only file written by hand: table → records. */
async function handWritten(
  name: string,
  tables: Record<string, Row[]>,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    JSON.stringify(
      {
        version: 1,
        entities: Object.entries(tables).map(([table_name, records]) => ({
          entity: { table_name },
          records,
        })),
      },
      null,
      2,
    ),
  );
  return path;
}

const X = (body: string) => body + 'x'.repeat(26 - body.length);

/** A small, sound recruiting file. */
const recruitingRecords = (): Record<string, Row[]> => ({
  candidates: [
    { id: 'cand_sr1', candidate_name: 'Maya Chen', source: 'referral' },
    { id: 'cand_sr2', candidate_name: 'Liam Okafor', source: 'job_board' },
  ],
  job_openings: [{ id: 'jo_sr1', job_opening_title: 'Backend Engineer' }],
  applications: [
    {
      id: 'appl_sr1',
      application_name: 'Maya / Backend',
      candidate_id: 'cand_sr1',
      job_opening_id: 'jo_sr1',
      owner_id: { external_id: 'auth0|alice' },
      workflow_state: 'interview',
    },
    {
      id: 'appl_sr2',
      application_name: 'Liam / Backend',
      candidate_id: 'cand_sr2',
      job_opening_id: 'jo_sr1',
      owner_id: null,
      workflow_state: 'new',
    },
  ],
  interviews: [
    {
      id: 'int_sr1',
      interview_name: 'Phone screen',
      application_id: 'appl_sr1',
      interview_type: 'phone_screen',
      rating: 4,
      scheduled_at: '2026-11-05T14:00:00Z',
    },
  ],
});

describe('import: sample ids', () => {
  test('padSampleId: 0, sr, the number as written, then x up to 26 characters', () => {
    expect(padSampleId('cand_sr1')).toBe(`cand_${X('0sr1')}`);
    expect(padSampleId('cand_sr1')).toBe('cand_0sr1xxxxxxxxxxxxxxxxxxxxxx');
    expect(padSampleId('cand_sr10')).toBe(`cand_${X('0sr10')}`);
    expect(padSampleId('pre_fix_sr2')).toBe(`pre_fix_${X('0sr2')}`);
    // sr1, sr10 and sr100 stay three ids, each a TypeID
    const three = ['cand_sr1', 'cand_sr10', 'cand_sr100'].map(padSampleId);
    expect(new Set(three).size).toBe(3);
    for (const id of three) expect(isTypeId(id)).toBe(true);
    // anything else is left alone
    for (const value of [
      'cand_01h455vb4pex5vsknk084sn02q',
      'cand_sr',
      'cand_sr1a',
      'sr1',
      `cand_sr${'1'.repeat(24)}`,
      7,
      null,
    ]) {
      expect(padSampleId(value)).toBe(value);
    }
    expect(isTypeId('cand_sr1')).toBe(false);
    expect(typeIdPrefix('pre_fix_01h455vb4pex5vsknk084sn02q')).toBe('pre_fix');
  });

  test('a sample id is padded in the key and in every reference to it', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const path = await handWritten('seed.json', {
      ...recruitingRecords(),
      candidate_skills: [
        { id: 1, skill: 'Go', candidate_id: 'cand_sr1' },
        { id: 2, skill: 'SQL', candidate_id: 'cand_sr2' },
      ],
    });
    await call(target, 'import_entities', { path });

    expect(target.rows('candidates').map((r) => r.id)).toEqual([
      `cand_${X('0sr1')}`,
      `cand_${X('0sr2')}`,
    ]);
    const application = target.row('applications', `appl_${X('0sr1')}`);
    expect(application?.candidate_id).toBe(`cand_${X('0sr1')}`);
    expect(application?.job_opening_id).toBe(`jo_${X('0sr1')}`);
    expect(application?.owner_id).toBe(11);
    expect(target.row('interviews', `int_${X('0sr1')}`)?.application_id).toBe(
      `appl_${X('0sr1')}`,
    );
    // a junction keeps its number, and its reference is padded
    expect(target.row('candidate_skills', 2)?.candidate_id).toBe(
      `cand_${X('0sr2')}`,
    );
  });

  test('a full TypeID and a key of another type are written as they are', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const real = 'cand_01h455vb4pex5vsknk084sn02q';
    const path = await handWritten('seed.json', {
      candidates: [{ id: real, candidate_name: 'Ada', source: 'referral' }],
      // skill is text, not a reference: a value that looks like a sample id stays
      candidate_skills: [{ id: 1, skill: 'cand_sr1', candidate_id: real }],
    });
    await call(target, 'import_entities', { path });
    expect(target.rows('candidates').map((r) => r.id)).toEqual([real]);
    expect(target.row('candidate_skills', 1)?.skill).toBe('cand_sr1');
  });

  test('a second import of the same file writes no record', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const path = await handWritten('seed.json', recruitingRecords());
    const first = await call(target, 'import_entities', { path });
    expect(
      first.entities.map((e: Row) => [e.table_name, e.records]),
    ).toEqual([
      ['candidates', { written: 2, unchanged: 0 }],
      ['job_openings', { written: 1, unchanged: 0 }],
      ['applications', { written: 2, unchanged: 0 }],
      ['interviews', { written: 1, unchanged: 0 }],
    ]);
    const mark = target.requests.length;
    const second = await call(target, 'import_entities', { path });
    for (const table of ['candidates', 'applications', 'interviews']) {
      expect(upserts(target, table, mark)).toEqual([]);
    }
    expect(
      second.entities.every((e: Row) => (e.records as Row).written === 0),
    ).toBe(true);
  });

  test('a date-time the target answers in another form is the same instant, not a change', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const path = await handWritten('seed.json', recruitingRecords());
    await call(target, 'import_entities', { path });
    const id = `int_${X('0sr1')}`;
    // PostgREST answers +00:00 where the file says Z
    target.setStored('interviews', id, {
      scheduled_at: '2026-11-05T14:00:00+00:00',
    });
    let mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(upserts(target, 'interviews', mark)).toEqual([]);

    // the same instant in another zone, with and without a fraction
    target.setStored('interviews', id, {
      scheduled_at: '2026-11-05T15:00:00.000000+01',
    });
    mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(upserts(target, 'interviews', mark)).toEqual([]);

    // another instant, one microsecond later, is a change
    target.setStored('interviews', id, {
      scheduled_at: '2026-11-05T14:00:00.000001+00:00',
    });
    mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(upserts(target, 'interviews', mark).map((u) => u.ids)).toEqual([
      [id],
    ]);
  });

  test('a table keyed by a TypeID may reference itself, in any order', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const module = target.rows('modules')[0];
    target.insert('entities', [
      {
        table_name: 'departments',
        singular_label: 'Department',
        plural_label: 'Departments',
        module_id: module.id,
        label_column: 'department_name',
        id_type: 'typeid',
        id_prefix: 'dep',
      },
    ]);
    target.insert('fields', [
      {
        table_name: 'departments',
        field_name: 'parent_department_id',
        title: 'Part of',
        format: 'reference',
        reference_table: 'departments',
      },
    ]);
    const path = await handWritten('seed.json', {
      departments: [
        // the child first: its parent comes later in the file
        {
          id: 'dep_sr2',
          department_name: 'Platform',
          parent_department_id: 'dep_sr1',
        },
        {
          id: 'dep_sr1',
          department_name: 'Engineering',
          parent_department_id: null,
        },
      ],
    });
    expect(
      (await call(target, 'import_entities', { path, check: true })).check,
    ).toBe('passed');
    await call(target, 'import_entities', { path });
    expect(
      target.row('departments', `dep_${X('0sr2')}`)?.parent_department_id,
    ).toBe(`dep_${X('0sr1')}`);
    const mark = target.requests.length;
    await call(target, 'import_entities', { path });
    expect(upserts(target, 'departments', mark)).toEqual([]);
  });

  test('two records that differ only in their id are two records', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const records = recruitingRecords();
    records.interviews.push({ ...records.interviews[0], id: 'int_sr2' });
    await call(target, 'import_entities', {
      path: await handWritten('seed.json', records),
    });
    expect(target.rows('interviews')).toHaveLength(2);
  });
});

describe('import: check', () => {
  test('a sound file passes, nothing is written, and the import then writes it', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const path = await handWritten('seed.json', recruitingRecords());
    const mark = target.requests.length;
    const result = await call(target, 'import_entities', { path, check: true });
    expect(result.check).toBe('passed');
    expect(result.entities).toEqual([
      { table_name: 'candidates', records: 2 },
      { table_name: 'job_openings', records: 1 },
      { table_name: 'applications', records: 2 },
      { table_name: 'interviews', records: 1 },
    ]);
    expect(target.writesSince(mark)).toEqual([]);
    expect(target.rows('candidates')).toEqual([]);

    await call(target, 'import_entities', { path });
    expect(target.rows('applications')).toHaveLength(2);
  });

  test('every problem is listed in one answer, and nothing is written', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const path = await handWritten('seed.json', {
      candidates: [
        { id: 'cand_sr1', candidate_name: 'Maya', source: 'referral', nickname: 'M' },
        { id: 'cand_sr2', candidate_name: '', source: 'Job board', nickname: '' },
        { id: 'cand_sr2', candidate_name: 'Twice', source: 'referral', nickname: '' },
        { id: 'cand_1', candidate_name: 'Short', source: 'referral', nickname: '' },
        { id: 'jo_sr9', candidate_name: 'Prefix', source: 'referral', nickname: '' },
      ],
      job_openings: [{ id: 'jo_sr1', job_opening_title: 'Backend' }],
      applications: [
        {
          id: 'appl_sr1',
          application_name: 'A',
          candidate_id: 'cand_sr7',
          job_opening_id: 'jo_sr1',
          owner_id: { external_id: 'auth0|nobody' },
          workflow_state: 'interview',
        },
        {
          id: 'appl_sr2',
          application_name: 'B',
          candidate_id: 'cand_sr7',
          job_opening_id: null,
          owner_id: 11,
          workflow_state: '',
        },
      ],
      interviews: [
        { id: 'int_sr1', interview_name: 'I', interview_type: 'onsite', rating: 9 },
      ],
      offers: [{ id: 'off_sr1' }],
    });
    const mark = target.requests.length;
    const text = await callError(target, 'import_entities', {
      path,
      check: true,
    });

    expect(text).toContain('nothing was written');
    for (const line of [
      'offers: the table is not on the target, and the file does not define it',
      'candidates.nickname: candidates has no such column',
      'candidates.candidate_name: is required and empty (1 record: cand_sr2)',
      'candidates.source: "Job board" is not one of its values (referral, job_board); write the value "job_board", not the label (1 record: cand_sr2)',
      'candidates.id: is the id of more than one record (1 record: cand_sr2)',
      'candidates.id: is not a TypeID',
      'candidates.id: does not carry the prefix cand of candidates (1 record: jo_sr9)',
      // one cause, one line, both records
      'applications.candidate_id: names cand_sr7, which is no record of candidates in the file or on the target (2 records: appl_sr1, appl_sr2)',
      'applications.job_opening_id: is null; a parent field always names a record (1 record: appl_sr2)',
      'applications.owner_id: no user with external_id "auth0|nobody" on the target (1 record: appl_sr1)',
      'applications.owner_id: 11 is not {"external_id": …}, which a reference to a user takes (1 record: appl_sr2)',
      'applications.workflow_state: is required and empty (1 record: appl_sr2)',
      'interviews.application_id: is a parent field and the records do not carry it',
      'interviews.rating: 9 is not a rating from 0 to 5 (1 record: int_sr1)',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/the check found 14 problems/);
    expect(target.writesSince(mark)).toEqual([]);
    expect(target.rows('candidates')).toEqual([]);
  });

  test('a bad value in a record does not make the records that name it fail', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const records = recruitingRecords();
    records.candidates[0].source = 'agency';
    const text = await callError(target, 'import_entities', {
      path: await handWritten('seed.json', records),
      check: true,
    });
    expect(text).toMatch(/the check found 1 problem /);
    expect(text).toContain('candidates.source: "agency" is not one of its values');
  });

  test('a reference to a record already on the target passes', async () => {
    const target = emptyTarget();
    seedRecruiting(target);
    const existing = 'cand_01h455vb4pex5vsknk084sn02q';
    target.insert('candidates', [
      { id: existing, candidate_name: 'Already here', source: 'referral' },
    ]);
    const records = recruitingRecords();
    records.applications[0].candidate_id = existing;
    const result = await call(target, 'import_entities', {
      path: await handWritten('seed.json', records),
      check: true,
    });
    expect(result.check).toBe('passed');
  });

  test('a file that defines its tables is checked against that definition', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    const target = emptyTarget();
    const path = join(dir, 'crm.json');
    await call(source, 'export_module', { name: 'CRM', path });
    const mark = target.requests.length;
    const result = await call(target, 'import_entities', { path, check: true });
    expect(result.check).toBe('passed');
    expect(result.entities).toEqual([
      { table_name: 'accounts', records: 5 },
      { table_name: 'contacts', records: 2 },
    ]);
    expect(target.writesSince(mark)).toEqual([]);
  });

});

/**
 * A family: business_partners (bp, label partner_name, city), persons is_a
 * business_partners (per; birth_date), customers has_a business_partners
 * (tier, an enum), and orders that reference a business partner.
 */
function seedFamily(f: FakePostgrest) {
  const [module] = f.insert('modules', [
    { module_name: 'Partners', module_slug: 'partners' },
  ]);
  const entity = (table: string, more: Row) => ({
    table_name: table,
    singular_label: table,
    plural_label: table,
    module_id: module.id,
    ...more,
  });
  f.insert('entities', [
    entity('business_partners', {
      label_column: 'partner_name',
      id_type: 'typeid',
      id_prefix: 'bp',
    }),
    entity('orders', {
      label_column: 'order_name',
      id_type: 'typeid',
      id_prefix: 'ord',
    }),
  ]);
  f.insert('entities', [
    entity('persons', {
      id_type: 'is_a',
      id_prefix: 'per',
      id_refentity: 'business_partners',
    }),
    entity('customers', {
      id_type: 'has_a',
      id_refentity: 'business_partners',
    }),
  ]);
  f.insert('fields', [
    {
      table_name: 'business_partners',
      field_name: 'city',
      title: 'City',
      format: 'text',
    },
    {
      table_name: 'persons',
      field_name: 'birth_date',
      title: 'Born',
      format: 'date',
    },
    {
      table_name: 'customers',
      field_name: 'tier',
      title: 'Tier',
      format: 'enum',
      enum_values: ['silver', 'gold'],
    },
    {
      table_name: 'orders',
      field_name: 'partner_id',
      title: 'Partner',
      format: 'reference',
      reference_table: 'business_partners',
    },
  ]);
}

const familyRecords = (): Record<string, Row[]> => ({
  // listed first on purpose: an extension is written after its base record
  customers: [{ id: 'bp_sr1', tier: 'gold' }],
  orders: [
    { id: 'ord_sr1', order_name: 'First', partner_id: 'bp_sr1' },
    // a relationship to the base may name a subtype's record
    { id: 'ord_sr2', order_name: 'Second', partner_id: 'per_sr1' },
  ],
  persons: [
    {
      id: 'per_sr1',
      partner_name: 'Ada Lovelace',
      city: 'London',
      birth_date: '1990-12-10',
    },
  ],
  business_partners: [{ id: 'bp_sr1', partner_name: 'Acme', city: 'Berlin' }],
});

/** The writes to a table since `from`: method, upsert or not, and the ids or filter. */
function writesTo(f: FakePostgrest, table: string, from = 0) {
  return f
    .writesSince(from)
    .filter((r) => r.target === table)
    .map((r) => ({
      method: r.method,
      upsert: r.url.searchParams.has('on_conflict'),
      body: r.body,
    }));
}

describe('import: entities based on another (is_a, has_a)', () => {
  test('new records are inserted, never upserted: a subtype whole, an extension after its base', async () => {
    const target = emptyTarget();
    seedFamily(target);
    const path = await handWritten('family.json', familyRecords());
    expect(
      (await call(target, 'import_entities', { path, check: true })).check,
    ).toBe('passed');
    await call(target, 'import_entities', { path });

    // the fake refuses an upsert on a based entity with 42P10, as the platform does
    expect(writesTo(target, 'persons')).toEqual([
      {
        method: 'POST',
        upsert: false,
        body: [
          {
            id: `per_${X('0sr1')}`,
            partner_name: 'Ada Lovelace',
            city: 'London',
            birth_date: '1990-12-10',
          },
        ],
      },
    ]);
    expect(writesTo(target, 'customers')).toEqual([
      {
        method: 'POST',
        upsert: false,
        body: [{ id: `bp_${X('0sr1')}`, tier: 'gold' }],
      },
    ]);
    const firstWrite = (table: string) =>
      target.requests.findIndex(
        (r) => r.method !== 'GET' && r.target === table,
      );
    expect(firstWrite('business_partners')).toBeGreaterThan(-1);
    expect(firstWrite('business_partners')).toBeLessThan(
      firstWrite('customers'),
    );
    expect(target.row('orders', `ord_${X('0sr2')}`)?.partner_id).toBe(
      `per_${X('0sr1')}`,
    );
  });

  test('a second import writes nothing; a changed value is one PATCH of that column', async () => {
    const target = emptyTarget();
    seedFamily(target);
    const records = familyRecords();
    await call(target, 'import_entities', {
      path: await handWritten('family.json', records),
    });
    let mark = target.requests.length;
    await call(target, 'import_entities', {
      path: await handWritten('family.json', records),
    });
    expect(writesTo(target, 'persons', mark)).toEqual([]);
    expect(writesTo(target, 'customers', mark)).toEqual([]);

    records.customers[0].tier = 'silver';
    records.persons[0].city = 'Paris';
    mark = target.requests.length;
    await call(target, 'import_entities', {
      path: await handWritten('family.json', records),
    });
    expect(writesTo(target, 'customers', mark)).toEqual([
      { method: 'PATCH', upsert: false, body: { tier: 'silver' } },
    ]);
    expect(writesTo(target, 'persons', mark)).toEqual([
      { method: 'PATCH', upsert: false, body: { city: 'Paris' } },
    ]);
    expect(target.row('persons', `per_${X('0sr1')}`)?.city).toBe('Paris');
  });

  test("a subtype's record listed under its base is written at the subtype only", async () => {
    const target = emptyTarget();
    seedFamily(target);
    // as an export writes a family: a read of the base lists the person too
    const records = familyRecords();
    records.business_partners.push({
      id: 'per_sr1',
      partner_name: 'Ada Lovelace',
      city: 'London',
    });
    const path = await handWritten('family.json', records);
    expect(
      (await call(target, 'import_entities', { path, check: true })).check,
    ).toBe('passed');
    const result = await call(target, 'import_entities', { path });
    expect(target.rows('business_partners').map((r) => r.id)).toEqual([
      `bp_${X('0sr1')}`,
    ]);
    expect(target.rows('persons')).toHaveLength(1);
    expect(
      result.entities.find((e: Row) => e.table_name === 'business_partners')
        .records,
    ).toEqual({ written: 1, unchanged: 0, left_to_subtypes: 1 });

    // without the subtype's records, the record has nowhere to be written
    records.persons = [];
    records.orders.pop();
    const alone = await handWritten('alone.json', records);
    const wanted =
      'is a record of persons, and the file carries no records of persons';
    expect(
      await callError(target, 'import_entities', { path: alone, check: true }),
    ).toContain(`business_partners.id: ${wanted}`);
    expect(
      await callError(target, 'import_entities', { path: alone }),
    ).toContain(wanted);
  });

  test('the check lists a family record that cannot be written', async () => {
    const target = emptyTarget();
    seedFamily(target);
    const text = await callError(target, 'import_entities', {
      path: await handWritten('family.json', {
        business_partners: [{ id: 'bp_sr1', partner_name: 'Acme', city: '' }],
        persons: [
          // the prefix of the base, not of the subtype
          { id: 'bp_sr2', partner_name: 'Ada', city: '', birth_date: 'soon' },
        ],
        customers: [
          { id: 'bp_sr1', tier: 'Gold' },
          // no such base record
          { id: 'bp_sr9', tier: 'gold' },
        ],
      }),
      check: true,
    });
    for (const line of [
      'persons.id: does not carry the prefix per of persons (1 record: bp_sr2)',
      'persons.birth_date: "soon" is not a date such as 2026-09-15 (1 record: bp_sr2)',
      'customers.tier: "Gold" is not one of its values (silver, gold); did you mean "gold"? (1 record: bp_sr1)',
      'customers.id: names bp_sr9, which is no record of business_partners in the file or on the target (1 record: bp_sr9)',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/the check found 4 problems/);
  });
});

describe('call timeout', () => {
  test('a run longer than SEMANTIUS_TIMEOUT completes while it makes progress', async () => {
    const source = fake('source.example.test');
    seedCrm(source, { accounts: 2500 });
    process.env.SEMANTIUS_TIMEOUT = '1';
    // Well over a second in total, every answer within it.
    source.latency = 150;
    const started = Date.now();
    const result = await call(source, 'export_entities', {
      names: 'accounts',
      path: join(dir, 'slow.json'),
    });
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(result.entities[0].records).toBe(2505);
  });

  test('a host that stops answering still times out', async () => {
    const source = fake('source.example.test');
    seedCrm(source);
    process.env.SEMANTIUS_TIMEOUT = '1';
    source.latency = 1500;
    await expect(
      callRaw(source, 'export_entities', {
        names: 'accounts',
        path: join(dir, 'stalled.json'),
      }),
    ).rejects.toThrow('timed out');
    // Let the request in flight settle before the fetch stub goes away.
    await Bun.sleep(700);
    expect(await exists(join(dir, 'stalled.json'))).toBe(false);
  });
});

describe('write order', () => {
  const ref = (
    table: string,
    column: string,
    target: string,
    format: 'reference' | 'parent' = 'reference',
  ) => ({ table, column, target, format });

  test('referenced tables first, ties in the given order, outside tables ignored', () => {
    const plan = planWrites(
      ['c', 'b', 'a'],
      [
        ref('c', 'b_id', 'b'),
        ref('b', 'a_id', 'a'),
        ref('c', 'owner_id', 'users'),
      ],
    );
    expect(plan.steps).toEqual([
      { table: 'a', pass: 1 },
      { table: 'b', pass: 1 },
      { table: 'c', pass: 1 },
    ]);
  });

  test('a cycle is broken at a reference column, never a parent one', () => {
    const plan = planWrites(
      ['a', 'b'],
      [ref('a', 'b_id', 'b', 'parent'), ref('b', 'a_id', 'a')],
    );
    expect(plan.deferred).toEqual(new Map([['b', ['a_id']]]));
    expect(plan.steps).toEqual([
      { table: 'b', pass: 1 },
      { table: 'a', pass: 1 },
      { table: 'b', pass: 2 },
    ]);
  });

  test('a cycle of parent columns only is refused', () => {
    expect(() =>
      planWrites(
        ['a', 'b'],
        [ref('a', 'b_id', 'b', 'parent'), ref('b', 'a_id', 'a', 'parent')],
      ),
    ).toThrow('only through parent columns');
  });

  test('self references are resolved per batch, not planned', () => {
    const plan = planWrites(['t'], [ref('t', 'parent_id', 't')]);
    expect(plan.steps).toEqual([{ table: 't', pass: 1 }]);
    expect(plan.selfReferences.get('t')).toEqual([ref('t', 'parent_id', 't')]);
  });

  const nowhere = () => false;

  test('within a batch rows may point at each other; a reference to a later batch is nulled for a relink', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't')]);
    const rows = [
      { id: 1, p: 2 },
      { id: 2, p: 1 },
      { id: 3, p: 9 },
      { id: 4, p: null },
    ];
    const high = self.observe(rows);
    expect(high).toBe(4);
    expect(self.unknownParents(rows, high)).toEqual([9]);
    // Parent-first where it can be; the 1 ↔ 2 cycle keeps file order, last.
    expect(self.split(rows, high, nowhere)).toEqual([
      { id: 3, p: null },
      { id: 4, p: null },
      { id: 1, p: 2 },
      { id: 2, p: 1 },
    ]);
    expect(self.relink).toBe(true);
    expect(self.size).toBe(0);
  });

  test('a later parent already on the target needs nothing', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't')]);
    const rows = [{ id: 1, p: 9 }];
    const high = self.observe(rows);
    expect(self.split(rows, high, (id) => id === 9)).toEqual(rows);
    expect(self.relink).toBe(false);
  });

  test('a later parent through a parent column holds the row, and the rows that then miss it', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't', 'parent')]);
    const first = [
      { id: 1, p: 5 },
      { id: 2, p: 1 },
      { id: 3, p: 3 },
    ];
    const high = self.observe(first);
    expect(self.split(first, high, nowhere)).toEqual([{ id: 3, p: 3 }]);
    expect(self.size).toBe(2);
    // A later batch that points at a held row waits too.
    const second = [
      { id: 4, p: 2 },
      { id: 5, p: null },
    ];
    expect(self.unknownParents(second, self.observe(second))).toEqual([2]);
    expect(self.split(second, 5, nowhere)).toEqual([{ id: 5, p: null }]);
    // Parent-first: 1 (its parent 5 is written), then 2, then 4.
    expect(self.drain(2)).toEqual([
      [
        { id: 1, p: 5 },
        { id: 2, p: 1 },
      ],
      [{ id: 4, p: 2 }],
    ]);
    expect(self.relink).toBe(false);
  });

  test('held rows in a parent cycle go last, in one statement', () => {
    const self = new SelfReferences('t', 'id', [
      ref('t', 'p', 't', 'parent'),
      ref('t', 'r', 't'),
    ]);
    const rows = [
      { id: 1, p: 8, r: null },
      { id: 2, p: 2, r: 9 },
    ];
    self.split(rows, self.observe(rows), nowhere);
    const later = [
      { id: 8, p: 9, r: null },
      { id: 9, p: 8, r: null },
    ];
    // 8 and 9 point at each other in one batch: written at once.
    expect(self.split(later, self.observe(later), nowhere)).toEqual(later);
    expect(self.size).toBe(1);
    expect(self.drain(10)).toEqual([[{ id: 1, p: 8, r: null }]]);
  });

  test('a held parent cycle is one statement; the rows below it follow in chunks', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't', 'parent')]);
    const first = [
      { id: 1, p: 3000 },
      { id: 2, p: 1 },
    ];
    expect(self.split(first, self.observe(first), nowhere)).toEqual([]);
    const second = [
      { id: 3000, p: 1 },
      { id: 3001, p: 3000 },
    ];
    expect(self.split(second, self.observe(second), nowhere)).toEqual([]);
    expect(self.drain(10)).toEqual([
      [
        { id: 1, p: 3000 },
        { id: 3000, p: 1 },
      ],
      [
        { id: 2, p: 1 },
        { id: 3001, p: 3000 },
      ],
    ]);
  });

  test('records with a number as key out of id order, or mixing key types, are refused', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't')]);
    self.observe([{ id: 2, p: null }]);
    expect(() => self.observe([{ id: 1, p: null }])).toThrow(
      'not in ascending id order',
    );
    expect(() => self.observe([{ id: 'a', p: null }])).toThrow(
      'is not a number',
    );
    const text = new SelfReferences('t', 'id', [ref('t', 'p', 't')]);
    text.observe([{ id: 'b', p: null }]);
    expect(() => text.observe([{ id: 3, p: null }])).toThrow(
      'is a number, the records before it are not',
    );
  });

  test('with a key that is not a number, later means not met yet', () => {
    const self = new SelfReferences('t', 'id', [
      ref('t', 'p', 't', 'parent'),
      ref('t', 'r', 't'),
    ]);
    // any order: a TypeID has none to read
    const batch = [
      { id: 'c', p: 'z', r: null }, // parent z comes in a later batch
      { id: 'a', p: null, r: 'y' }, // reference y comes in a later batch
      { id: 'b', p: 'a', r: 'c' }, // parent in this batch; c is held back
      { id: 'd', p: 'a', r: 'a' }, // both in this batch
    ];
    const high = self.observe(batch);
    expect(self.unknownParents(batch, high).sort()).toEqual(['y', 'z']);
    const written = self.split(batch, high, () => false);
    expect(written.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
    expect(written.find((r) => r.id === 'a')?.r).toBeNull();
    expect(written.find((r) => r.id === 'b')?.r).toBeNull();
    expect(written.find((r) => r.id === 'd')?.r).toBe('a');
    expect(self.relink).toBe(true);
    expect(self.size).toBe(1);
  });
});

describe('rollup order', () => {
  const rollup = (id: string, definition: unknown) => {
    const [table, field_name] = id.split('.');
    return { table, field: { field_name, rollup: definition } };
  };
  const ids = (list: ReturnType<typeof rollup>[]) =>
    orderRollups(list).map((r) => `${r.table}.${r.field.field_name}`);

  const sum = (link_field: string, value_field: string) => ({
    link_field,
    function: 'sum',
    value_field,
  });

  test('a rollup follows the one its value field names, on the link entity only', () => {
    expect(
      ids([
        rollup('customers.total', sum('orders.customer_id', 'subtotal')),
        rollup('orders.subtotal', sum('lines.order_id', 'amount')),
      ]),
    ).toEqual(['orders.subtotal', 'customers.total']);
    // Same field name, another entity: no dependency.
    expect(
      ids([
        rollup('customers.total', sum('orders.customer_id', 'subtotal')),
        rollup('invoices.subtotal', sum('lines.invoice_id', 'amount')),
      ]),
    ).toEqual(['customers.total', 'invoices.subtotal']);
  });

  test('a rollup follows any rollup a var of its filter names, at any depth', () => {
    const filter = {
      and: [{ '>': [{ var: 'subtotal' }, 100] }, { '!': { var: 'closed' } }],
    };
    expect(
      ids([
        rollup('customers.big', {
          link_field: 'orders.customer_id',
          function: 'count',
          filter,
        }),
        rollup('orders.subtotal', sum('lines.order_id', 'amount')),
      ]),
    ).toEqual(['orders.subtotal', 'customers.big']);
  });

  test('otherwise the order given', () => {
    const count = { link_field: 'orders.customer_id', function: 'count' };
    expect(
      ids([rollup('z.a', count), rollup('a.z', count), rollup('m.m', count)]),
    ).toEqual(['z.a', 'a.z', 'm.m']);
    expect(ids([])).toEqual([]);
  });

  test('a chain sorts through every level', () => {
    expect(
      ids([
        rollup('a.total', sum('b.a_id', 'total')),
        rollup('b.total', sum('c.b_id', 'total')),
        rollup('c.total', sum('d.c_id', 'amount')),
      ]),
    ).toEqual(['c.total', 'b.total', 'a.total']);
  });

  test('a cycle, and what waits behind it, keeps the order given for the platform to refuse', () => {
    expect(
      ids([
        rollup('c.total', sum('a.c_id', 'total')),
        rollup('a.total', sum('b.a_id', 'total')),
        rollup('b.total', sum('a.b_id', 'total')),
      ]),
    ).toEqual(['c.total', 'a.total', 'b.total']);
  });

  test('a field that sums itself does not wait for itself', () => {
    expect(ids([rollup('t.total', sum('t.parent_id', 'total'))])).toEqual([
      't.total',
    ]);
  });

  test('a malformed link_field keeps the order given, for the platform to refuse', () => {
    expect(
      ids([
        rollup('a.x', { link_field: 'nodot', value_field: 'y' }),
        rollup('a.y', { link_field: 42, value_field: 'x' }),
        rollup('a.z', { link_field: '.x', value_field: 'y' }),
      ]),
    ).toEqual(['a.x', 'a.y', 'a.z']);
  });
});
