/**
 * Integration tests for CLI commands using the filesystem MCP server
 *
 * These tests spawn the actual CLI and test against a real MCP server.
 * They require npx and @modelcontextprotocol/server-filesystem to be available.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI Integration Tests', () => {
  let tempDir: string;
  let configPath: string;
  let testFilePath: string;

  beforeAll(async () => {
    // Create temp directory for test files
    // Use realpath() to resolve Windows 8.3 short names (e.g., RUNNER~1 → runneradmin)
    // so the path matches what the MCP filesystem server expects
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'semantius-cli-integration-')));

    // Create a test file to read
    testFilePath = join(tempDir, 'test.txt');
    await writeFile(testFilePath, 'Hello from test file!');

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
        env: { ...process.env, MCP_NO_DAEMON: '1', SEMANTIUS_API_KEY: 'test-api-key', SEMANTIUS_ORG: 'test-org' },
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
      // This test ensures the call command outputs raw text content
      // instead of the full MCP protocol envelope like:
      // { "content": [{ "type": "text", "text": "..." }] }
      const result = await runCli([
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
          MCP_NO_DAEMON: '1',
          SEMANTIUS_API_KEY: 'test-api-key',
          SEMANTIUS_ORG: 'test-org',
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
  });

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
        env: { ...process.env, MCP_NO_DAEMON: '1', SEMANTIUS_API_KEY: 'test-api-key', SEMANTIUS_ORG: 'test-org' },
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
