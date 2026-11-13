/**
 * What the import and its check need to know about the tables whose records a
 * transfer file carries, read from the target's catalog (and, for the check,
 * from the definitions the file brings with it).
 *
 * A record of an is_a or has_a entity shows the fields of the entities it is
 * based on as well as its own, and the catalog lists a field only under the
 * entity that owns it. So a table's fields are gathered up its chain of bases,
 * and a base knows the is_a entities below it: a read of a base lists their
 * records too, each under its own subtype's prefix.
 */

import type { Row } from './format.js';
import type { PostgrestClient } from './postgrest.js';
import { TYPEID_KEYS } from './sample-id.js';

export interface TableCatalog {
  table: string;
  entity: Row;
  idColumn: string;
  /** auto_increment, bigint, text, uuid, typeid, is_a or has_a. */
  idType: string;
  idPrefix: string;
  /** For an is_a or has_a entity: the entity it is based on. */
  base?: string;
  /** The table, then the entities it is based on, nearest first. */
  chain: string[];
  /** Every field a record shows: the entity's own and those of its bases. */
  fields: Map<string, Row>;
  /** The names of the fields the entity owns itself. */
  own: Set<string>;
  /** Audit, rollup and computed columns of every level: the target sets them. */
  skip: Set<string>;
  /** Prefix → table of each is_a entity based on this one, at any depth. */
  subtypes: Map<string, string>;
  /** Whether the table exists on the target (the check also reads the file). */
  onTarget: boolean;
}

/** The key of a table a reference points at. */
export interface KeyInfo {
  idColumn: string;
  idType: string;
  onTarget: boolean;
}

export interface Catalog {
  tables: Map<string, TableCatalog>;
  /** The keys of the tables above and of every table their fields reference. */
  keys: Map<string, KeyInfo>;
}

/** An entity the file defines itself: the check reads it when the target lacks it. */
export interface Definition {
  entity: Row;
  fields: Row[];
}

const idTypeOf = (entity: Row): string =>
  String(entity.id_type || 'auto_increment');
const isBased = (entity: Row): boolean =>
  entity.id_type === 'is_a' || entity.id_type === 'has_a';
const baseOf = (entity: Row): string | undefined =>
  isBased(entity) &&
  typeof entity.id_refentity === 'string' &&
  entity.id_refentity
    ? entity.id_refentity
    : undefined;

/**
 * The catalog of `tables`. A table that is neither on the target nor in
 * `defined` is left out of the result: the caller says what that means.
 */
export async function loadCatalog(
  pg: PostgrestClient,
  tables: readonly string[],
  defined: ReadonlyMap<string, Definition> = new Map(),
): Promise<Catalog> {
  const entities = new Map<string, Row>();
  const onTarget = new Set<string>();
  const load = async (names: readonly string[]): Promise<void> => {
    const wanted = [...new Set(names)].filter((n) => !entities.has(n));
    for (const entity of await pg.readIn('entities', 'table_name', wanted, {
      key: 'table_name',
    })) {
      entities.set(entity.table_name as string, entity);
      onTarget.add(entity.table_name as string);
    }
    for (const name of wanted) {
      const definition = defined.get(name);
      if (!entities.has(name) && definition) {
        entities.set(name, { ...definition.entity, table_name: name });
      }
    }
  };

  // The tables, then up their chains of bases.
  await load(tables);
  for (;;) {
    const bases = [...entities.values()]
      .map(baseOf)
      .filter((b): b is string => !!b && !entities.has(b));
    if (!bases.length) break;
    const before = entities.size;
    await load(bases);
    if (entities.size === before) break;
  }

  // Down: the is_a entities based on a table of the file, at any depth.
  const subtypeRows = new Map<string, Row>();
  for (const [name, definition] of defined) {
    if (definition.entity.id_type === 'is_a') {
      subtypeRows.set(name, { ...definition.entity, table_name: name });
    }
  }
  const walked = new Set<string>();
  for (let level = tables.filter((t) => entities.has(t)); level.length; ) {
    const roots = level.filter((t) =>
      ['typeid', 'is_a'].includes(
        idTypeOf(entities.get(t) ?? subtypeRows.get(t) ?? {}),
      ),
    );
    const found = await pg.readIn('entities', 'id_refentity', roots, {
      key: 'table_name',
      unique: false,
      filters: ['id_type=eq.is_a'],
    });
    level = [];
    for (const entity of found) {
      const name = entity.table_name as string;
      if (walked.has(name)) continue;
      walked.add(name);
      subtypeRows.set(name, entity);
      level.push(name);
    }
  }
  const subtypesOf = (table: string): Map<string, string> => {
    const out = new Map<string, string>();
    const below = [table];
    for (let i = 0; i < below.length; i++) {
      for (const [name, entity] of subtypeRows) {
        if (entity.id_refentity !== below[i] || below.includes(name)) continue;
        below.push(name);
        if (entity.id_prefix) out.set(String(entity.id_prefix), name);
      }
    }
    return out;
  };

  // Fields: the target's, overlaid with what the file defines.
  const fieldsOf = new Map<string, Map<string, Row>>();
  for (const name of entities.keys()) fieldsOf.set(name, new Map());
  for (const field of await pg.readIn(
    'fields',
    'table_name',
    [...entities.keys()].filter((n) => onTarget.has(n)),
    { key: 'id', unique: false },
  )) {
    fieldsOf
      .get(field.table_name as string)
      ?.set(field.field_name as string, field);
  }
  for (const [name, definition] of defined) {
    const own = fieldsOf.get(name);
    if (!own) continue;
    for (const field of definition.fields) {
      const fieldName = field.field_name as string;
      own.set(fieldName, { ...own.get(fieldName), ...field });
    }
  }

  const chainOf = (table: string): string[] => {
    const chain = [table];
    for (let entity = entities.get(table); entity; ) {
      const base = baseOf(entity);
      if (!base || chain.includes(base) || !entities.has(base)) break;
      chain.push(base);
      entity = entities.get(base);
    }
    return chain;
  };

  const result = new Map<string, TableCatalog>();
  for (const table of tables) {
    const entity = entities.get(table);
    if (!entity) continue;
    const chain = chainOf(table);
    const fields = new Map<string, Row>();
    const skip = new Set<string>();
    // Bases first, so a field of the entity itself wins over one it inherits.
    for (const level of [...chain].reverse()) {
      for (const [name, field] of fieldsOf.get(level) ?? []) {
        fields.set(name, field);
        if (field.ctype === 'audit' || field.ctype === 'rollup') skip.add(name);
      }
      const computed = entities.get(level)?.computed_fields;
      for (const rule of Array.isArray(computed) ? (computed as Row[]) : []) {
        if (typeof rule?.name === 'string') skip.add(rule.name);
      }
    }
    result.set(table, {
      table,
      entity,
      idColumn: (entity.id_column as string) || 'id',
      idType: idTypeOf(entity),
      idPrefix: String(entity.id_prefix ?? ''),
      base: baseOf(entity),
      chain,
      fields,
      own: new Set(fieldsOf.get(table)?.keys()),
      skip,
      subtypes: TYPEID_KEYS.has(idTypeOf(entity))
        ? subtypesOf(table)
        : new Map(),
      onTarget: onTarget.has(table),
    });
  }

  // The keys references point at: the tables above, their bases, and beyond.
  const keys = new Map<string, KeyInfo>();
  const keyOf = (name: string, entity: Row): void => {
    keys.set(name, {
      idColumn: (entity.id_column as string) || 'id',
      idType: idTypeOf(entity),
      onTarget: onTarget.has(name),
    });
  };
  for (const [name, entity] of entities) keyOf(name, entity);
  const referenced = new Set<string>();
  for (const table of result.values()) {
    for (const field of table.fields.values()) {
      if (
        (field.format === 'reference' || field.format === 'parent') &&
        typeof field.reference_table === 'string' &&
        field.reference_table !== 'users' &&
        !keys.has(field.reference_table)
      ) {
        referenced.add(field.reference_table);
      }
    }
  }
  for (const entity of await pg.readIn(
    'entities',
    'table_name',
    [...referenced],
    { key: 'table_name' },
  )) {
    onTarget.add(entity.table_name as string);
    keyOf(entity.table_name as string, entity);
  }
  return { tables: result, keys };
}
