/**
 * Integration tests for CLI commands using the filesystem MCP server
 *
 * These tests spawn the actual CLI and test against a real MCP server.
 * They require npx and @modelcontextprotocol/server-filesystem to be available.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, readFile, copyFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI Integration Tests', () => {
  let tempDir: string;
  let configPath: string;
  let testFilePath: string;
  let csvFilePath: string;

  beforeAll(async () => {
    // Create temp directory for test files
    // Use realpath() to resolve Windows 8.3 short names (e.g., RUNNER~1 → runneradmin)
    // so the path matches what the MCP filesystem server expects
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'semantius-cli-integration-')));

    // Create a test file to read
    testFilePath = join(tempDir, 'test.txt');
    await writeFile(testFilePath, 'Hello from test file!');

    // CSV for the built-in utils server; copied because get_csvschema writes
    // its output next to the input file
    csvFilePath = join(tempDir, 'mixed.csv');
    await copyFile(join(import.meta.dir, '..', 'fixtures', 'mixed.csv'), csvFilePath);

    // Create subdirectory with more files
    const subDir = join(tempDir, 'subdir');
    await mkdir(subDir);
    await writeFile(join(subDir, 'nested.txt'), 'Nested content');

    // Create config pointing to the temp directory
    // Note: npm_config_registry override ensures npx uses public npm registry
    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
            env: {
              npm_config_registry: 'https://registry.npmjs.org',
            },
          },
        },
      })
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper to run CLI commands
  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');

    try {
      // Use Bun.spawn for cross-platform compatibility (Windows + Unix)
      // - stdin: null prevents hanging when CLI tries to read stdin
      // - env is passed explicitly for reliable cross-platform behavior
      const proc = Bun.spawn(['bun', 'run', cliPath, '-c', configPath, ...args], {
        env: { ...process.env, SEMANTIUS_NO_DAEMON: '1', SEMANTIUS_API_KEY: 'test-api-key', SEMANTIUS_ORG: 'test-org', SEMANTIUS_JWT: '' },
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { stdout, stderr, exitCode };
    } catch (error: any) {
      return {
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
        exitCode: error.exitCode || 1,
      };
    }
  }

  describe('--help', () => {
    test('shows help message', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const proc = Bun.spawn(['bun', 'run', cliPath, '--help'], {
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(exitCode).toBe(0);
      expect(stdout).toContain('semantius');
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('Options:');
    });
  });

  describe('--version', () => {
    test('shows version', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const proc = Bun.spawn(['bun', 'run', cliPath, '--version'], {
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/semantius v\d+\.\d+\.\d+/);
    });
  });

  describe('list command', () => {
    test('lists servers and tools', async () => {
      const result = await runCli([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
      // Should contain filesystem tools
      expect(result.stdout).toMatch(/read_file|list_directory|write_file/);
    });

    test('lists with descriptions using -d flag', async () => {
      const result = await runCli(['-d']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
      // Descriptions should be present (checking for common patterns)
      expect(result.stdout.length).toBeGreaterThan(100);
    });

  });

  describe('grep command', () => {
    test('searches tools by pattern', async () => {
      const result = await runCli(['grep', '*file*']);

      expect(result.exitCode).toBe(0);
      // Should find file-related tools (space-separated format: server tool)
      expect(result.stdout).toContain('read_file ');
    });

    test('searches with descriptions', async () => {
      const result = await runCli(['grep', '*directory*', '-d']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
    });


    test('shows message for no matches', async () => {
      const result = await runCli(['grep', '*nonexistent_xyz_123*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tools found');
      expect(result.stdout).toContain('Tip:');
    });
  });

  describe('info command (server)', () => {
    test('shows server details', async () => {
      const result = await runCli(['info', 'filesystem']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('filesystem');
      expect(result.stdout).toContain('Transport:');
      expect(result.stdout).toContain('Tools');
    });


    test('errors on unknown server', async () => {
      const result = await runCli(['info', 'nonexistent_server']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('info command (tool)', () => {
    test('shows tool schema', async () => {
      const result = await runCli(['info', 'filesystem', 'read_file']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Tool:');
      expect(result.stdout).toContain('read_file');
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('filesystem');
      expect(result.stdout).toContain('Input Schema:');
    });


    test('errors on unknown tool', async () => {
      const result = await runCli(['info', 'filesystem', 'nonexistent_tool']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('call command', () => {
    test('calls read_file tool', async () => {
      const result = await runCli([
        '--diag',
        'call',
        'filesystem',
        'read_file',
        JSON.stringify({ path: testFilePath }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello from test file!');
    });

    test('calls list_directory tool', async () => {
      const result = await runCli([
        '--diag',
        'call',
        'filesystem',
        'list_directory',
        JSON.stringify({ path: tempDir }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test.txt');
      expect(result.stdout).toContain('subdir');
    });


    test('handles tool errors gracefully', async () => {
      // Use a nonexistent path inside the temp directory to stay within
      // the filesystem server's allowed directories (cross-platform safe)
      const nonexistentPath = join(tempDir, 'nonexistent', 'path', 'file.txt');
      const result = await runCli([
        'call',
        'filesystem',
        'read_file',
        JSON.stringify({ path: nonexistentPath }),
      ]);

      // Server may return error as content or fail - verify error is reported
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/denied|error|not found|outside|allowed|no such file/i);
    });

    test('handles invalid JSON arguments', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', 'not valid json']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    test('calls tool with no arguments', async () => {
      // list_directory might work with default path
      const result = await runCli(['call', 'filesystem', 'list_directory', '{}']);

      // May succeed or fail depending on server implementation
      // We just verify it doesn't crash
      expect(typeof result.exitCode).toBe('number');
    });

    test('outputs raw text content, not MCP envelope (issue #25)', async () => {
      // --diag bypasses JSON extraction for servers that return plain text.
      // Verifies the MCP protocol envelope is never surfaced in output.
      const result = await runCli([
        '--diag',
        'call',
        'filesystem',
        'read_file',
        JSON.stringify({ path: testFilePath }),
      ]);

      expect(result.exitCode).toBe(0);

      // Output should be the raw file content
      expect(result.stdout).toContain('Hello from test file!');

      // Output should NOT contain MCP envelope structure
      expect(result.stdout).not.toContain('"content"');
      expect(result.stdout).not.toContain('"type"');
      expect(result.stdout).not.toContain('"text"');
    });
  });

  describe('built-in utils server', () => {
    test('list includes utils and its tools', async () => {
      const result = await runCli([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('utils');
      expect(result.stdout).toContain('get_csvschema');
    });

    test('info utils shows built-in transport and tools', async () => {
      const result = await runCli(['info', 'utils']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('built-in');
      expect(result.stdout).toContain('get_csvschema');
    });

    test('grep finds utils tools', async () => {
      const result = await runCli(['grep', 'get_*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('get_csvschema');
    });

    test('call utils/get_csvschema writes and returns the schema', async () => {
      const result = await runCli([
        'call',
        'utils',
        'get_csvschema',
        JSON.stringify({ path: csvFilePath }),
      ]);

      expect(result.exitCode).toBe(0);
      const { outputPath, schema } = JSON.parse(result.stdout.trim());
      expect(outputPath).toBe(`${csvFilePath}.csvschema.json`);
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(schema);
      expect(
        schema.fields.map((f: { field_name: string }) => f.field_name)
      ).toContain('category');
      expect(schema.id_mode).toBe('id');
    });

    test('call utils/get_csvschema with missing file reports an error', async () => {
      const result = await runCli([
        'call',
        'utils',
        'get_csvschema',
        JSON.stringify({ path: join(tempDir, 'does-not-exist.csv') }),
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('FILE_NOT_FOUND');
    });
  });

  describe('error handling', () => {
    test('handles missing config gracefully', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      // Use a path inside tmpdir to avoid cross-platform absolute path issues
      const nonexistentConfig = join(tmpdir(), 'nonexistent-mcp-config.json');
      const proc = Bun.spawn(['bun', 'run', cliPath, '-c', nonexistentConfig], {
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          SEMANTIUS_NO_DAEMON: '1',
          SEMANTIUS_API_KEY: 'test-api-key',
          SEMANTIUS_ORG: 'test-org',
          SEMANTIUS_JWT: '',
        },
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });

    test('handles unknown options', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const proc = Bun.spawn(['bun', 'run', cliPath, '--unknown-option'], {
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown option');
    });
  });
});

/**
 * HTTP Transport Integration Tests
 *
 * These tests verify HTTP-based MCP server connectivity
 * using the deepwiki.com public MCP server.
 * Tests are skipped if the server is unreachable (e.g., in sandboxed/offline environments).
 */
describe('HTTP Transport Integration Tests', () => {
  let tempDir: string;
  let configPath: string;
  let serverReachable = false;

  beforeAll(async () => {
    // Create temp directory for config
    // Use realpath() to resolve Windows 8.3 short names
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'semantius-cli-http-test-')));

    // Create config with HTTP-based MCP server
    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          deepwiki: {
            url: 'https://mcp.deepwiki.com/mcp',
          },
        },
      })
    );

    // Check if the HTTP server is reachable before running tests
    try {
      const response = await fetch('https://mcp.deepwiki.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      serverReachable = response.status !== 0;
    } catch {
      serverReachable = false;
    }
    // Explicit hook timeout: the probe above may itself burn 5s, which races
    // bun's 5s default and fails the hook instead of falling through to
    // serverReachable = false. Must stay comfortably above the probe budget.
  }, 30000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper to run CLI commands with HTTP config
  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');

    try {
      const proc = Bun.spawn(['bun', 'run', cliPath, '-c', configPath, ...args], {
        env: { ...process.env, SEMANTIUS_NO_DAEMON: '1', SEMANTIUS_API_KEY: 'test-api-key', SEMANTIUS_ORG: 'test-org', SEMANTIUS_JWT: '' },
        stdin: null,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { stdout, stderr, exitCode };
    } catch (error: any) {
      return {
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
        exitCode: error.exitCode || 1,
      };
    }
  }

  describe('list command with HTTP server', () => {
    test('lists HTTP server and its tools', async () => {
      const result = await runCli([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('deepwiki');
    });

  });

  describe('info command with HTTP server', () => {
    test('shows HTTP server details', async () => {
      if (!serverReachable) {
        console.log('Skipping: deepwiki.com is not reachable');
        return;
      }
      const result = await runCli(['info', 'deepwiki']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('deepwiki');
      expect(result.stdout).toContain('Transport:');
      expect(result.stdout).toContain('HTTP');
    });

  });

  describe('grep command with HTTP server', () => {
    test('searches HTTP server tools', async () => {
      if (!serverReachable) {
        console.log('Skipping: deepwiki.com is not reachable');
        return;
      }
      const result = await runCli(['grep', '*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('deepwiki');
    });
  });
});

/**
 * --single flag integration tests
 *
 * Tests the --single flag against the real Semantius CRUD server.
 * Skipped when SEMANTIUS_API_KEY or SEMANTIUS_ORG are not set.
 */
describe('--single flag Integration Tests', () => {
  let serverReachable = false;
  // Located dynamically in beforeAll — the tests org is a shared environment
  // that gets reseeded, so no specific record id can be assumed to exist.
  let moduleId: number;

  beforeAll(async () => {
    const apiKey = process.env.SEMANTIUS_API_KEY;
    const org = process.env.SEMANTIUS_ORG;
    if (!apiKey || !org) return;

    try {
      const response = await fetch(`https://${org}.semantius.ai/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      serverReachable = response.status < 500;
    } catch {
      serverReachable = false;
    }
    if (!serverReachable) return;

    // Find any existing module to test against
    const probe = await runCli([
      '--diag',
      'call', 'crud', 'read_module',
      JSON.stringify({ limit: 1, select: 'id' }),
    ]);
    try {
      const rows = JSON.parse(probe.stdout);
      if (Array.isArray(rows) && rows.length === 1) {
        moduleId = rows[0].id;
      }
    } catch {
      // fall through
    }
    if (moduleId === undefined) {
      console.log('Skipping --single tests: no module found to test against');
      serverReachable = false;
    }
    // Explicit hook timeout: the reachability probe can burn its full 5s and
    // the module probe then spawns a CLI process, so this hook routinely
    // exceeds bun's 5s default and fails the whole block on a slow network.
  }, 30000);

  // Runs CLI without a config file — uses built-in default (crud + cube)
  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
    const proc = Bun.spawn(['bun', 'run', cliPath, ...args], {
      env: { ...process.env, SEMANTIUS_NO_DAEMON: '1' },
      stdin: null,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  }

  test('--single with exactly 1 row returns object and exits 0', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    const result = await runCli([
      '--single',
      'call', 'crud', 'read_module',
      JSON.stringify({ filters: `id=eq.${moduleId}` }),
    ]);

    expect(result.exitCode).toBe(0);
    // Response is a single JSON object (not an array)
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ id: moduleId });
    expect(Array.isArray(parsed)).toBe(false);
  });

  test('--single with 0 rows exits 1 and reports error', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    const result = await runCli([
      '--single',
      'call', 'crud', 'read_module',
      JSON.stringify({ filters: 'id=eq.99999' }),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SINGLE_NO_ROWS');
  });

  test('without --single returns array normally (--diag)', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    // CRUD server returns plain JSON (no response.data wrapper), so --diag is needed
    const result = await runCli([
      '--diag',
      'call', 'crud', 'read_module',
      JSON.stringify({ filters: `id=eq.${moduleId}` }),
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  test('--single returns object while --diag without --single returns array', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    const withSingle = await runCli([
      '--single',
      'call', 'crud', 'read_module',
      JSON.stringify({ filters: `id=eq.${moduleId}` }),
    ]);
    const withoutSingle = await runCli([
      '--diag',
      'call', 'crud', 'read_module',
      JSON.stringify({ filters: `id=eq.${moduleId}` }),
    ]);

    expect(withSingle.exitCode).toBe(0);
    expect(withoutSingle.exitCode).toBe(0);

    const singleParsed = JSON.parse(withSingle.stdout);
    const normalParsed = JSON.parse(withoutSingle.stdout);

    expect(Array.isArray(singleParsed)).toBe(false);
    expect(Array.isArray(normalParsed)).toBe(true);
    expect(singleParsed.id).toBe(normalParsed[0].id);
  });

  test('--single unwraps postgrestRequest envelope to just the row', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    const result = await runCli([
      '--single',
      'call', 'crud', 'postgrestRequest',
      JSON.stringify({ method: 'GET', path: `/modules?id=eq.${moduleId}` }),
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // Should be the row directly, not { request, response: { data: {...} } }
    expect(parsed).not.toHaveProperty('request');
    expect(parsed).not.toHaveProperty('response');
    expect(parsed).toMatchObject({ id: moduleId });
  });

  test('--single --diag returns the full envelope', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    const result = await runCli([
      '--single', '--diag',
      'call', 'crud', 'postgrestRequest',
      JSON.stringify({ method: 'GET', path: `/modules?id=eq.${moduleId}` }),
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('request');
    expect(parsed).toHaveProperty('response');
    expect((parsed.response as { data: { id: number } }).data.id).toBe(moduleId);
  });

  test('--single surfaces real server errors instead of MULTIPLE_ROWS', async () => {
    if (!serverReachable) {
      console.log('Skipping: CRUD server not reachable');
      return;
    }
    // Hitting a non-existent table triggers a PostgREST schema-cache error
    // (PGRST205) — not a row-count error. The CLI must report the real cause,
    // not misclassify it as SINGLE_MULTIPLE_ROWS.
    const result = await runCli([
      '--single',
      'call', 'crud', 'postgrestRequest',
      JSON.stringify({ method: 'GET', path: '/__definitely_not_a_table__' }),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain('SINGLE_MULTIPLE_ROWS');
    expect(result.stderr).toMatch(/PGRST205|schema cache|not.*table/i);
  });
});
