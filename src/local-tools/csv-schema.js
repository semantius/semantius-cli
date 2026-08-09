import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "csv-parse";

export const MAX_RECORDS = -1;
export const MAX_ENUM = 10;

export const ERROR_CODES = {
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INVALID_OPTION: "INVALID_OPTION",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  NOT_A_FILE: "NOT_A_FILE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  EMPTY_FILE: "EMPTY_FILE",
  NO_HEADER_ROW: "NO_HEADER_ROW",
  PARSE_ERROR: "PARSE_ERROR",
  READ_ERROR: "READ_ERROR",
  WRITE_ERROR: "WRITE_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
};

const FS_ERROR_CODE = /^E[A-Z]+$/;

export class CsvSchemaError extends Error {
  constructor(code, message, { path, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CsvSchemaError";
    this.code = code;

    if (path !== undefined) {
      this.path = path;
    }
  }

  toJSON() {
    const payload = { code: this.code, message: this.message };

    if (this.path !== undefined) {
      payload.path = this.path;
    }

    return payload;
  }
}

// Every failure funnels through here so callers always see a documented code,
// falling back to UNKNOWN_ERROR for anything we have not classified yet.
export function toCsvSchemaError(error, path) {
  if (error instanceof CsvSchemaError) {
    return error;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  const code = typeof cause.code === "string" ? cause.code : "";
  const target = path ?? (typeof cause.path === "string" ? cause.path : undefined);
  const options = { path: target, cause };

  if (code === "ENOENT") {
    return new CsvSchemaError(ERROR_CODES.FILE_NOT_FOUND, `File not found: ${target}`, options);
  }

  if (code === "EACCES" || code === "EPERM") {
    return new CsvSchemaError(
      ERROR_CODES.PERMISSION_DENIED,
      `Permission denied: ${target}`,
      options,
    );
  }

  if (code === "EISDIR") {
    return new CsvSchemaError(ERROR_CODES.NOT_A_FILE, `Not a regular file: ${target}`, options);
  }

  if (code.startsWith("CSV_")) {
    return new CsvSchemaError(
      ERROR_CODES.PARSE_ERROR,
      `Could not parse CSV (${code}): ${cause.message}`,
      options,
    );
  }

  if (FS_ERROR_CODE.test(code)) {
    return new CsvSchemaError(
      ERROR_CODES.READ_ERROR,
      `Could not read ${target} (${code}): ${cause.message}`,
      options,
    );
  }

  return new CsvSchemaError(
    ERROR_CODES.UNKNOWN_ERROR,
    cause.message || "Unknown error",
    options,
  );
}

export function toErrorJson(error, path) {
  return { error: toCsvSchemaError(error, path).toJSON() };
}

const BOOLEAN_PAIRS = new Set([
  "0|1",
  "f|t",
  "false|true",
  "n|y",
  "no|yes",
]);

// Semantius derives a `<reference>_id_label` column for every reference field, so a
// field name ending that way would collide with a generated one.
const RESERVED_FIELD_NAME = /(?:^|_)id_label$/;

function normalizeFieldName(header) {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Raw headers are not usable as physical column names, so the normalized suggestion
// is derived here instead of being left to each consumer. Names are resolved in
// column order, so the same header row always yields the same field names.
export function toFieldNames(headers) {
  const taken = new Set();

  return headers.map((header, index) => {
    const base = normalizeFieldName(header) || `field_${index + 1}`;
    let fieldName = base;
    let suffix = 1;

    while (RESERVED_FIELD_NAME.test(fieldName) || taken.has(fieldName)) {
      suffix += 1;
      fieldName = `${base}_${suffix}`;
    }

    taken.add(fieldName);
    return fieldName;
  });
}

const EMAIL_VALUE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function isEmailValue(value) {
  return EMAIL_VALUE.test(value);
}

// A protocol and a host are both required: a bare "www.example.com" is not reliably
// distinguishable from ordinary text, and schemes like mailto: carry no host.
function isUrlValue(value) {
  if (!URL_SCHEME.test(value) || /\s/.test(value)) {
    return false;
  }

  try {
    return new URL(value).host !== "";
  } catch {
    return false;
  }
}

// Semantic formats are recognized by elimination: every field starts as a candidate for
// each one and a single invalid value rules it out for good. Listing a new format here is
// all it takes to detect it. Order is the precedence order when several formats survive.
const SEMANTIC_FORMATS = [
  { name: "email", isValid: isEmailValue },
  { name: "url", isValid: isUrlValue },
];

function createColumnState(header, fieldName, colNo) {
  return {
    header,
    field_name: fieldName,
    col_no: colNo,
    precision: 0,
    format: "string",
    required: true,
    non_empty_count: 0,
    can_be_integer: true,
    can_be_number: true,
    has_leading_zero: false,
    value_length: null,
    fixed_length: true,
    is_date: true,
    is_date_only: true,
    date_signature: null,
    semantic_formats: Object.fromEntries(SEMANTIC_FORMATS.map(({ name }) => [name, true])),
    unique_values: new Set(),
  };
}

function isIntegerString(value) {
  return /^[+-]?\d+$/.test(value);
}

function hasLeadingZero(value) {
  return /^[+-]?0\d/.test(value);
}

function isNumberString(value) {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value);
}

function getDecimalPlaces(value) {
  const match = value.match(/^[+-]?(?:\d+)?(?:\.(\d+))?$/);
  return match?.[1]?.length ?? 0;
}

function parseDateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value)) {
    return null;
  }

  const parsedAt = Date.parse(value);

  if (Number.isNaN(parsedAt)) {
    return null;
  }

  return new Date(parsedAt);
}

function getDateSignature(date) {
  return date.toISOString().slice(10);
}

function addUniqueValue(state, value) {
  if (!value || state.unique_values.size >= MAX_ENUM + 1) {
    return;
  }

  state.unique_values.add(value);
}

function inspectValue(state, rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();

  if (value === "") {
    state.required = false;
    return;
  }

  state.non_empty_count += 1;
  addUniqueValue(state, value);

  if (hasLeadingZero(value)) {
    state.has_leading_zero = true;
  }

  if (state.value_length === null) {
    state.value_length = value.length;
  } else if (state.value_length !== value.length) {
    state.fixed_length = false;
  }

  if (state.can_be_integer && !isIntegerString(value)) {
    state.can_be_integer = false;
  }

  if (state.can_be_number) {
    if (!isNumberString(value)) {
      state.can_be_number = false;
    } else {
      state.precision = Math.max(state.precision, getDecimalPlaces(value));
    }
  }

  if (state.is_date) {
    const parsedDate = parseDateValue(value);

    if (!parsedDate) {
      state.is_date = false;
      state.is_date_only = false;
    } else if (state.is_date_only) {
      const signature = getDateSignature(parsedDate);

      if (state.date_signature === null) {
        state.date_signature = signature;
      } else if (state.date_signature !== signature) {
        state.is_date_only = false;
      }
    }
  }

  for (const { name, isValid } of SEMANTIC_FORMATS) {
    if (state.semantic_formats[name] && !isValid(value)) {
      state.semantic_formats[name] = false;
    }
  }
}

function getBaseFormat(state) {
  if (state.non_empty_count === 0) {
    return "string";
  }

  // Numeric-looking values with leading zeros ("007") or a uniform fixed
  // length (zip codes, "-4"/"-5" style codes) are identifiers, not numbers.
  const looks_like_identifier = state.has_leading_zero || state.fixed_length;

  if (state.can_be_integer && !looks_like_identifier) {
    return "integer";
  }

  if (state.can_be_number && !looks_like_identifier) {
    return "number";
  }

  if (state.is_date) {
    return state.is_date_only ? "date" : "date-time";
  }

  return "string";
}

function isBooleanEnum(uniqueValues) {
  if (uniqueValues.length !== 2) {
    return false;
  }

  const pair = uniqueValues
    .map((value) => value.toLowerCase())
    .sort()
    .join("|");

  return BOOLEAN_PAIRS.has(pair);
}

// A semantic format only ever refines a string: numeric and date columns already have a
// more specific format, and a column with nothing in it proves nothing.
function getSemanticFormat(state, baseFormat) {
  if (state.non_empty_count === 0 || baseFormat !== "string") {
    return null;
  }

  return SEMANTIC_FORMATS.find(({ name }) => state.semantic_formats[name])?.name ?? null;
}

function finalizeColumn(state) {
  const uniqueValues = [...state.unique_values];
  const baseFormat = getBaseFormat(state);
  const semanticFormat = getSemanticFormat(state, baseFormat);
  let format = semanticFormat ?? baseFormat;

  // A column of addresses stays an email field even when it happens to hold few enough
  // distinct values to look like an enum, so the semantic format short-circuits both.
  if (semanticFormat === null) {
    if (isBooleanEnum(uniqueValues)) {
      format = "boolean";
    } else if (uniqueValues.length > 0 && uniqueValues.length <= MAX_ENUM) {
      format = "enum";
    }
  }

  const isNumeric = baseFormat === "integer" || baseFormat === "number";

  const schema = {
    header: state.header,
    field_name: state.field_name,
    col_no: state.col_no,
    format,
    precision: isNumeric ? state.precision : 0,
    required: state.required,
  };

  if (state.required) {
    schema.input_type = "required";
  }

  if (format === "enum") {
    schema.enum_values = uniqueValues;
  } else if (format === "integer" || format === "number") {
    schema.sample_values = uniqueValues.map(Number);
  } else {
    schema.sample_values = uniqueValues;
  }

  return schema;
}

// How a consumer should get to a primary key: the file already carries an `id` column,
// the leading column is an id under another name and has to be moved into `id`, or there
// is nothing usable. Derived from the finalized fields so it agrees with the `format` a
// consumer sees. `field_name` is always lower-cased, so no case handling is needed.
function detectIdMode(fields) {
  if (fields.some((field) => field.format === "integer" && field.field_name === "id")) {
    return { id_mode: "id" };
  }

  const first = fields[0];

  if (first && first.format === "integer" && first.field_name.endsWith("id")) {
    return { id_mode: "move", id_move_column: first.header };
  }

  return { id_mode: "none" };
}

function normalizeMaxRecords(maxRecords) {
  if (!Number.isInteger(maxRecords) || maxRecords < -1) {
    throw new CsvSchemaError(
      ERROR_CODES.INVALID_OPTION,
      "maxRecords must be an integer >= -1",
    );
  }

  return maxRecords;
}

function resolvePathArgument(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CsvSchemaError(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a non-empty string`);
  }

  return resolve(value);
}

// stat() first so a missing or unreadable path fails as a rejected promise
// instead of an unhandled 'error' event on the read stream.
async function assertReadableCsvFile(resolvedPath) {
  let stats;

  try {
    stats = await stat(resolvedPath);
  } catch (error) {
    throw toCsvSchemaError(error, resolvedPath);
  }

  if (!stats.isFile()) {
    throw new CsvSchemaError(
      ERROR_CODES.NOT_A_FILE,
      `Not a regular file: ${resolvedPath}`,
      { path: resolvedPath },
    );
  }

  if (stats.size === 0) {
    throw new CsvSchemaError(ERROR_CODES.EMPTY_FILE, `File is empty: ${resolvedPath}`, {
      path: resolvedPath,
    });
  }
}

export async function inspectCsvFile(filePath, { maxRecords = MAX_RECORDS } = {}) {
  const resolvedPath = resolvePathArgument(filePath, "filePath");
  const recordLimit = normalizeMaxRecords(maxRecords);

  await assertReadableCsvFile(resolvedPath);

  const source = createReadStream(resolvedPath);
  const parser = parse({
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
    trim: false,
  });

  // .pipe() does not forward source errors, so a read failure after the stat()
  // above (deleted file, I/O error) would otherwise kill the host process.
  source.on("error", (error) => parser.destroy(error));
  source.pipe(parser);

  let headers = null;
  let states = [];
  let recordCount = 0;

  try {
    for await (const row of parser) {
      if (headers === null) {
        headers = row.map((value) => String(value));
        const fieldNames = toFieldNames(headers);
        states = headers.map((header, index) =>
          createColumnState(header, fieldNames[index], index + 1),
        );
        continue;
      }

      if (recordLimit !== -1 && recordCount >= recordLimit) {
        break;
      }

      for (let index = 0; index < states.length; index += 1) {
        inspectValue(states[index], row[index] ?? "");
      }

      recordCount += 1;
    }
  } catch (error) {
    throw toCsvSchemaError(error, resolvedPath);
  } finally {
    // Breaking out early on maxRecords only destroys the parser, not the source.
    source.destroy();
  }

  if (headers === null || headers.every((header) => header.trim() === "")) {
    throw new CsvSchemaError(
      ERROR_CODES.NO_HEADER_ROW,
      `No header row found in ${resolvedPath}`,
      { path: resolvedPath },
    );
  }

  const fields = states.map(finalizeColumn);

  return { ...detectIdMode(fields), record_count: recordCount, fields };
}

export async function writeSchemaFile(
  filePath,
  outputPath = `${filePath}.csvschema.json`,
  options = {},
) {
  const resolvedOutputPath = resolvePathArgument(outputPath, "outputPath");
  const schema = await inspectCsvFile(filePath, options);
  const serialized = `${JSON.stringify(schema, null, 2)}\n`;

  try {
    await writeFile(resolvedOutputPath, serialized, "utf8");
  } catch (error) {
    throw new CsvSchemaError(
      ERROR_CODES.WRITE_ERROR,
      `Could not write schema to ${resolvedOutputPath}: ${error.message}`,
      { path: resolvedOutputPath, cause: error },
    );
  }

  return { outputPath: resolvedOutputPath, schema };
}
