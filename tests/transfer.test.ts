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
import { setEnvPrefix, setHostFlag } from '../src/config';
import { resolveHost } from '../src/host';
import { setHostsIndexDirForTests } from '../src/hosts-index';
import { createBuiltinConnection } from '../src/local-tools/connection';
import { exportEntities } from '../src/local-tools/transfer/export';
import { ENTITY_CREATE_ONLY } from '../src/local-tools/transfer/format';
import { SelfReferences, planWrites } from '../src/local-tools/transfer/graph';
import { PostgrestClient } from '../src/local-tools/transfer/postgrest';
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
  // Per CLAUDE.md: a real current host in hosts.json would win over
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

  test('records out of id order, or with ids that are not numbers, are refused', () => {
    const self = new SelfReferences('t', 'id', [ref('t', 'p', 't')]);
    self.observe([{ id: 2, p: null }]);
    expect(() => self.observe([{ id: 1, p: null }])).toThrow(
      'not in ascending id order',
    );
    expect(() =>
      new SelfReferences('t', 'id', [ref('t', 'p', 't')]).observe([
        { id: 'a', p: null },
      ]),
    ).toThrow('is not a number');
  });
});
