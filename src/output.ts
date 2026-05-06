/**
 * Output formatting utilities
 */

import type { ToolInfo } from './client.js';
import type { ServerConfig } from './config.js';
import { isHttpServer } from './config.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

/**
 * Check if output should be colorized
 */
function shouldColorize(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

/**
 * Apply color if terminal supports it
 */
function color(text: string, colorCode: string): string {
  if (!shouldColorize()) return text;
  return `${colorCode}${text}${colors.reset}`;
}

/**
 * Format server list for display
 */
export function formatServerList(
  servers: Array<{ name: string; tools: ToolInfo[]; instructions?: string }>,
  withDescriptions: boolean,
): string {
  const lines: string[] = [];

  for (const server of servers) {
    lines.push(color(server.name, colors.bold + colors.cyan));

    // Show instructions if available (first line only in list view, or all if short)
    if (server.instructions) {
      const instructionLines = server.instructions.split('\n');
      const firstLine = instructionLines[0].slice(0, 100);
      const suffix =
        instructionLines.length > 1 || instructionLines[0].length > 100
          ? '...'
          : '';
      lines.push(
        `  ${color(`Instructions: ${firstLine}${suffix}`, colors.dim)}`,
      );
    }

    for (const tool of server.tools) {
      if (withDescriptions && tool.description) {
        lines.push(`  • ${tool.name} - ${color(tool.description, colors.dim)}`);
      } else {
        lines.push(`  • ${tool.name}`);
      }
    }

    lines.push(''); // Empty line between servers
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format search results
 */
export function formatSearchResults(
  results: Array<{ server: string; tool: ToolInfo }>,
  withDescriptions: boolean,
): string {
  const lines: string[] = [];

  for (const result of results) {
    const server = color(result.server, colors.cyan);
    const tool = color(result.tool.name, colors.green);
    // Always show description if available (grep is for discovery)
    if (result.tool.description) {
      lines.push(
        `${server} ${tool} ${color(result.tool.description, colors.dim)}`,
      );
    } else {
      lines.push(`${server} ${tool}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format server details
 */
export function formatServerDetails(
  serverName: string,
  config: ServerConfig,
  tools: ToolInfo[],
  withDescriptions = false,
  instructions?: string,
): string {
  const lines: string[] = [];

  lines.push(
    `${color('Server:', colors.bold)} ${color(serverName, colors.cyan)}`,
  );

  if (isHttpServer(config)) {
    lines.push(`${color('Transport:', colors.bold)} HTTP`);
    lines.push(`${color('URL:', colors.bold)} ${config.url}`);
  } else {
    lines.push(`${color('Transport:', colors.bold)} stdio`);
    lines.push(
      `${color('Command:', colors.bold)} ${config.command} ${(config.args || []).join(' ')}`,
    );
  }

  if (instructions) {
    lines.push('');
    lines.push(`${color('Instructions:', colors.bold)}`);
    // Indent multi-line instructions
    const indentedInstructions = instructions
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    lines.push(indentedInstructions);
  }

  lines.push('');
  lines.push(`${color(`Tools (${tools.length}):`, colors.bold)}`);

  for (const tool of tools) {
    lines.push(`  ${color(tool.name, colors.green)}`);
    if (withDescriptions && tool.description) {
      lines.push(`    ${color(tool.description, colors.dim)}`);
    }

    // Show parameters from schema
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    if (schema.properties) {
      lines.push(`    ${color('Parameters:', colors.yellow)}`);
      for (const [name, prop] of Object.entries(schema.properties)) {
        const required = schema.required?.includes(name)
          ? 'required'
          : 'optional';
        const type = prop.type || 'any';
        const desc =
          withDescriptions && prop.description ? ` - ${prop.description}` : '';
        lines.push(`      • ${name} (${type}, ${required})${desc}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format tool schema
 */
export function formatToolSchema(serverName: string, tool: ToolInfo): string {
  const lines: string[] = [];

  lines.push(
    `${color('Tool:', colors.bold)} ${color(tool.name, colors.green)}`,
  );
  lines.push(
    `${color('Server:', colors.bold)} ${color(serverName, colors.cyan)}`,
  );
  lines.push('');

  if (tool.description) {
    lines.push(`${color('Description:', colors.bold)}`);
    lines.push(`  ${tool.description}`);
    lines.push('');
  }

  lines.push(`${color('Input Schema:', colors.bold)}`);
  lines.push(JSON.stringify(tool.inputSchema, null, 2));

  return lines.join('\n');
}

/**
 * Thrown when the tool call returns an MCP-level error (isError: true).
 * Carries the raw result so callers can print it in --diag mode.
 */
export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly rawResult: unknown,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * Format tool call result
 *
 * @param result - Raw MCP tool result
 * @param diag - When true, return the full JSON; when false (default), return only the `data` field
 */
export function formatToolResult(result: unknown, diag = false): string {
  if (typeof result === 'object' && result !== null) {
    const r = result as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    // Handle MCP tool result format
    if (r.content && Array.isArray(r.content)) {
      const textParts = r.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text as string);

      if (textParts.length > 0) {
        const text = textParts.join('\n');

        // Surface MCP-level errors (tool not found, execution errors, etc.)
        // Carry the raw result so --diag can print it before exiting.
        if (r.isError) {
          throw new McpToolError(text, result);
        }

        if (diag) {
          return text;
        }

        // Try to extract response.data from the response JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(
            `Unexpected tool response: not valid JSON. Use --diag to see the raw output.\n${text}`,
          );
        }

        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>).response !== null &&
          typeof (parsed as Record<string, unknown>).response === 'object' &&
          'data' in
            ((parsed as Record<string, unknown>).response as Record<
              string,
              unknown
            >)
        ) {
          return JSON.stringify(
            (
              (parsed as Record<string, unknown>).response as Record<
                string,
                unknown
              >
            ).data,
            null,
            2,
          );
        }

        throw new Error(
          `Unexpected tool response: missing response.data. Use --diag to see the raw output.\n${text}`,
        );
      }
    }
  }

  // Fallback to JSON
  return JSON.stringify(result, null, 2);
}

/**
 * Format as JSON
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format error message
 */
export function formatError(message: string): string {
  return color(`Error: ${message}`, '\x1b[31m'); // Red
}
