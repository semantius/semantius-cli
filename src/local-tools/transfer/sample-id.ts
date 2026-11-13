/**
 * Sample ids: the short form a hand-written records file may carry where a
 * TypeID belongs, and the full TypeID the import writes for it.
 *
 *   cand_sr1   →  cand_0sr1xxxxxxxxxxxxxxxxxxxxxx
 *   cand_sr10  →  cand_0sr10xxxxxxxxxxxxxxxxxxxxx
 *
 * A TypeID is its entity's prefix, "_", and 26 characters of the base32
 * alphabet, the first of them 0-7 (the platform's common.typeid domain, whose
 * check is that format and nothing else). Nobody types 26 exact characters, so
 * a record made by hand names itself `<prefix>_sr<n>` and the import pads it:
 * "0" (the first character may not be a letter), "sr", the number as written,
 * then "x" up to 26. The filler is a letter because zeros would make sr1, sr10
 * and sr100 one id.
 *
 * The short form is never a TypeID (its part after the prefix is too short and
 * starts with a letter), so padding cannot touch an id that is already one. It
 * is applied only where the catalog says a TypeID belongs: the key of an
 * entity keyed by one, and a reference or parent column that points at one.
 * An export never writes the short form: it reads the full id back.
 */

/** The id_type values whose key column is a TypeID. */
export const TYPEID_KEYS: ReadonlySet<string> = new Set([
  'typeid',
  'is_a',
  'has_a',
]);

const PREFIX = '[a-z](?:[a-z_]{0,61}[a-z])?';
const SUFFIX_LENGTH = 26;
/** `0sr` and the number must leave room inside the 26 characters. */
const SAMPLE = new RegExp(`^(${PREFIX})_sr([0-9]{1,${SUFFIX_LENGTH - 3}})$`);
/** The platform's common.typeid_check_text, with the prefix captured. */
const TYPEID = new RegExp(
  `^(?:(${PREFIX})_)?[0-7][0-9abcdefghjkmnpqrstvwxyz]{${SUFFIX_LENGTH - 1}}$`,
);

/** `value` with a sample id padded to its TypeID; anything else unchanged. */
export function padSampleId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = SAMPLE.exec(value);
  if (!match) return value;
  const body = `0sr${match[2]}`;
  return `${match[1]}_${body}${'x'.repeat(SUFFIX_LENGTH - body.length)}`;
}

/** Whether `value` is a well-formed TypeID, as the platform checks it. */
export function isTypeId(value: unknown): value is string {
  return typeof value === 'string' && TYPEID.test(value);
}

/** The prefix of a well-formed TypeID, '' when it has none. */
export function typeIdPrefix(value: string): string {
  return TYPEID.exec(value)?.[1] ?? '';
}
