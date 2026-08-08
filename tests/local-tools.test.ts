/**
 * Unit tests for the built-in "utils" server (src/local-tools/)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createBuiltinConnection } from '../src/local-tools/connection';
import { UTILS_INSTRUCTIONS, localTools } from '../src/local-tools/index';
import type { ServerConfig } from '../src/config';

const BUILTIN_CONFIG: ServerConfig = { builtin: true };

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

describe('local-tools', () => {
  let tempDir: string;
  let testFilePath: string;
  const testContent = 'Hello from local-tools test!';

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'semantius-local-tools-'));
    testFilePath = join(tempDir, 'sample.txt');
    await writeFile(testFilePath, testContent);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('registry contains file-size and file-date', () => {
    expect(localTools.map((t) => t.name)).toEqual(['file-size', 'file-date']);
  });

  describe('createBuiltinConnection', () => {
    test('listTools returns both tools with schemas', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        const tools = await conn.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(['file-date', 'file-size']);
        for (const tool of tools) {
          expect(tool.description).toBeTruthy();
          const properties = tool.inputSchema.properties as Record<
            string,
            unknown
          >;
          expect(properties.path).toBeDefined();
        }
      } finally {
        await conn.close();
      }
    });

    test('file-size returns the byte size of a file', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        const result = await conn.callTool('file-size', {
          path: testFilePath,
        });
        expect((result as ToolResult).isError).toBeFalsy();
        expect(resultText(result)).toBe(
          String(Buffer.byteLength(testContent)),
        );
      } finally {
        await conn.close();
      }
    });

    test('file-date returns a JSON-encoded ISO 8601 mtime', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        const result = await conn.callTool('file-date', {
          path: testFilePath,
        });
        expect((result as ToolResult).isError).toBeFalsy();
        const text = resultText(result);
        // JSON-encoded string, e.g. "2026-08-06T20:53:10.548Z"
        const parsed = JSON.parse(text);
        expect(typeof parsed).toBe('string');
        expect(new Date(parsed).toISOString()).toBe(parsed);
      } finally {
        await conn.close();
      }
    });

    test('resolves relative paths against cwd', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        // relative() may return an absolute path when tmpdir is on another
        // drive (Windows); resolve(cwd, ...) handles both cases.
        const relPath = relative(process.cwd(), testFilePath);
        const result = await conn.callTool('file-size', { path: relPath });
        expect((result as ToolResult).isError).toBeFalsy();
        expect(resultText(result)).toBe(
          String(Buffer.byteLength(testContent)),
        );
      } finally {
        await conn.close();
      }
    });

    test('missing file returns isError with the resolved path', async () => {
      const conn = await createBuiltinConnection('utils', BUILTIN_CONFIG);
      try {
        const missing = join(tempDir, 'does-not-exist.txt');
        const result = await conn.callTool('file-size', { path: missing });
        expect((result as ToolResult).isError).toBe(true);
        expect(resultText(result)).toContain(resolve(missing));
      } finally {
        await conn.close();
      }
    });

    test('disabledTools filters listTools and blocks callTool', async () => {
      const conn = await createBuiltinConnection('utils', {
        builtin: true,
        disabledTools: ['file-date'],
      });
      try {
        const tools = await conn.listTools();
        expect(tools.map((t) => t.name)).toEqual(['file-size']);
        await expect(
          conn.callTool('file-date', { path: testFilePath }),
        ).rejects.toThrow('disabled by configuration');
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
  });
});
