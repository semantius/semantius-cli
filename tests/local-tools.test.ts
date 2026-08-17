/**
 * Unit tests for the built-in "utils" server (src/local-tools/)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, readFile, copyFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBuiltinConnection } from '../src/local-tools/connection';
import { UTILS_INSTRUCTIONS, localTools } from '../src/local-tools/index';
import type { CsvSchema } from '../src/local-tools/csv-schema';
import type { ServerConfig } from '../src/config';

const BUILTIN_CONFIG: ServerConfig = { builtin: true };
const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function resultText(result: unknown): string {
  return (result as ToolResult).content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text as string)
    .join('\n');
}

function resultJson(result: unknown): any {
  return JSON.parse(resultText(result));
}

/** Runs a tool call against a fresh in-process utils connection. */
async function callUtils(
  toolName: string,
  args: Record<string, unknown>,
  config: ServerConfig = BUILTIN_CONFIG,
): Promise<unknown> {
  const conn = await createBuiltinConnection('utils', config);
  try {
    return await conn.callTool(toolName, args);
  } finally {
    await conn.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('local-tools', () => {
  let tempDir: string;
  let csvPath: string;
  let expectedSchema: CsvSchema;

  /** Copies a fixture into tempDir, since the tool writes next to its input. */
  async function useFixture(name: string): Promise<string> {
    const path = join(tempDir, name);
    await copyFile(join(FIXTURES_DIR, name), path);
    return path;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-local-tools-'));
    // The tool writes its output next to the input, so work on a copy.
    csvPath = await useFixture('mixed.csv');
    expectedSchema = JSON.parse(
      await readFile(join(FIXTURES_DIR, 'mixed.csvschema.json'), 'utf8'),
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('registry contains get_csvschema', () => {
    expect(localTools.map((t) => t.name)).toEqual(['get_csvschema']);
  });

  describe('createBuiltinConnection', () => {
    test('listTools returns get_csvschema with its schema', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        const tools = await conn.listTools();
        expect(tools.map((t) => t.name)).toEqual(['get_csvschema']);
        expect(tools[0].description).toBeTruthy();
        const properties = tools[0].inputSchema.properties as Record<
          string,
          unknown
        >;
        expect(properties.path).toBeDefined();
        expect(properties.maxRecords).toBeDefined();
      } finally {
        await conn.close();
      }
    });

    test('getInstructions returns the utils instructions', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        expect(await conn.getInstructions()).toBe(UTILS_INSTRUCTIONS);
        expect(conn.isDaemon).toBe(false);
      } finally {
        await conn.close();
      }
    });

    test('disabledTools filters listTools and blocks callTool', async () => {
      const conn = await createBuiltinConnection('utils', {
        builtin: true,
        disabledTools: ['get_csvschema'],
      });
      try {
        expect(await conn.listTools()).toEqual([]);
        await expect(
          conn.callTool('get_csvschema', { path: csvPath }),
        ).rejects.toThrow('disabled by configuration');
      } finally {
        await conn.close();
      }
    });
  });

  describe('get_csvschema', () => {
    test('writes <file>.csvschema.json and returns the schema', async () => {
      const result = await callUtils('get_csvschema', { path: csvPath });

      expect((result as ToolResult).isError).toBeFalsy();
      const { outputPath, schema } = resultJson(result);
      expect(outputPath).toBe(`${csvPath}.csvschema.json`);
      // Shares the upstream golden file: catches a stale vendored copy or a
      // csv-parse behaviour change.
      expect(schema).toEqual(expectedSchema);
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(
        expectedSchema,
      );
    });

    test('infers formats across the fixture columns', async () => {
      const result = await callUtils('get_csvschema', { path: csvPath });
      const { schema } = resultJson(result);
      const byName = Object.fromEntries(
        (schema as CsvSchema).fields.map((f) => [f.field_name, f]),
      );

      expect(byName.id.format).toBe('integer');
      expect(byName.price.format).toBe('number');
      expect(byName.price.precision).toBe(3);
      expect(byName.category.format).toBe('enum');
      expect(byName.category.enum_values).toEqual(['alpha', 'beta', 'gamma']);
      expect(byName.flag01.format).toBe('boolean');
      expect(byName.optional.required).toBe(false);
      // "date" is date-only; a value with a time component is "date-time".
      expect(byName.birth_date.format).toBe('date');
      expect(byName.updated_at.format).toBe('date-time');
      expect(byName.status.format).toBe('string');
      expect(byName.email.format).toBe('email');
      expect(byName.website.format).toBe('url');
    });

    test('exports input_type only for required fields', async () => {
      const result = await callUtils('get_csvschema', { path: csvPath });
      const byName = Object.fromEntries(
        (resultJson(result).schema as CsvSchema).fields.map((f) => [
          f.field_name,
          f,
        ]),
      );

      // `required` describes the CSV; `input_type` is what create_field takes.
      expect(byName.id.required).toBe(true);
      expect(byName.id.input_type).toBe('required');
      expect(byName.optional.required).toBe(false);
      expect(byName.optional.input_type).toBeUndefined();
    });

    test('reports id_mode and record_count', async () => {
      const idResult = await callUtils('get_csvschema', { path: csvPath });
      const idSchema = resultJson(idResult).schema as CsvSchema;
      // mixed.csv has an integer `id` column, and 12 data rows.
      expect(idSchema.id_mode).toBe('id');
      expect(idSchema.id_move_column).toBeUndefined();
      expect(idSchema.record_count).toBe(12);

      const movePath = await useFixture('id-move.csv');
      const moveSchema = resultJson(
        await callUtils('get_csvschema', { path: movePath }),
      ).schema as CsvSchema;
      // Leading integer column named like an id: the raw header is the one to
      // move into `id`, not the normalized field_name.
      expect(moveSchema.id_mode).toBe('move');
      expect(moveSchema.id_move_column).toBe('Customer Id');

      const nonePath = await useFixture('id-none.csv');
      const noneSchema = resultJson(
        await callUtils('get_csvschema', { path: nonePath }),
      ).schema as CsvSchema;
      // `id` here is a string, and the integer id column is not first.
      expect(noneSchema.id_mode).toBe('none');
      expect(noneSchema.id_move_column).toBeUndefined();
    });

    test('detects email and url, and prefers them over enum', async () => {
      const formatsPath = await useFixture('formats.csv');
      const result = await callUtils('get_csvschema', { path: formatsPath });

      expect((result as ToolResult).isError).toBeFalsy();
      const byName = Object.fromEntries(
        (resultJson(result).schema as CsvSchema).fields.map((f) => [
          f.field_name,
          f,
        ]),
      );

      expect(byName.email.format).toBe('email');
      expect(byName.website.format).toBe('url');
      // Few enough distinct addresses to look like an enum; email still wins,
      // so the column exports sample_values rather than enum_values.
      expect(byName.few_emails.format).toBe('email');
      expect(byName.few_emails.enum_values).toBeUndefined();
      expect(byName.few_emails.sample_values).toBeTruthy();
      // One bad value rules the candidate out for the whole column.
      expect(byName.bad_email.format).toBe('string');
      // No scheme, so not reliably a url.
      expect(byName.bare_host.format).toBe('string');
      // Empty values only clear `required`; they never rule a format out.
      expect(byName.nullable_email.format).toBe('email');
      expect(byName.nullable_email.required).toBe(false);
      // Nothing non-empty proves nothing.
      expect(byName.blank.format).toBe('string');
    });

    test('keeps the raw header and adds a normalized field_name', async () => {
      const headersPath = await useFixture('headers.csv');

      const result = await callUtils('get_csvschema', { path: headersPath });

      expect((result as ToolResult).isError).toBeFalsy();
      const { schema } = resultJson(result);
      expect(
        (schema as CsvSchema).fields.map(({ header, field_name }) => [
          header,
          field_name,
        ]),
      ).toEqual([
        ['First Name', 'first_name'],
        // Collides with column 1 once normalized, so it is deduped.
        ['first-name', 'first_name_2'],
        ['  Total (€) ', 'total'],
        // Semantius generates <reference>_id_label columns, so the raw form is
        // reserved and the suggestion is suffixed away from it.
        ['customer_id_label', 'customer_id_label_2'],
        ['', 'field_5'],
        ['2024 Revenue', '2024_revenue'],
        ['id label', 'id_label_2'],
      ]);
    });

    test('maxRecords caps how much of the file is inspected', async () => {
      const result = await callUtils('get_csvschema', {
        path: csvPath,
        maxRecords: 1,
      });

      expect((result as ToolResult).isError).toBeFalsy();
      const schema = resultJson(result).schema as CsvSchema;
      const category = schema.fields.find((f) => f.field_name === 'category');
      // Only the first data row was read, so the enum has a single value.
      expect(category?.enum_values).toEqual(['alpha']);
      // record_count reflects the capped scan, not the file's 12 rows.
      expect(schema.record_count).toBe(1);
    });

    test('resolves relative paths against cwd', async () => {
      // relative() may return an absolute path when tmpdir is on another
      // drive (Windows); the library resolves both against cwd.
      const relPath = relative(process.cwd(), csvPath);
      const result = await callUtils('get_csvschema', { path: relPath });

      expect((result as ToolResult).isError).toBeFalsy();
      // Compare via relative() so a drive-letter case difference between
      // process.cwd() and tmpdir (e.g. "c:\" vs "C:\") doesn't fail the test.
      const outputPath = resultJson(result).outputPath as string;
      expect(relative(outputPath, `${csvPath}.csvschema.json`)).toBe('');
    });

    test('rejects an out-of-range maxRecords at schema validation', async () => {
      const result = await callUtils('get_csvschema', {
        path: csvPath,
        maxRecords: -2,
      });

      // The zod schema rejects this before the handler runs, so the message is
      // the MCP validation error rather than the library's INVALID_OPTION.
      expect((result as ToolResult).isError).toBe(true);
      expect(resultText(result)).toContain('maxRecords');
    });

    test('missing file returns FILE_NOT_FOUND without killing the process', async () => {
      const missing = join(tempDir, 'does-not-exist.csv');
      const result = await callUtils('get_csvschema', { path: missing });

      expect((result as ToolResult).isError).toBe(true);
      const { error } = resultJson(result);
      expect(error.code).toBe('FILE_NOT_FOUND');
      expect(error.path).toBe(missing);
      expect(await exists(`${missing}.csvschema.json`)).toBe(false);
    });

    test('directory returns NOT_A_FILE', async () => {
      const result = await callUtils('get_csvschema', { path: tempDir });

      expect((result as ToolResult).isError).toBe(true);
      expect(resultJson(result).error.code).toBe('NOT_A_FILE');
      expect(await exists(`${tempDir}.csvschema.json`)).toBe(false);
    });

    test('empty file returns EMPTY_FILE', async () => {
      const emptyPath = join(tempDir, 'empty.csv');
      await writeFile(emptyPath, '');

      const result = await callUtils('get_csvschema', { path: emptyPath });

      expect((result as ToolResult).isError).toBe(true);
      expect(resultJson(result).error.code).toBe('EMPTY_FILE');
      expect(await exists(`${emptyPath}.csvschema.json`)).toBe(false);
    });

    test('unparsable CSV returns PARSE_ERROR', async () => {
      const badPath = join(tempDir, 'unparsable.csv');
      await copyFile(join(FIXTURES_DIR, 'unparsable.csv'), badPath);

      const result = await callUtils('get_csvschema', { path: badPath });

      expect((result as ToolResult).isError).toBe(true);
      expect(resultJson(result).error.code).toBe('PARSE_ERROR');
      expect(await exists(`${badPath}.csvschema.json`)).toBe(false);
    });
  });
});
