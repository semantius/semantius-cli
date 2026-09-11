/**
 * Helpers for bulk (array) support in the typed CRUD tools.
 *
 * - `oneOrMany(schema)`      : input schema accepting one value or a non-empty array of values
 * - `keyFilter(col, value)`  : PostgREST filter `col=eq.v` (scalar) or `col=in.(v1,v2)` (array)
 * - `bulkInsertOptions(...)` : path + headers for a POST whose body may be an array of records
 */

import { z } from 'zod/v4'

/** Single value/record or a non-empty array of them. */
export function oneOrMany<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.array(schema).min(1)])
}

type Key = string | number
type Row = Record<string, unknown>

/**
 * Quote a value for PostgREST `in.()` lists and the `columns=` parameter.
 * Plain values are passed through; anything else is double-quoted with `\` and `"` escaped.
 */
function quoteIfNeeded(v: Key): string {
  const s = String(v)
  return /^[A-Za-z0-9_$.\-:@]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, '\\$&')}"`
}

/**
 * Build the key filter for update/delete paths.
 * Scalar  -> `col=eq.v`      (byte-identical to the previous single-record behaviour)
 * Array   -> `col=in.(v1,v2)` (also for a one-element array)
 */
export function keyFilter(column: string, value: Key | ReadonlyArray<Key>): string {
  return Array.isArray(value)
    ? `${column}=in.(${value.map(quoteIfNeeded).join(',')})`
    : `${column}=eq.${value}`
}

/**
 * Path and additional headers for a POST.
 * Object -> unchanged path, `accept` forwarded when given.
 * Array  -> `?columns=<union of keys, first-seen order>` so items may have differing keys,
 *           plus `Prefer: return=representation,missing=default` so keys omitted from an item
 *           take the column DEFAULT (an explicit null still inserts NULL).
 *           If no item has any key, the columns parameter is omitted.
 */
export function bulkInsertOptions(
  path: string,
  data: Row | Row[],
  accept?: string,
): { path: string; additionalHeaders?: Record<string, string> } {
  if (!Array.isArray(data)) {
    return { path, additionalHeaders: accept ? { accept } : undefined }
  }
  const columns = [...new Set(data.flatMap((row) => Object.keys(row).filter((k) => row[k] !== undefined)))]
  return {
    path: columns.length ? `${path}?columns=${columns.map(quoteIfNeeded).join(',')}` : path,
    additionalHeaders: {
      prefer: 'return=representation,missing=default',
      ...(accept ? { accept } : {}),
    },
  }
}
