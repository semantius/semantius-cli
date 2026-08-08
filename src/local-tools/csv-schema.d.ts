/**
 * Type declarations for the vendored ./csv-schema.js.
 *
 * csv-schema.js is a VERBATIM copy of src/index.js from
 * https://github.com/semantius/csv-schema at commit 7288e4b. That repo is
 * private and unpublished, so it cannot be a dependency — CI and the release
 * build only check out semantius-cli. Re-sync with a plain copy:
 *
 *   cp ../csv-schema/src/index.js src/local-tools/csv-schema.js
 *
 * Never edit or reformat the .js (it is excluded from biome in biome.json so
 * it keeps diffing clean against upstream). Update THIS file whenever
 * upstream's exports change.
 */

export type CsvFieldFormat =
  | 'integer'
  | 'number'
  | 'date'
  | 'date-only'
  | 'string'
  | 'bool'
  | 'enum';

export interface FieldSchema {
  field_name: string;
  col_no: number;
  format: CsvFieldFormat;
  decimal_places: number;
  required: boolean;
  /** Present only when format is "enum". */
  enum_values?: string[];
  /** Present for every non-enum format. Numbers for integer/number fields. */
  sample_values?: Array<string | number>;
}

export interface InspectOptions {
  /** Data records to inspect. -1 (the default) inspects the whole file. */
  maxRecords?: number;
}

/** -1: inspect every data record. */
export const MAX_RECORDS: number;
/** Maximum unique values for a field to be treated as an enum. */
export const MAX_ENUM: number;

export const ERROR_CODES: {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  INVALID_OPTION: 'INVALID_OPTION';
  FILE_NOT_FOUND: 'FILE_NOT_FOUND';
  NOT_A_FILE: 'NOT_A_FILE';
  PERMISSION_DENIED: 'PERMISSION_DENIED';
  EMPTY_FILE: 'EMPTY_FILE';
  NO_HEADER_ROW: 'NO_HEADER_ROW';
  PARSE_ERROR: 'PARSE_ERROR';
  READ_ERROR: 'READ_ERROR';
  WRITE_ERROR: 'WRITE_ERROR';
  UNKNOWN_ERROR: 'UNKNOWN_ERROR';
};

export type CsvSchemaErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface CsvSchemaErrorJson {
  code: string;
  message: string;
  path?: string;
}

export class CsvSchemaError extends Error {
  constructor(
    code: string,
    message: string,
    options?: { path?: string; cause?: unknown },
  );
  code: string;
  path?: string;
  toJSON(): CsvSchemaErrorJson;
}

/** Normalizes any thrown value into a CsvSchemaError with a documented code. */
export function toCsvSchemaError(error: unknown, path?: string): CsvSchemaError;

export function toErrorJson(
  error: unknown,
  path?: string,
): { error: CsvSchemaErrorJson };

export function inspectCsvFile(
  filePath: string,
  options?: InspectOptions,
): Promise<FieldSchema[]>;

export function writeSchemaFile(
  filePath: string,
  outputPath?: string,
  options?: InspectOptions,
): Promise<{ outputPath: string; schema: FieldSchema[] }>;
