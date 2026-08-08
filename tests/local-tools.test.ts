/**
 * Unit tests for the built-in "utils" server (src/local-tools/)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, readFile, copyFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createBuiltinConnection } from '../src/local-tools/connection';
import { UTILS_INSTRUCTIONS, localTools } from '../src/local-tools/index';
import type { FieldSchema } from '../src/local-tools/csv-schema';
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
  let expectedSchema: FieldSchema[];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-local-tools-'));
    // The tool writes its output next to the input, so work on a copy.
    csvPath = join(tempDir, 'mixed.csv');
    await copyFile(join(FIXTURES_DIR, 'mixed.csv'), csvPath);
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
        (schema as FieldSchema[]).map((f) => [f.field_name, f]),
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
    });

    test('keeps the raw header and adds a normalized field_name', async () => {
      const headersPath = join(tempDir, 'headers.csv');
      await copyFile(join(FIXTURES_DIR, 'headers.csv'), headersPath);

      const result = await callUtils('get_csvschema', { path: headersPath });

      expect((result as ToolResult).isError).toBeFalsy();
      const { schema } = resultJson(result);
      expect(
        (schema as FieldSchema[]).map(({ header, field_name }) => [
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
      const { schema } = resultJson(result);
      const category = (schema as FieldSchema[]).find(
        (f) => f.field_name === 'category',
      );
      // Only the first data row was read, so the enum has a single value.
      expect(category?.enum_values).toEqual(['alpha']);
    });

    test('resolves relative paths against cwd', async () => {
      // relative() may return an absolute path when tmpdir is on another
      // drive (Windows); the library resolves both against cwd.
      const relPath = relative(process.cwd(), csvPath);
      const result = await callUtils('get_csvschema', { path: relPath });

      expect((result as ToolResult).isError).toBeFalsy();
      expect(resultJson(result).outputPath).toBe(`${csvPath}.csvschema.json`);
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
