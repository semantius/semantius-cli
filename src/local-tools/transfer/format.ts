/**
 * The transfer file that export_entities / export_module write and
 * import_entities / import_module read: one JSON document, laid out so that
 * neither side ever holds a table in memory.
 *
 *   - metadata is pretty-printed (2 spaces);
 *   - each record is one compact line inside its entity's "records" block
 *     (JSON.stringify escapes newlines in strings, so a record never spans
 *     lines), which also makes a changed record one changed line in git;
 *   - LF line endings on every OS.
 *
 * The reader relies on that layout to stream: pass 1 collects the metadata
 * and the byte range of each records block, pass 2 streams one block at a
 * time. A file that lost the layout (reformatted by hand) is parsed whole.
 *
 * Metadata is keyed by names, never by host ids: the column lists below come
 * from the vendored schemas (read, never edited), with every host id dropped
 * or replaced by the name it stands for.
 */

import { rmSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { entitySchema } from '../../vendor/postgrest-mcp/src/tools/schemas/entitySchema.js';
import { fieldSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/fieldSchema.js';
import { moduleSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/moduleSchema.js';
import { permissionSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/permissionSchema.js';
import { permission_hierarchySchema } from '../../vendor/postgrest-mcp/src/tools/schemas/permission_hierarchySchema.js';
import { roleSchema } from '../../vendor/postgrest-mcp/src/tools/schemas/roleSchema.js';
import type { PostgrestClient } from './postgrest.js';

export type Row = Record<string, unknown>;

export const TRANSFER_VERSION = 1;

/** What the tools run with: the host's PostgREST and a progress reporter. */
export interface TransferContext {
  pg: PostgrestClient;
  progress: (message: string) => void;
}

/**
 * Metadata and system tables: refused as export names, because their records
 * would put host ids into the file.
 */
export const SYSTEM_TABLES: ReadonlySet<string> = new Set([
  'modules',
  'entities',
  'fields',
  'permissions',
  'permission_hierarchy',
  'roles',
  'role_permissions',
  'users',
  'user_roles',
  'webhook_receivers',
  'webhook_receiver_logs',
]);

const keysOf = (schema: { shape: object }) => Object.keys(schema.shape);
const without = (columns: string[], ...drop: string[]) =>
  columns.filter((c) => !drop.includes(c));

// ---------------------------------------------------------------- modules

/** default_*_role_id (host ids) travel as default_*_role_slug. */
export const MODULE_ROLE_COLUMNS: Readonly<Record<string, string>> = {
  default_viewer_role_id: 'default_viewer_role_slug',
  default_manager_role_id: 'default_manager_role_slug',
  default_admin_role_id: 'default_admin_role_slug',
};

/** Module columns in file order: no id, role ids replaced by role slugs. */
export const MODULE_COLUMNS = without(keysOf(moduleSchema), 'id').map(
  (c) => MODULE_ROLE_COLUMNS[c] ?? c,
);
export const MODULE_CREATE_ONLY = ['module_type', 'catalog_module_code'];
export const MODULE_PERMISSION_COLUMNS = [
  'view_permission',
  'manage_permission',
  'admin_permission',
];
/** Written last: they name permissions and roles the import creates first. */
export const MODULE_DEFERRED = [
  ...MODULE_PERMISSION_COLUMNS,
  ...Object.values(MODULE_ROLE_COLUMNS),
];

// ------------------------------------------------------ permissions, roles

/** module_id is implied: the module the file carries. */
export const PERMISSION_COLUMNS = without(
  keysOf(permissionSchema),
  'module_id',
);
export const HIERARCHY_COLUMNS = without(
  keysOf(permission_hierarchySchema),
  'id',
);
export const ROLE_COLUMNS = without(keysOf(roleSchema), 'id', 'module_id');
export const ROLE_CREATE_ONLY = ['origin', 'slug'];

// -------------------------------------------------------- entities, fields

/**
 * Entity columns in file order: module_id replaced by module_name, the
 * auto-computed searchable / is_child dropped.
 */
export const ENTITY_COLUMNS = without(
  keysOf(entitySchema),
  'searchable',
  'is_child',
).map((c) => (c === 'module_id' ? 'module_name' : c));
export const ENTITY_CREATE_ONLY = [
  'id_column',
  'catalog_entity_code',
  'catalog_entity_aliases',
];
/** Written once the fields exist: they name fields. */
export const ENTITY_DEFERRED = ['label_parent', 'computed_fields'];
/**
 * Written after the records: older rows can fail today's validation rules,
 * and a select_rule would hide rows from the import's own reads.
 */
export const ENTITY_AFTER_DATA = ['validation_rules', 'select_rule'];

/** Field columns in file order: id and table_name are implied. */
export const FIELD_COLUMNS = without(keysOf(fieldSchema), 'id', 'table_name');
/** Exported, never written. */
export const FIELD_READ_ONLY = ['ctype'];
export const FIELD_CREATE_ONLY = ['catalog_field_code'];
/** Never patched on a core field (ctype ≠ ''). */
export const CORE_FIELD_FIXED = [
  'field_name',
  'format',
  'default_value',
  'ctype',
  'is_pk',
];

// ------------------------------------------------------------------ helpers

/** The columns of `row` that are set, in `columns` order. */
export function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const column of columns) {
    if (row[column] !== undefined) out[column] = row[column];
  }
  return out;
}

/** `row` without `columns`. */
export function omit(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    if (!columns.includes(column)) out[column] = value;
  }
  return out;
}

/** Ascending by the given keys, in code-unit order: independent of locale. */
export function byKeys<T extends Row>(...keys: string[]) {
  return (a: T, b: T): number => {
    for (const key of keys) {
      const x = a[key] as string | number | null | undefined;
      const y = b[key] as string | number | null | undefined;
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  };
}

// ------------------------------------------------------------ the document

/** An entity's records in a parsed file: in memory, or a block to stream. */
export type RecordsSource = Row[] | { $block: number };

export interface EntityEntry {
  entity: Row & { table_name: string; fields?: Row[] };
  records?: RecordsSource;
}

export interface TransferDoc {
  version: number;
  module?: Row;
  permissions?: Row[];
  permission_hierarchy?: Row[];
  roles?: Row[];
  role_permissions?: Row[];
  entities: EntityEntry[];
}

// ------------------------------------------------------------------ writing

const ENTITIES_OPEN = '  "entities": [';
const RECORDS_OPEN = '      "records": [';
const RECORDS_CLOSE = '      ]';
const RECORD_INDENT = '        ';

/** JSON.stringify(value, null, 2), every line after the first indented. */
function pretty(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${indent}`);
}

/**
 * Writes the file to `<path>.tmp` beside it and renames it over `path` when
 * complete, so a failed or cancelled export never leaves a partial file.
 */
export class TransferWriter {
  private entityCount = 0;
  private recordCount = 0;
  private inRecords = false;

  private constructor(
    readonly path: string,
    private readonly tmp: string,
    private readonly sink: ReturnType<ReturnType<typeof Bun.file>['writer']>,
  ) {}

  static async open(path: string): Promise<TransferWriter> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const writer = new TransferWriter(path, tmp, Bun.file(tmp).writer());
    // Ctrl+C and the CLI's timeout end in process.exit, before abort() runs.
    process.on('exit', writer.removeOnExit);
    return writer;
  }

  private readonly removeOnExit = (): void => {
    try {
      rmSync(this.tmp, { force: true });
    } catch {
      // Still open on Windows, or already gone: nothing more to do at exit.
    }
  };

  /** The version and the module sections, then the opening of "entities". */
  head(sections: Row): void {
    let text = `{\n  "version": ${TRANSFER_VERSION}`;
    for (const [key, value] of Object.entries(sections)) {
      text += `,\n  ${JSON.stringify(key)}: ${pretty(value, '  ')}`;
    }
    this.sink.write(`${text},\n${ENTITIES_OPEN}`);
  }

  /** Opens an entity entry; `withRecords` opens its records block too. */
  entity(entity: Row, withRecords: boolean): void {
    let text = `${this.entityCount++ ? ',' : ''}\n    {\n      "entity": ${pretty(entity, '      ')}`;
    if (withRecords) text += `,\n${RECORDS_OPEN}`;
    this.sink.write(text);
    this.inRecords = withRecords;
    this.recordCount = 0;
  }

  /** One compact line per record. */
  async records(rows: Row[]): Promise<void> {
    let text = '';
    for (const row of rows) {
      text += `${this.recordCount++ ? ',' : ''}\n${RECORD_INDENT}${JSON.stringify(row)}`;
    }
    this.sink.write(text);
    await this.sink.flush();
  }

  endEntity(): void {
    this.sink.write(`${this.inRecords ? `\n${RECORDS_CLOSE}` : ''}\n    }`);
    this.inRecords = false;
  }

  async finish(): Promise<void> {
    this.sink.write('\n  ]\n}\n');
    await this.sink.end();
    await replaceFile(this.tmp, this.path);
    process.off('exit', this.removeOnExit);
  }

  /** Drops the temp file. */
  async abort(): Promise<void> {
    try {
      await this.sink.end();
    } catch {
      // Already closed, or the disk failed: removing the file is what matters.
    }
    await rm(this.tmp, { force: true });
    process.off('exit', this.removeOnExit);
  }
}

/**
 * rename() replaces the target on every OS, but Windows refuses while another
 * process holds it open (an editor, a virus scanner): retry briefly.
 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const locked = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!locked || attempt === 5) throw error;
      await Bun.sleep(100 * attempt);
    }
  }
}

// ------------------------------------------------------------------ reading

const NL = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const COMMA = 0x2c;
const BRACE_OPEN = 0x7b;
const BRACE_CLOSE = 0x7d;
const RECORDS_CLOSE_BYTES = new TextEncoder().encode(RECORDS_CLOSE);

/** A records block: the bytes between its opening and closing lines. */
interface Block {
  start: number;
  end: number;
  count: number;
}

/** A record and the size of its line, for batching by bytes. */
export interface RecordLine {
  row: Row;
  bytes: number;
}

/** A transfer file: its metadata in memory, its records streamed on demand. */
export class TransferFile {
  constructor(
    readonly path: string,
    readonly doc: TransferDoc,
    private readonly blocks: Block[],
  ) {}

  /** How many records the entity entry at `index` carries (0 when none). */
  recordCount(index: number): number {
    const source = this.doc.entities[index].records;
    if (!source) return 0;
    return Array.isArray(source)
      ? source.length
      : this.blocks[source.$block].count;
  }

  /** The records of the entity entry at `index`, in file order. */
  async *records(index: number): AsyncGenerator<RecordLine> {
    const source = this.doc.entities[index].records;
    if (!source) return;
    if (Array.isArray(source)) {
      for (const row of source) {
        yield { row, bytes: JSON.stringify(row).length };
      }
      return;
    }
    const block = this.blocks[source.$block];
    if (block.end <= block.start) return;
    const decoder = new TextDecoder();
    const stream = sliceStream(this.path, block.start, block.end);
    for await (const line of splitLines(stream)) {
      let end = line.length;
      while (
        end > 0 &&
        (line[end - 1] === CR ||
          line[end - 1] === COMMA ||
          line[end - 1] === SPACE)
      ) {
        end--;
      }
      if (end === 0) continue;
      const text = decoder.decode(line.subarray(0, end));
      let row: unknown;
      try {
        row = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${this.path}: a record of ${this.doc.entities[index].entity.table_name} is not valid JSON: ${(error as Error).message}`,
        );
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(
          `${this.path}: a record of ${this.doc.entities[index].entity.table_name} is not an object`,
        );
      }
      yield { row: row as Row, bytes: line.length };
    }
  }
}

/**
 * The bytes [start, end) of a file. Bun's slice(start, end).stream() cannot
 * be trusted with the bound: on Windows (Bun 1.3), a slice smaller than its
 * first read of a larger file streams on past `end`. So the bytes are
 * counted here and the stream is cut off at `end`.
 */
async function* sliceStream(
  path: string,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  let left = end - start;
  for await (const chunk of Bun.file(path).slice(start, end).stream()) {
    if (left <= 0) break;
    yield chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= chunk.length;
  }
}

/** The lines of a byte stream, without their "\n". */
async function* splitLines(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let carry: Uint8Array[] = [];
  for await (const chunk of stream) {
    let pos = 0;
    for (;;) {
      const nl = chunk.indexOf(NL, pos);
      if (nl === -1) {
        if (pos < chunk.length) carry.push(chunk.subarray(pos));
        break;
      }
      const piece = chunk.subarray(pos, nl);
      if (carry.length) {
        carry.push(piece);
        yield Buffer.concat(carry);
        carry = [];
      } else {
        yield piece;
      }
      pos = nl + 1;
    }
  }
  if (carry.length) yield Buffer.concat(carry);
}

/** Whether a line is shaped like a one-line record: `{…}` or `{…},`. */
function looksLikeRecord(line: Uint8Array, end: number): boolean {
  let first = 0;
  while (first < end && line[first] === SPACE) first++;
  let last = end - 1;
  while (last > first && (line[last] === SPACE || line[last] === COMMA)) {
    last--;
  }
  return (
    first < end && line[first] === BRACE_OPEN && line[last] === BRACE_CLOSE
  );
}

function isLine(line: Uint8Array, end: number, expected: Uint8Array): boolean {
  if (end !== expected.length) return false;
  for (let i = 0; i < end; i++) if (line[i] !== expected[i]) return false;
  return true;
}

/**
 * Pass 1: the metadata document, with each records block replaced by a
 * `{"$block": n}` marker, and the byte range of every block. Null when the
 * file is not in the writer's layout.
 *
 * A block opens only at the writer's exact line inside the top-level
 * "entities" section: settings, dashboard_config and computed_fields hold free
 * JSON, and a nested "records" array there prints the same text.
 */
async function scan(
  path: string,
): Promise<{ meta: string; blocks: Block[] } | null> {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  const blocks: Block[] = [];
  let block: Block | undefined;
  let inEntities = false;
  let broken = false;
  let first = true;
  let offset = 0;

  for await (const line of splitLines(Bun.file(path).stream())) {
    const start = offset;
    offset += line.length + 1;
    let end = line.length;
    if (end > 0 && line[end - 1] === CR) end--;

    if (block) {
      if (isLine(line, end, RECORDS_CLOSE_BYTES)) {
        block.end = start;
        blocks.push(block);
        block = undefined;
      } else {
        if (!looksLikeRecord(line, end)) broken = true;
        block.count++;
      }
      continue;
    }

    let text = decoder.decode(line.subarray(0, end));
    if (first) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (inEntities && text === RECORDS_OPEN) {
      lines.push(`      "records": {"$block": ${blocks.length}}`);
      block = { start: offset, end: offset, count: 0 };
      continue;
    }
    if (text === ENTITIES_OPEN) inEntities = true;
    lines.push(text);
  }
  if (block || broken) return null;
  return { meta: lines.join('\n'), blocks };
}

/**
 * Read a transfer file: the metadata in memory, the records left on disk.
 * Refuses a file whose version is not TRANSFER_VERSION.
 */
export async function readTransferFile(path: string): Promise<TransferFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no such file: ${path}`);

  let doc: unknown;
  let blocks: Block[] = [];
  const scanned = await scan(path);
  if (scanned) {
    try {
      doc = JSON.parse(scanned.meta);
      blocks = scanned.blocks;
    } catch {
      doc = undefined;
    }
  }
  if (doc === undefined) {
    // Not in the writer's layout: parse the whole file.
    let text = await file.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      doc = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${path} is not a transfer file: not a JSON object`);
  }
  const version = (doc as Row).version;
  if (version !== TRANSFER_VERSION) {
    throw new Error(
      `${path} has version ${JSON.stringify(version) ?? 'none'}; this CLI reads version ${TRANSFER_VERSION}`,
    );
  }
  const entities = (doc as Row).entities;
  if (!Array.isArray(entities)) {
    throw new Error(`${path} is not a transfer file: it has no "entities"`);
  }
  for (const entry of entities as EntityEntry[]) {
    const tableName = entry?.entity?.table_name;
    if (typeof tableName !== 'string' || !tableName) {
      throw new Error(
        `${path} is not a transfer file: an entry of "entities" has no entity.table_name`,
      );
    }
    const records = entry.records as unknown;
    const isBlock =
      !!records &&
      typeof records === 'object' &&
      typeof (records as { $block?: unknown }).$block === 'number';
    if (records !== undefined && !Array.isArray(records) && !isBlock) {
      throw new Error(`${path}: the records of ${tableName} are not a list`);
    }
  }
  return new TransferFile(path, doc as TransferDoc, blocks);
}
