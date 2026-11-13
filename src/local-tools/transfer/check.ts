/**
 * import_entities with `check`: every problem the records of a transfer file
 * have against the catalog, in one listing, and nothing written.
 *
 * The import stops at the first record the target refuses, so a file made by
 * hand costs one run per mistake. The check reads the file and the catalog
 * only, never a record it would have written: one bad value does not hide the
 * next, and a record with a bad value is still a record the others may name.
 *
 * It knows what the catalog says: the tables and their columns, the key types,
 * which fields need a value, which values an enum takes, and which records
 * exist. It does not evaluate validation_rules, an input_type_rule or a
 * select_rule: a record those refuse still stops the import, and a re-run of
 * the import resumes after it.
 *
 * It keeps every id of the file in memory, one string per record, where the
 * import streams. That is a choice, traded against one read of the target per
 * reference: a file too large for it is imported without the check.
 */

import {
  type Definition,
  type KeyInfo,
  type TableCatalog,
  loadCatalog,
} from './catalog.js';
import type { Row, TransferContext, TransferFile } from './format.js';
import {
  TYPEID_KEYS,
  isTypeId,
  padSampleId,
  typeIdPrefix,
} from './sample-id.js';

export interface CheckResult {
  check: 'passed';
  note: string;
  entities: Array<{ table_name: string; records: number }>;
}

/** The platform's is_nullable: every other column is NOT NULL. */
const NULLABLE: ReadonlySet<string> = new Set([
  'reference',
  'date',
  'date-time',
]);
const INTEGERS: ReadonlySet<string> = new Set([
  'integer',
  'int32',
  'int64',
  'rating',
]);
const NUMBERS: ReadonlySet<string> = new Set(['number', 'float', 'double']);
const JSON_COLUMNS: ReadonlySet<string> = new Set([
  'json',
  'jsonlogic',
  'object',
  'array',
]);
/** Formats whose column is not TEXT and has no "missing" value to refuse. */
const NO_REQUIRED_TEST: ReadonlySet<string> = new Set([
  ...NUMBERS,
  'integer',
  'int32',
  'int64',
  'boolean',
  'uuid',
  'binary',
  'time',
  'duration',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHOWN_RECORDS = 5;
const SHOWN_VALUES = 12;

interface Problem {
  where: string;
  problem: string;
  records: string[];
  count: number;
}

/** Problems with one cause are one entry, with the records they affect. */
class Problems {
  private readonly entries = new Map<string, Problem>();

  add(where: string, problem: string, record?: string): void {
    const key = `${where}\n${problem}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { where, problem, records: [], count: 0 };
      this.entries.set(key, entry);
    }
    if (record === undefined) return;
    entry.count++;
    if (entry.records.length < SHOWN_RECORDS) entry.records.push(record);
  }

  get size(): number {
    return this.entries.size;
  }

  text(path: string): string {
    const lines = [...this.entries.values()].map((p, i) => {
      const more = p.count - p.records.length;
      const records = p.count
        ? ` (${p.count} record${p.count === 1 ? '' : 's'}: ${p.records.join(', ')}${more > 0 ? `, and ${more} more` : ''})`
        : '';
      return `${i + 1}. ${p.where}: ${p.problem}${records}`;
    });
    return [
      `the check found ${this.size} problem${this.size === 1 ? '' : 's'} in ${path}; nothing was written:`,
      ...lines,
      'Fix every one of them, then run the check again.',
    ].join('\n');
  }
}

/** A check that listed problems: its message is the whole listing. */
export class CheckFailed extends Error {}

const show = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

const emptyRule = (rule: unknown): boolean =>
  rule === null ||
  rule === undefined ||
  rule === '' ||
  (typeof rule === 'object' && Object.keys(rule as object).length === 0);

const enumValues = (field: Row): Array<{ value: string; label: string }> =>
  (Array.isArray(field.enum_values) ? field.enum_values : []).map((e) =>
    e && typeof e === 'object'
      ? {
          value: String((e as Row).value),
          label: String((e as Row).label ?? (e as Row).value),
        }
      : { value: String(e), label: String(e) },
  );

/** Whether the platform's required check (dd_required_test) applies to a field. */
function requiredApplies(field: Row): boolean {
  return (
    field.input_type === 'required' &&
    !field.is_pk &&
    emptyRule(field.input_type_rule) &&
    field.format !== 'parent' &&
    !NO_REQUIRED_TEST.has(String(field.format))
  );
}

/** Whether `value` is what a required field of `format` may not hold. */
function isMissing(format: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (format === 'rating') return value === 0;
  if (JSON_COLUMNS.has(format)) {
    return (
      value === '' ||
      (typeof value === 'object' && Object.keys(value as object).length === 0)
    );
  }
  return typeof value === 'string' && value.trim() === '';
}

/** Why `id` is not a key of `idType`, or undefined. */
function keyProblem(idType: string, id: unknown): string | undefined {
  if (TYPEID_KEYS.has(idType)) {
    return isTypeId(id)
      ? undefined
      : 'is not a TypeID (the prefix, "_", then 26 characters) nor a sample id such as <prefix>_sr1';
  }
  if (idType === 'uuid') {
    return typeof id === 'string' && UUID.test(id)
      ? undefined
      : 'is not a UUID';
  }
  if (idType === 'text') {
    return typeof id === 'string' && id !== ''
      ? undefined
      : 'is not a text key';
  }
  const whole =
    (typeof id === 'number' && Number.isInteger(id)) ||
    (typeof id === 'string' && /^-?\d+$/.test(id));
  return whole ? undefined : 'is not a whole number';
}

/** Why `value` does not fit a field, or undefined. Relationships are checked apart. */
function valueProblem(field: Row, value: unknown): string | undefined {
  const format = String(field.format ?? '');
  if (value === null) {
    if (format === 'parent') {
      return 'is null; a parent field always names a record';
    }
    if (!NULLABLE.has(format)) {
      return 'is null; only a reference, date or date-time field takes null';
    }
    return requiredApplies(field) ? 'is required and null' : undefined;
  }
  if (requiredApplies(field) && isMissing(format, value)) {
    return 'is required and empty';
  }
  if (format === 'enum') {
    if (value === '') return undefined;
    const entries = enumValues(field);
    if (!entries.length || entries.some((e) => e.value === String(value))) {
      return undefined;
    }
    const label = entries.find(
      (e) => e.label.toLowerCase() === String(value).toLowerCase(),
    );
    const values = entries.map((e) => e.value);
    const listed =
      values.length > SHOWN_VALUES
        ? `${values.slice(0, SHOWN_VALUES).join(', ')}, …`
        : values.join(', ');
    const hint = !label
      ? ''
      : label.label === label.value
        ? `; did you mean ${JSON.stringify(label.value)}?`
        : `; write the value ${JSON.stringify(label.value)}, not the label`;
    return `${JSON.stringify(value)} is not one of its values (${listed})${hint}`;
  }
  if (format === 'boolean') {
    return typeof value === 'boolean'
      ? undefined
      : `${JSON.stringify(value)} is not true or false`;
  }
  if (INTEGERS.has(format)) {
    const whole =
      (typeof value === 'number' && Number.isInteger(value)) ||
      (typeof value === 'string' && /^-?\d+$/.test(value));
    if (!whole) return `${JSON.stringify(value)} is not a whole number`;
    if (format === 'rating' && (Number(value) < 0 || Number(value) > 5)) {
      return `${JSON.stringify(value)} is not a rating from 0 to 5`;
    }
    return undefined;
  }
  if (NUMBERS.has(format)) {
    const numeric =
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' &&
        value.trim() !== '' &&
        Number.isFinite(Number(value)));
    return numeric ? undefined : `${JSON.stringify(value)} is not a number`;
  }
  if (format === 'date') {
    const ok =
      typeof value === 'string' &&
      DATE.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
    return ok
      ? undefined
      : `${JSON.stringify(value)} is not a date such as 2026-09-15`;
  }
  if (format === 'date-time') {
    const ok = typeof value === 'string' && !Number.isNaN(Date.parse(value));
    return ok
      ? undefined
      : `${JSON.stringify(value)} is not a date and time such as 2026-09-15T14:30:00Z`;
  }
  return undefined;
}

/** A relationship value that the file's own records did not answer. */
interface Lookup {
  /** Where it is named: "table.column". */
  where: string;
  record: string;
  /** The value as the file writes it, a sample id in its short form. */
  written: string;
}

/** A table of the file with its place in it. */
interface Entry {
  info: TableCatalog;
  index: number;
}

/**
 * Check the records of `file` against the catalog of the target (and, for a
 * table the file defines itself, against that definition). Throws CheckFailed
 * with the listing when there is a problem; writes nothing either way.
 */
export async function checkTransfer(
  ctx: TransferContext,
  file: TransferFile,
): Promise<CheckResult> {
  const { pg } = ctx;
  const problems = new Problems();
  const listed = file.doc.entities
    .map((e, index) => ({ table: e.entity.table_name, index }))
    .filter((e) => file.recordCount(e.index) > 0);
  const withRecords = new Set(listed.map((e) => e.table));
  const defined = new Map<string, Definition>();
  for (const { entity } of file.doc.entities) {
    if (Array.isArray(entity.fields)) {
      defined.set(entity.table_name, {
        entity,
        fields: entity.fields as Row[],
      });
    }
  }
  const catalog = await loadCatalog(pg, [...withRecords], defined);
  const entries: Entry[] = [];
  for (const { table, index } of listed) {
    const info = catalog.tables.get(table);
    if (info) entries.push({ info, index });
    else {
      problems.add(
        table,
        'the table is not on the target, and the file does not define it',
      );
    }
  }

  const padFor = (table: string, value: unknown): unknown =>
    TYPEID_KEYS.has(catalog.keys.get(table)?.idType ?? '')
      ? padSampleId(value)
      : value;

  /**
   * The subtype a record listed under a base belongs to, when the file
   * carries that subtype's records: the import writes it there, so the base's
   * entry neither checks nor counts it.
   */
  const subtypeOf = (info: TableCatalog, id: unknown): string | undefined => {
    if (!info.subtypes.size || !isTypeId(id)) return undefined;
    const prefix = typeIdPrefix(id);
    return prefix === info.idPrefix ? undefined : info.subtypes.get(prefix);
  };

  // ---- pass 1: the ids of every table, so pass 2 can look any record up
  const ids = new Map<string, Set<string>>();
  for (const { info, index } of entries) {
    const seen = new Set<string>();
    ids.set(info.table, seen);
    const where = `${info.table}.${info.idColumn}`;
    let position = 0;
    for await (const { row } of file.records(index)) {
      position++;
      const raw = row[info.idColumn];
      if (raw === null || raw === undefined) {
        problems.add(where, 'the record has no id', `record ${position}`);
        continue;
      }
      const id = padFor(info.table, raw);
      const wrong = keyProblem(info.idType, id);
      if (wrong) {
        problems.add(where, wrong, show(raw));
        continue;
      }
      const subtype = subtypeOf(info, id);
      if (subtype) {
        if (!withRecords.has(subtype)) {
          problems.add(
            where,
            `is a record of ${subtype}, and the file carries no records of ${subtype}; a record is written at its own table`,
            show(raw),
          );
        }
        continue;
      }
      if (
        (info.idType === 'typeid' || info.idType === 'is_a') &&
        info.idPrefix &&
        typeIdPrefix(id as string) !== info.idPrefix
      ) {
        problems.add(
          where,
          `does not carry the prefix ${info.idPrefix} of ${info.table}`,
          show(raw),
        );
        continue;
      }
      if (seen.has(String(id))) {
        problems.add(where, 'is the id of more than one record', show(raw));
        continue;
      }
      seen.add(String(id));
    }
  }
  /** Whether the file carries `id` as a record of `table`, or of a subtype of it. */
  const inFile = (table: string, id: unknown): boolean =>
    entries.some(
      ({ info }) =>
        (info.table === table ||
          (info.idType === 'is_a' && info.chain.includes(table))) &&
        ids.get(info.table)?.has(String(id)),
    );

  // ---- pass 2: columns and values
  /** Per pointed-at table, the values the file did not answer. */
  const lookups = new Map<string, Map<string, Lookup[]>>();
  const lookUp = (table: string, id: unknown, at: Lookup): void => {
    let values = lookups.get(table);
    if (!values) {
      values = new Map();
      lookups.set(table, values);
    }
    const list = values.get(String(id)) ?? [];
    list.push(at);
    values.set(String(id), list);
  };
  const userRefs = new Map<string, Lookup[]>();

  for (const { info, index } of entries) {
    // An extension writes its own fields; its base's belong to the base record.
    const written = (column: string): boolean =>
      !info.skip.has(column) &&
      (info.idType !== 'has_a' || info.own.has(column));
    let columns: string[] | undefined;
    let position = 0;
    for await (const { row } of file.records(index)) {
      position++;
      const rawId = row[info.idColumn];
      const record =
        rawId === null || rawId === undefined
          ? `record ${position}`
          : show(rawId);
      if (subtypeOf(info, padFor(info.table, rawId))) continue;

      if (!columns) {
        columns = Object.keys(row);
        if (!columns.includes(info.idColumn)) {
          problems.add(
            info.table,
            `the records carry no ${info.idColumn}, the id column`,
          );
        }
        for (const c of columns) {
          if (c !== info.idColumn && !info.fields.has(c)) {
            problems.add(
              `${info.table}.${c}`,
              `${info.table} has no such column`,
            );
          }
        }
        const sent = new Set(columns);
        for (const [name, field] of info.fields) {
          if (sent.has(name) || name === info.idColumn || !written(name)) {
            continue;
          }
          if (field.format === 'parent') {
            problems.add(
              `${info.table}.${name}`,
              'is a parent field and the records do not carry it',
            );
          } else if (
            requiredApplies(field) &&
            String(field.default_value ?? '') === ''
          ) {
            problems.add(
              `${info.table}.${name}`,
              'is required, has no default, and the records do not carry it',
            );
          }
        }
      }
      for (const c of Object.keys(row)) {
        if (!columns.includes(c)) {
          problems.add(
            `${info.table}.${c}`,
            'is not a column of the first record, so the import would not write it; every record carries the same columns',
            record,
          );
        }
      }

      // An extension attaches to the base record its id names.
      if (
        info.idType === 'has_a' &&
        info.base &&
        isTypeId(padSampleId(rawId))
      ) {
        const id = padSampleId(rawId);
        if (!inFile(info.base, id)) {
          lookUp(info.base, id, {
            where: `${info.table}.${info.idColumn}`,
            record,
            written: show(rawId),
          });
        }
      }

      for (const c of columns) {
        if (c === info.idColumn || !written(c)) continue;
        const field = info.fields.get(c);
        if (!field) continue;
        const where = `${info.table}.${c}`;
        if (!(c in row)) {
          problems.add(
            where,
            'is missing from the record; every record carries the same columns',
            record,
          );
          continue;
        }
        const value = row[c];
        const relationship =
          field.format === 'reference' || field.format === 'parent';
        if (!relationship || value === null) {
          const wrong = valueProblem(field, value);
          if (wrong) problems.add(where, wrong, record);
          continue;
        }
        const target = String(field.reference_table ?? '');
        if (target === 'users') {
          const externalId =
            value && typeof value === 'object'
              ? (value as Row).external_id
              : undefined;
          if (typeof externalId !== 'string') {
            problems.add(
              where,
              `${JSON.stringify(value)} is not {"external_id": …}, which a reference to a user takes`,
              record,
            );
          } else {
            const list = userRefs.get(externalId) ?? [];
            list.push({ where, record, written: externalId });
            userRefs.set(externalId, list);
          }
          continue;
        }
        const key = catalog.keys.get(target);
        if (!key) {
          problems.add(
            where,
            `points at ${target}, which is not an entity of the target`,
          );
          continue;
        }
        const id = padFor(target, value);
        const wrong = keyProblem(key.idType, id);
        if (wrong) {
          problems.add(
            where,
            `${JSON.stringify(value)} ${wrong}, the key of ${target}`,
            record,
          );
          continue;
        }
        if (!inFile(target, id)) {
          lookUp(target, id, { where, record, written: show(value) });
        }
      }
    }
  }

  // ---- what the file did not answer: one read of the target per table
  for (const [table, values] of lookups) {
    const key = catalog.keys.get(table) as KeyInfo | undefined;
    const found = new Set<string>();
    if (key?.onTarget) {
      for (const row of await pg.readIn(
        table,
        key.idColumn,
        [...values.keys()],
        { select: [key.idColumn], key: key.idColumn, schemaWait: true },
      )) {
        found.add(String(row[key.idColumn]));
      }
    }
    for (const [id, named] of values) {
      if (found.has(id)) continue;
      for (const at of named) {
        problems.add(
          at.where,
          `names ${at.written}, which is no record of ${table} in the file or on the target`,
          at.record,
        );
      }
    }
  }
  if (userRefs.size) {
    const users = new Set(
      (
        await pg.readAll('users', { select: ['id', 'external_id'], key: 'id' })
      ).map((u) => String(u.external_id)),
    );
    for (const [externalId, named] of userRefs) {
      if (users.has(externalId)) continue;
      for (const at of named) {
        problems.add(
          at.where,
          `no user with external_id ${JSON.stringify(externalId)} on the target`,
          at.record,
        );
      }
    }
  }

  if (problems.size) throw new CheckFailed(problems.text(file.path));
  return {
    check: 'passed',
    note: 'Nothing was written. Run the import without "check" to write the records.',
    entities: listed.map((e) => ({
      table_name: e.table,
      records: file.recordCount(e.index),
    })),
  };
}
