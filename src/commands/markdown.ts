/**
 * Markdown dump command - Output full documentation as markdown
 *
 * Shows README.md, SKILL.md, then all servers with all tools and descriptions.
 * Useful for LLMs to get a complete picture of the CLI and available tools.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type McpConnection,
  type ToolInfo,
  getConcurrencyLimit,
  getConnection,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  getServerConfig,
  listServerNames,
  loadConfig,
} from '../config.js';
import { ErrorCode } from '../errors.js';

export interface MarkdownOptions {
  configPath?: string;
}

interface ServerWithTools {
  name: string;
  tools: ToolInfo[];
  instructions?: string;
  error?: string;
}

/**
 * Find a documentation file by searching common locations:
 * - Parent of the source file directory (project root in dev mode)
 * - Directory of the running script/binary
 * - Parent of the running script/binary directory
 * - Current working directory
 */
function findDocFile(filename: string): string | null {
  const candidates = [
    // Dev mode: src/index.ts → project root is one level up
    join(import.meta.dir, '..', filename),
    // Binary in dist/ → project root is one level up
    join(dirname(process.argv[1]), '..', filename),
    // Binary at project root
    join(dirname(process.argv[1]), filename),
    // Current working directory
    join(process.cwd(), filename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read a documentation file, returning its content or a placeholder message.
 */
function readDocFile(filename: string): string {
  const path = findDocFile(filename);
  if (!path) {
    return `_${filename} not found_\n`;
  }
  return readFileSync(path, 'utf8');
}

/**
 * Process items with limited concurrency, preserving order
 */
async function processWithConcurrency<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  maxConcurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await processor(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Fetch tools from a single server
 */
async function fetchServerTools(
  serverName: string,
  config: McpServersConfig,
): Promise<ServerWithTools> {
  let connection: McpConnection | null = null;
  try {
    const serverConfig = getServerConfig(config, serverName);
    connection = await getConnection(serverName, serverConfig);
    const tools = await connection.listTools();
    const instructions = await connection.getInstructions();
    return { name: serverName, tools, instructions };
  } catch (error) {
    return {
      name: serverName,
      tools: [],
      error: (error as Error).message,
    };
  } finally {
    if (connection) {
      await safeClose(connection.close);
    }
  }
}

/**
 * Format all servers and their tools as markdown
 */
function formatServersMarkdown(servers: ServerWithTools[]): string {
  const lines: string[] = [];

  lines.push('# MCP Servers');
  lines.push('');

  for (const server of servers) {
    lines.push(`## ${server.name}`);
    lines.push('');

    if (server.error) {
      lines.push(`> ⚠ Connection error: ${server.error}`);
      lines.push('');
      continue;
    }

    if (server.instructions) {
      lines.push(server.instructions);
      lines.push('');
    }

    if (server.tools.length === 0) {
      lines.push('_No tools available_');
      lines.push('');
      continue;
    }

    lines.push(`### Tools (${server.tools.length})`);
    lines.push('');

    for (const tool of server.tools) {
      lines.push(`#### ${tool.name}`);
      lines.push('');

      if (tool.description) {
        lines.push(tool.description);
        lines.push('');
      }

      const schema = tool.inputSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };

      if (schema.properties && Object.keys(schema.properties).length > 0) {
        lines.push('**Parameters:**');
        lines.push('');
        lines.push('| Name | Type | Required | Description |');
        lines.push('|------|------|----------|-------------|');
        for (const [name, prop] of Object.entries(schema.properties)) {
          const required = schema.required?.includes(name) ? 'yes' : 'no';
          const type = prop.type || 'any';
          const desc = prop.description || '';
          lines.push(`| \`${name}\` | ${type} | ${required} | ${desc} |`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Execute the markdown dump command
 */
export async function markdownCommand(options: MarkdownOptions): Promise<void> {
  const sections: string[] = [];

  // 1. README.md
  sections.push(readDocFile('README.md'));

  // 2. SKILL.md
  sections.push(readDocFile('SKILL.md'));

  // 3. All servers with all tools and descriptions
  let config: McpServersConfig;
  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  const serverNames = listServerNames(config);

  if (serverNames.length > 0) {
    const concurrencyLimit = getConcurrencyLimit();
    const servers = await processWithConcurrency(
      serverNames,
      (name) => fetchServerTools(name, config),
      concurrencyLimit,
    );

    servers.sort((a, b) => a.name.localeCompare(b.name));
    sections.push(formatServersMarkdown(servers));
  }

  console.log(sections.join('\n\n---\n\n'));
}
