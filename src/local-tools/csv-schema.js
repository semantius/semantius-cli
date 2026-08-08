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

function createColumnState(fieldName, colNo) {
  return {
    field_name: fieldName,
    col_no: colNo,
    decimal_places: 0,
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
      state.decimal_places = Math.max(state.decimal_places, getDecimalPlaces(value));
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
    return state.is_date_only ? "date-only" : "date";
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

function finalizeColumn(state) {
  const uniqueValues = [...state.unique_values];
  const baseFormat = getBaseFormat(state);
  let format = baseFormat;

  if (isBooleanEnum(uniqueValues)) {
    format = "bool";
  } else if (uniqueValues.length > 0 && uniqueValues.length <= MAX_ENUM) {
    format = "enum";
  }

  const isNumeric = baseFormat === "integer" || baseFormat === "number";

  const schema = {
    field_name: state.field_name,
    col_no: state.col_no,
    format,
    decimal_places: isNumeric ? state.decimal_places : 0,
    required: state.required,
  };

  if (format === "enum") {
    schema.enum_values = uniqueValues;
  } else if (format === "integer" || format === "number") {
    schema.sample_values = uniqueValues.map(Number);
  } else {
    schema.sample_values = uniqueValues;
  }

  return schema;
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
        states = headers.map((fieldName, index) => createColumnState(fieldName, index + 1));
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

  if (headers === null || headers.every((fieldName) => fieldName.trim() === "")) {
    throw new CsvSchemaError(
      ERROR_CODES.NO_HEADER_ROW,
      `No header row found in ${resolvedPath}`,
      { path: resolvedPath },
    );
  }

  return states.map(finalizeColumn);
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
