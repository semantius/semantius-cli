/**
 * An in-memory PostgREST for the transfer tests (tests/transfer.test.ts),
 * behind a fetch stub. It covers what the transfer tools send and imitates
 * the platform where they depend on it:
 *
 *   - select / eq / neq / in / gt / gte / lt / lte / order / limit, with every
 *     read capped at `maxRows` rows (db-max-rows);
 *   - POST with columns= and missing=default, upsert through on_conflict +
 *     resolution=merge-duplicates, PATCH; PGRST102 for an array body whose
 *     objects differ in keys without columns=;
 *   - each request is one statement: foreign keys, NOT NULL on parent
 *     columns and validation rules are checked at its end, and a failure
 *     rolls the whole statement back;
 *   - POST /entities creates the table and its core fields (id, label,
 *     created_at / updated_at); data rows get audit timestamps and computed
 *     columns (a small JsonLogic subset);
 *   - serial ids whose sequence does not advance past an explicit id;
 *   - /rpc/get_userinfo in the platform's shape ({user_id, …}) and
 *     /rpc/fix_id_sequence (ok, missing = PGRST202, denied = 42501, null,
 *     and `busy` answers of 90232 first);
 *   - the self-hosted API-key exchange (GET /api/auth/token) and 401 for
 *     tokens marked `rejected`, for the token refresh.
 */

export type Row = Record<string, unknown>;

export interface Captured {
  method: string;
  url: URL;
  /** The table or rpc/<name>. */
  target: string;
  body: unknown;
  prefer?: string;
}

export interface FakeOptions {
  /** db-max-rows: no read returns more rows. */
  maxRows?: number;
  fixIdSequence?: 'ok' | 'missing' | 'denied' | 'null';
  /** The id get_userinfo reports. */
  userId?: number;
}

interface ForeignKey {
  column: string;
  table: string;
}

interface TableDef {
  key: string;
  serial?: boolean;
  generated?: (row: Row) => string;
  unique?: string[];
  defaults?: (row: Row) => Row;
  foreign?: ForeignKey[];
  /** A data table (created by POST /entities). */
  data?: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Row,
  ) {
    super(String(body.message));
  }
}

function fail(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
  hint: string | null = null,
): HttpError {
  return new HttpError(status, { code, message, details, hint });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A tiny JsonLogic: var, ==, !=, !, and, or, +, *, cat, and
 * get [table, id, column] — another row as the trigger sees it (like
 * set_record: rows inserted earlier in the statement, never later ones).
 */
export function evaluate(
  rule: unknown,
  data: Row,
  lookup?: (table: string, id: unknown) => Row | undefined,
): unknown {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    return rule;
  }
  const [op, raw] = Object.entries(rule as Row)[0];
  const args = (Array.isArray(raw) ? raw : [raw]).map((a) =>
    evaluate(a, data, lookup),
  );
  switch (op) {
    case 'get':
      return lookup?.(String(args[0]), args[1])?.[String(args[2])] ?? null;
    case 'var':
      return data[String(args[0])] ?? null;
    case '==':
      return args[0] === args[1];
    case '!=':
      return args[0] !== args[1];
    case '!':
      return !args[0];
    case 'and':
      return args.every(Boolean);
    case 'or':
      return args.some(Boolean);
    case '+':
      return args.reduce((s: number, a) => s + Number(a), 0);
    case '*':
      return args.reduce((s: number, a) => s * Number(a), 1);
    case 'cat':
      return args.map((a) => a ?? '').join('');
    default:
      throw new Error(`fake JsonLogic: unsupported operator ${op}`);
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/** A filter value in the type of the column's value. */
function coerce(sample: unknown, text: string): unknown {
  if (typeof sample === 'number') return Number(text);
  if (typeof sample === 'boolean') return text === 'true';
  return text;
}

/** `(a,"b,c",d)` → ['a', 'b,c', 'd']. */
function parseList(text: string): string[] {
  const inner = text.replace(/^\(/, '').replace(/\)$/, '');
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '\\') current += inner[++i];
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      out.push(current);
      current = '';
      wasQuoted = false;
    } else {
      current += ch;
    }
  }
  if (current || wasQuoted || out.length) out.push(current);
  return out;
}

interface Filter {
  column: string;
  op: string;
  value: string;
  list?: string[];
}

const RESERVED = new Set([
  'select',
  'order',
  'limit',
  'offset',
  'columns',
  'on_conflict',
]);

function splitColumns(text: string | null): string[] | undefined {
  if (text === null) return undefined;
  return parseList(`(${text})`);
}

export class FakePostgrest {
  readonly requests: Captured[] = [];
  /** Answer a request instead of the fake (failure injection). */
  intercept?: (request: Captured) => Response | undefined;
  /** Milliseconds every request takes. */
  latency = 0;
  /** fix_id_sequence answers 90232 (table busy) this many times first. */
  busy = 0;
  /** Bearer tokens GET /api/auth/token issued for an x-api-key, in order. */
  readonly issued: string[] = [];
  /** Tokens the fake answers with 401. */
  readonly rejected = new Set<string>();
  maxRows: number;
  fixIdSequence: NonNullable<FakeOptions['fixIdSequence']>;
  readonly userId: number;

  private readonly defs = new Map<string, TableDef>();
  private readonly store = new Map<string, Map<string, Row>>();
  private readonly sequences = new Map<string, number>();
  private readonly sorted = new Map<string, number[]>();
  private tick = 0;

  constructor(
    readonly host: string,
    options: FakeOptions = {},
  ) {
    this.maxRows = options.maxRows ?? 1000;
    this.fixIdSequence = options.fixIdSequence ?? 'ok';
    this.userId = options.userId ?? 1;

    this.define('modules', {
      key: 'id',
      serial: true,
      unique: ['module_name', 'module_slug'],
      foreign: [
        { column: 'view_permission', table: 'permissions' },
        { column: 'manage_permission', table: 'permissions' },
        { column: 'admin_permission', table: 'permissions' },
        { column: 'default_viewer_role_id', table: 'roles' },
        { column: 'default_manager_role_id', table: 'roles' },
        { column: 'default_admin_role_id', table: 'roles' },
      ],
      defaults: () => ({
        description: '',
        module_type: 'domain',
        view_permission: 'user:read',
        manage_permission: null,
        admin_permission: null,
        default_viewer_role_id: null,
        default_manager_role_id: null,
        default_admin_role_id: null,
        logo_color: '',
        icon_name: '',
        home_page: '',
        settings: {},
        dashboard_config: {},
        catalog_module_code: '',
        domain_code: '',
        access_scope: 'basic',
      }),
    });
    this.define('permissions', {
      key: 'permission_name',
      foreign: [{ column: 'module_id', table: 'modules' }],
      defaults: () => ({ description: '', module_id: null }),
    });
    this.define('permission_hierarchy', {
      key: 'id',
      generated: (r) =>
        `${r.including_permission_name}.${r.included_permission_name}`,
      foreign: [
        { column: 'including_permission_name', table: 'permissions' },
        { column: 'included_permission_name', table: 'permissions' },
      ],
      defaults: () => ({ origin: 'user' }),
    });
    this.define('roles', {
      key: 'id',
      serial: true,
      unique: ['slug', 'role_name'],
      foreign: [{ column: 'module_id', table: 'modules' }],
      defaults: (r) => ({
        slug: String(r.role_name ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_'),
        description: '',
        origin: 'user',
        module_id: null,
        catalog_role_code: '',
      }),
    });
    this.define('role_permissions', {
      key: 'id',
      generated: (r) => `${r.role_id}.${r.permission_name}`,
      foreign: [
        { column: 'role_id', table: 'roles' },
        { column: 'permission_name', table: 'permissions' },
      ],
      defaults: () => ({ granted_at: this.now(), granted_by: null }),
    });
    this.define('entities', {
      key: 'table_name',
      foreign: [
        { column: 'module_id', table: 'modules' },
        { column: 'view_permission', table: 'permissions' },
        { column: 'edit_permission', table: 'permissions' },
      ],
      defaults: (r) => ({
        singular: '',
        plural: r.table_name,
        plural_label: '',
        icon_url: '',
        description: '',
        view_permission: 'user:read',
        edit_permission: 'user:read',
        id_column: 'id',
        label_column: '',
        label_parent: '',
        order_column: '',
        managed: true,
        searchable: false,
        is_child: false,
        edit_mode: 'auto',
        cube_mode: 'auto',
        audit_log: false,
        computed_fields: [],
        validation_rules: [],
        select_rule: {},
        entity_type: 'unclassified',
        catalog_entity_code: '',
        catalog_owner_module: '',
        catalog_entity_aliases: [],
      }),
    });
    this.define('fields', {
      key: 'id',
      generated: (r) => `${r.table_name}.${r.field_name}`,
      foreign: [{ column: 'table_name', table: 'entities' }],
      defaults: () => ({
        description: '',
        format: 'text',
        is_pk: false,
        default_value: '',
        field_order: 0,
        input_type: 'default',
        width: 'default',
        ctype: '',
        searchable: false,
        enum_values: null,
        reference_table: '',
        reference_delete_mode: '',
        relationship_label: '',
        singular_label_parent: '',
        plural_label_parent: '',
        precision: 2,
        unique_value: false,
        cube_type: 'auto',
        input_type_rule: {},
        catalog_field_code: '',
      }),
    });
    this.define('users', {
      key: 'id',
      serial: true,
      unique: ['external_id'],
      defaults: () => ({ display_name: '', is_disabled: false }),
    });
    this.insert('permissions', [
      { permission_name: 'user:read', description: 'Signed-in users' },
      { permission_name: 'admin', description: 'Administrators' },
    ]);
  }

  get postgrestUrl(): string {
    return `https://${this.host}/rest`;
  }

  // ------------------------------------------------------------ test API

  /** Insert rows as one statement (platform triggers apply); returns copies. */
  insert(table: string, rows: Row[]): Row[] {
    return this.statement(() => {
      const out: Row[] = [];
      for (const row of rows) out.push(this.insertRow(table, { ...row }));
      return out;
    }).map((r) => structuredClone(r));
  }

  /** Update one row by its key. */
  update(table: string, key: unknown, changes: Row): void {
    this.statement(() => {
      const row = this.tableOf(table).get(String(key));
      if (!row) throw new Error(`fake: no ${table} row ${key}`);
      this.updateRow(table, row, changes);
      return [row];
    });
  }

  /** The rows of a table, ordered by key; copies. */
  rows(table: string): Row[] {
    const def = this.defOf(table);
    return [...this.tableOf(table).values()]
      .sort((a, b) => compare(a[def.key], b[def.key]))
      .map((r) => structuredClone(r));
  }

  row(table: string, key: unknown): Row | undefined {
    const row = this.tableOf(table).get(String(key));
    return row && structuredClone(row);
  }

  /** The requests since `from` (an index into requests) that write. */
  writesSince(from = 0): Captured[] {
    return this.requests.slice(from).filter((r) => r.method !== 'GET');
  }

  // --------------------------------------------------------------- HTTP

  async handle(url: URL, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === 'string' && init.body
        ? JSON.parse(init.body)
        : undefined;
    const target = decodeURIComponent(url.pathname.replace(/^\/rest\//, ''));
    const captured: Captured = {
      method,
      url,
      target,
      body,
      prefer: headers.get('prefer') ?? undefined,
    };
    this.requests.push(captured);
    if (this.latency) await Bun.sleep(this.latency);
    const intercepted = this.intercept?.(captured);
    if (intercepted) return intercepted;
    if (url.pathname === '/api/auth/token' && headers.get('x-api-key')) {
      // The self-hosted API-key exchange: a fresh JWT each time.
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `${b64({ alg: 'none' })}.${b64({ exp, n: this.issued.length })}.sig`;
      this.issued.push(token);
      return json({ access_token: token, expires_in: 3600 });
    }
    if (!url.pathname.startsWith('/rest/')) {
      return new Response('<html>not found</html>', { status: 404 });
    }
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    if (bearer && this.rejected.has(bearer)) {
      return json({ code: 'PGRST301', message: 'JWT expired' }, 401);
    }
    try {
      if (target.startsWith('rpc/')) return this.rpc(target.slice(4), body);
      if (!this.defs.has(target)) {
        throw fail(
          404,
          'PGRST205',
          `Could not find the table 'public.${target}' in the schema cache`,
        );
      }
      if (method === 'GET') return this.get(target, url);
      if (method === 'POST')
        return this.post(target, url, body, captured.prefer);
      if (method === 'PATCH')
        return this.patch(target, url, body, captured.prefer);
      throw fail(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
    } catch (error) {
      if (error instanceof HttpError) return json(error.body, error.status);
      throw error;
    }
  }

  private get(table: string, url: URL): Response {
    const params = url.searchParams;
    const filters = this.filtersOf(params);
    const def = this.defOf(table);
    const orderParam = params.get('order');
    const [orderColumn, direction] = orderParam
      ? orderParam.split('.')
      : [undefined, undefined];
    const limit = Math.min(
      params.has('limit')
        ? Number(params.get('limit'))
        : Number.POSITIVE_INFINITY,
      this.maxRows,
    );
    const select = splitColumns(params.get('select'));
    this.checkColumns(table, [
      ...(select?.filter((c) => c !== '*') ?? []),
      ...filters.map((f) => f.column),
    ]);

    let rows: Row[];
    const keyIn = filters.find((f) => f.column === def.key && f.op === 'in');
    const range = def.data ? keyRange(filters, def.key) : undefined;
    if (range && range.high - range.low <= 100_000 && !keyIn) {
      // A bounded id range on a data table: look the ids up directly.
      rows = [];
      const map = this.tableOf(table);
      for (let id = range.low; id <= range.high && rows.length < limit; id++) {
        const row = map.get(String(id));
        if (row && filters.every((f) => this.matches(row, f))) rows.push(row);
      }
      return json(rows.map((r) => this.project(r, select)));
    }
    const numericKeys = this.sortedKeys(table);
    if (keyIn) {
      rows = (keyIn.list ?? [])
        .map((k) => this.tableOf(table).get(k))
        .filter((r): r is Row => !!r)
        .filter((r) => filters.every((f) => this.matches(r, f)));
      if (orderColumn) this.sort(rows, orderColumn, direction);
      rows = rows.slice(0, limit);
    } else if (orderColumn === def.key && direction !== 'desc' && numericKeys) {
      // Keyset over the sorted keys: fast enough for large tables.
      let start = 0;
      for (const f of filters) {
        if (f.column !== def.key) continue;
        const v = Number(f.value);
        if (f.op === 'gt') start = Math.max(start, upperBound(numericKeys, v));
        if (f.op === 'gte') start = Math.max(start, lowerBound(numericKeys, v));
      }
      const upper = filters
        .filter(
          (f) => f.column === def.key && (f.op === 'lte' || f.op === 'lt'),
        )
        .map((f) =>
          f.op === 'lte' ? Number(f.value) : Number(f.value) - 1e-9,
        );
      const max = upper.length ? Math.min(...upper) : Number.POSITIVE_INFINITY;
      rows = [];
      const map = this.tableOf(table);
      for (let i = start; i < numericKeys.length && rows.length < limit; i++) {
        if (numericKeys[i] > max) break;
        const row = map.get(String(numericKeys[i])) as Row;
        if (filters.every((f) => this.matches(row, f))) rows.push(row);
      }
    } else {
      rows = [...this.tableOf(table).values()].filter((r) =>
        filters.every((f) => this.matches(r, f)),
      );
      if (orderColumn) this.sort(rows, orderColumn, direction);
      rows = rows.slice(0, limit);
    }
    return json(rows.map((r) => this.project(r, select)));
  }

  private post(
    table: string,
    url: URL,
    body: unknown,
    prefer: string | undefined,
  ): Response {
    const params = url.searchParams;
    const columns = splitColumns(params.get('columns'));
    const onConflict = params.get('on_conflict');
    const preferences = new Set((prefer ?? '').split(',').map((p) => p.trim()));
    const rows = (Array.isArray(body) ? body : [body]) as Row[];
    if (!columns && Array.isArray(body) && rows.length > 1) {
      const keys = JSON.stringify(Object.keys(rows[0]).sort());
      if (rows.some((r) => JSON.stringify(Object.keys(r).sort()) !== keys)) {
        throw fail(400, 'PGRST102', 'All object keys must match');
      }
    }
    this.checkColumns(table, columns ?? rows.flatMap((r) => Object.keys(r)));
    const def = this.defOf(table);
    const missingDefault = preferences.has('missing=default');
    const merge = preferences.has('resolution=merge-duplicates');

    const written = this.statement(() => {
      const out: Row[] = [];
      for (const raw of rows) {
        const row: Row = {};
        for (const c of columns ?? Object.keys(raw)) {
          if (c in raw) row[c] = raw[c];
          else if (!missingDefault) row[c] = null;
        }
        if (onConflict && merge) {
          if (onConflict !== def.key) {
            throw new Error(`fake: on_conflict ${onConflict} is not the key`);
          }
          const existing =
            row[def.key] === undefined
              ? undefined
              : this.tableOf(table).get(String(row[def.key]));
          if (existing) {
            this.updateRow(table, existing, row);
            out.push(existing);
            continue;
          }
        }
        out.push(this.insertRow(table, row));
      }
      return out;
    });

    if (!preferences.has('return=representation')) {
      return new Response(null, { status: 201 });
    }
    const select = splitColumns(params.get('select'));
    return json(
      written.map((r) => this.project(r, select)),
      201,
    );
  }

  private patch(
    table: string,
    url: URL,
    body: unknown,
    prefer: string | undefined,
  ): Response {
    const filters = this.filtersOf(url.searchParams);
    const changes = body as Row;
    this.checkColumns(table, [
      ...Object.keys(changes),
      ...filters.map((f) => f.column),
    ]);
    const rows = [...this.tableOf(table).values()].filter((r) =>
      filters.every((f) => this.matches(r, f)),
    );
    this.statement(() => {
      for (const row of rows) this.updateRow(table, row, changes);
      return rows;
    });
    if ((prefer ?? '').includes('return=representation')) {
      return json(rows.map((r) => this.project(r, undefined)));
    }
    return new Response(null, { status: 204 });
  }

  private rpc(name: string, body: unknown): Response {
    if (name === 'get_userinfo') {
      // The platform's shape (0080_public_functions.sql): user_id, not id.
      return json({
        user_id: this.userId,
        external_id: 'auth0|importer',
        email: 'importer@example.test',
        display_name: 'Importer',
      });
    }
    if (name !== 'fix_id_sequence') {
      throw fail(
        404,
        'PGRST202',
        `Could not find the function public.${name} in the schema cache`,
      );
    }
    const table = String((body as Row | undefined)?.p_table);
    if (this.busy > 0) {
      this.busy--;
      throw fail(
        400,
        '90232',
        `Table ${table} is busy, try again`,
        null,
        JSON.stringify({
          table,
          hint: `Another transaction is writing to ${table}.`,
        }),
      );
    }
    switch (this.fixIdSequence) {
      case 'missing':
        throw fail(
          404,
          'PGRST202',
          'Could not find the function public.fix_id_sequence(p_table) in the schema cache',
          'Searched for the function public.fix_id_sequence with parameter p_table',
        );
      case 'denied':
        throw fail(
          403,
          '42501',
          `Permission denied: cannot fix the id sequence of ${table}`,
          null,
          '{"code":"90106"}',
        );
      case 'null':
        return json(null);
    }
    const def = this.defs.get(table);
    if (!def?.data) return json(null);
    let max = 0;
    for (const row of this.tableOf(table).values()) {
      const id = row[def.key];
      if (typeof id === 'number' && id > max) max = id;
    }
    const next = Math.max(this.sequences.get(table) ?? 1, max + 1);
    this.sequences.set(table, next);
    return json(next);
  }

  // ---------------------------------------------------------- statements

  private undo: Array<() => void> | undefined;
  private touched: Array<{ table: string; row: Row }> = [];

  /** Run writes as one statement: checks at its end, rollback on failure. */
  private statement(run: () => Row[]): Row[] {
    this.undo = [];
    this.touched = [];
    try {
      const rows = run();
      for (const { table, row } of this.touched) this.checkRow(table, row);
      return rows;
    } catch (error) {
      for (const step of this.undo.reverse()) step();
      throw error;
    } finally {
      this.undo = undefined;
    }
  }

  private insertRow(table: string, input: Row): Row {
    const def = this.defOf(table);
    let row = input;
    if (def.defaults) row = { ...def.defaults(row), ...row };
    if (def.generated) row[def.key] = def.generated(row);
    if (def.serial && (row[def.key] === undefined || row[def.key] === null)) {
      const next = this.sequences.get(table) ?? 1;
      this.sequences.set(table, next + 1);
      row[def.key] = next;
    }
    if (def.data) this.triggers(table, row, true);
    const map = this.tableOf(table);
    const key = String(row[def.key]);
    if (map.has(key)) {
      throw fail(
        409,
        '23505',
        `duplicate key value violates unique constraint "${table}_pkey"`,
        `Key (${def.key})=(${key}) already exists.`,
      );
    }
    this.checkUnique(table, row);
    map.set(key, row);
    this.sorted.delete(table);
    this.undo?.push(() => {
      map.delete(key);
      this.sorted.delete(table);
    });
    this.touched.push({ table, row });
    if (table === 'entities') this.createTable(row);
    return row;
  }

  private updateRow(table: string, row: Row, changes: Row): void {
    const before = { ...row };
    Object.assign(row, changes);
    if (this.defOf(table).data) this.triggers(table, row, false);
    this.checkUnique(table, row);
    this.undo?.push(() => {
      for (const k of Object.keys(row)) delete row[k];
      Object.assign(row, before);
    });
    this.touched.push({ table, row });
  }

  /** POST /entities: the physical table and its core fields. */
  private createTable(entity: Row): void {
    const table = String(entity.table_name);
    const key = String(entity.id_column || 'id');
    this.define(table, { key, serial: true, data: true });
    this.undo?.push(() => {
      this.defs.delete(table);
      this.store.delete(table);
      this.sequences.delete(table);
    });
    const core: Row[] = [
      {
        field_name: key,
        title: 'ID',
        format: 'integer',
        ctype: 'id',
        is_pk: true,
        field_order: 0,
        input_type: 'readonly',
      },
    ];
    if (entity.label_column) {
      core.push({
        field_name: entity.label_column,
        title: String(entity.singular_label ?? entity.label_column),
        format: 'text',
        ctype: 'label',
        field_order: 1,
        input_type: 'required',
      });
    }
    core.push(
      {
        field_name: 'created_at',
        title: 'Created at',
        format: 'date-time',
        ctype: 'audit',
        field_order: 900,
        input_type: 'readonly',
      },
      {
        field_name: 'updated_at',
        title: 'Updated at',
        format: 'date-time',
        ctype: 'audit',
        field_order: 901,
        input_type: 'readonly',
      },
    );
    for (const field of core)
      this.insertRow('fields', { ...field, table_name: table });
  }

  /** Audit timestamps and computed columns of a data row. */
  private triggers(table: string, row: Row, inserting: boolean): void {
    const entity = this.tableOf('entities').get(table) as Row;
    // Runs row by row, before the row is stored: like a BEFORE ROW trigger,
    // it sees the rows stored earlier in the statement, never later ones.
    const lookup = (t: string, id: unknown) => this.tableOf(t).get(String(id));
    for (const c of (entity.computed_fields as Row[]) ?? []) {
      row[String(c.name)] = evaluate(c.jsonlogic, row, lookup);
    }
    const now = this.now();
    if (inserting && !row.created_at) row.created_at = now;
    row.updated_at = inserting && row.updated_at ? row.updated_at : now;
  }

  /** End-of-statement checks: foreign keys, NOT NULL parents, rules. */
  private checkRow(table: string, row: Row): void {
    const def = this.defs.get(table);
    if (!def || !this.tableOf(table).has(String(row[def.key]))) return;
    for (const fk of def.foreign ?? []) {
      const value = row[fk.column];
      if (value === null || value === undefined || value === '') continue;
      if (!this.tableOf(fk.table).has(String(value))) {
        throw this.foreignKeyError(table, fk.column, value, fk.table);
      }
    }
    if (table === 'fields') {
      const ref = row.reference_table;
      if (ref && !this.defs.has(String(ref))) {
        throw this.foreignKeyError(table, 'reference_table', ref, 'entities');
      }
    }
    if (!def.data) return;
    for (const field of this.fieldsOf(table)) {
      if (field.format !== 'reference' && field.format !== 'parent') continue;
      const column = String(field.field_name);
      const value = row[column];
      if (value === null || value === undefined) {
        if (field.format === 'parent') {
          throw fail(
            400,
            '23502',
            `null value in column "${column}" of relation "${table}" violates not-null constraint`,
          );
        }
        continue;
      }
      const target = String(field.reference_table);
      if (!this.tableOf(target).has(String(value))) {
        throw this.foreignKeyError(table, column, value, target);
      }
    }
    const entity = this.tableOf('entities').get(table) as Row;
    for (const rule of (entity.validation_rules as Row[]) ?? []) {
      if (!evaluate(rule.jsonlogic, row)) {
        throw fail(
          400,
          'P0001',
          String(rule.message ?? `validation rule ${rule.name} failed`),
        );
      }
    }
  }

  private foreignKeyError(
    table: string,
    column: string,
    value: unknown,
    target: string,
  ): HttpError {
    return fail(
      409,
      '23503',
      `insert or update on table "${table}" violates foreign key constraint "${table}_${column}_fkey"`,
      `Key (${column})=(${value}) is not present in table "${target}".`,
    );
  }

  private checkUnique(table: string, row: Row): void {
    const def = this.defOf(table);
    for (const column of def.unique ?? []) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      for (const other of this.tableOf(table).values()) {
        if (
          other !== row &&
          other[def.key] !== row[def.key] &&
          other[column] === value
        ) {
          throw fail(
            409,
            '23505',
            `duplicate key value violates unique constraint "${table}_${column}_key"`,
            `Key (${column})=(${value}) already exists.`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------- utils

  private define(table: string, def: TableDef): void {
    this.defs.set(table, def);
    this.store.set(table, new Map());
  }

  private defOf(table: string): TableDef {
    const def = this.defs.get(table);
    if (!def) throw new Error(`fake: no table ${table}`);
    return def;
  }

  private tableOf(table: string): Map<string, Row> {
    let map = this.store.get(table);
    if (!map) {
      map = new Map();
      this.store.set(table, map);
    }
    return map;
  }

  private fieldsOf(table: string): Row[] {
    return [...this.tableOf('fields').values()].filter(
      (f) => f.table_name === table,
    );
  }

  /** A data table only has the columns of its fields (PostgREST's 42703 / PGRST204). */
  private checkColumns(table: string, columns: string[]): void {
    if (!this.defOf(table).data) return;
    const known = new Set(
      this.fieldsOf(table).map((f) => String(f.field_name)),
    );
    for (const column of columns) {
      if (column !== '*' && !known.has(column)) {
        throw fail(
          400,
          'PGRST204',
          `Could not find the '${column}' column of '${table}' in the schema cache`,
        );
      }
    }
  }

  private filtersOf(params: URLSearchParams): Filter[] {
    const out: Filter[] = [];
    for (const [column, raw] of params) {
      if (RESERVED.has(column)) continue;
      const dot = raw.indexOf('.');
      const op = raw.slice(0, dot);
      const value = raw.slice(dot + 1);
      out.push({
        column,
        op,
        value,
        list: op === 'in' ? parseList(value) : undefined,
      });
    }
    return out;
  }

  private matches(row: Row, filter: Filter): boolean {
    const v = row[filter.column];
    switch (filter.op) {
      case 'eq':
        return v !== null && v !== undefined && v === coerce(v, filter.value);
      case 'neq':
        return v !== coerce(v, filter.value);
      case 'in':
        return (filter.list ?? []).some((x) => v === coerce(v, x));
      case 'gt':
        return compare(v, coerce(v, filter.value)) > 0 && v != null;
      case 'gte':
        return compare(v, coerce(v, filter.value)) >= 0 && v != null;
      case 'lt':
        return compare(v, coerce(v, filter.value)) < 0 && v != null;
      case 'lte':
        return compare(v, coerce(v, filter.value)) <= 0 && v != null;
      default:
        throw new Error(`fake: unsupported operator ${filter.op}`);
    }
  }

  private sort(rows: Row[], column: string, direction?: string): void {
    const sign = direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => sign * compare(a[column], b[column]));
  }

  private project(row: Row, select: string[] | undefined): Row {
    if (!select || select.includes('*')) return row;
    const out: Row = {};
    for (const c of select) out[c] = row[c] ?? null;
    return out;
  }

  /** The table's keys ascending, when they are all numbers; cached. */
  private sortedKeys(table: string): number[] | undefined {
    const cached = this.sorted.get(table);
    if (cached) return cached;
    const def = this.defOf(table);
    const keys: number[] = [];
    for (const row of this.tableOf(table).values()) {
      const key = row[def.key];
      if (typeof key !== 'number') return undefined;
      keys.push(key);
    }
    keys.sort((a, b) => a - b);
    this.sorted.set(table, keys);
    return keys;
  }

  private now(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.tick++ * 1000).toISOString();
  }
}

/** Integer bounds on the key from gt/gte/lt/lte filters, when both exist. */
function keyRange(
  filters: Filter[],
  key: string,
): { low: number; high: number } | undefined {
  let low: number | undefined;
  let high: number | undefined;
  for (const f of filters) {
    if (f.column !== key) continue;
    const v = Number(f.value);
    if (f.op === 'gt') low = Math.max(low ?? -Infinity, Math.floor(v) + 1);
    if (f.op === 'gte') low = Math.max(low ?? -Infinity, Math.ceil(v));
    if (f.op === 'lt') high = Math.min(high ?? Infinity, Math.ceil(v) - 1);
    if (f.op === 'lte') high = Math.min(high ?? Infinity, Math.floor(v));
  }
  return low === undefined || high === undefined ? undefined : { low, high };
}

function lowerBound(keys: number[], value: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(keys: number[], value: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Route fetch to the fakes by hostname (looked up per request, so fakes
 * added later are found); returns the restore function. Anything else is an
 * error, so a test never reaches the network.
 */
export function installFakes(fakes: readonly FakePostgrest[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fake = fakes.find((f) => f.host === url.hostname);
    if (!fake) throw new Error(`unexpected fetch to ${url}`);
    if (init?.signal?.aborted) throw init.signal.reason;
    return fake.handle(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
