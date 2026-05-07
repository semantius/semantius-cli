/**
 * Call command - Execute a tool with arguments
 *
 * Output behavior:
 * - Default: Raw text content to stdout (CLI-friendly)
 * - With --json: Full JSON response to stdout
 * - Errors always go to stderr
 */

import {
  type McpConnection,
  getConnection,
  getTimeoutMs,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  getServerConfig,
  loadConfig,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  invalidJsonArgsError,
  invalidTargetError,
  serverConnectionError,
  toolExecutionError,
  toolNotFoundError,
} from '../errors.js';
import { McpToolError, formatToolResult } from '../output.js';

export interface CallOptions {
  target: string; // "server/tool"
  args?: string; // JSON arguments
  configPath?: string;
  diag?: boolean; // When true, output full JSON instead of just response.data
  single?: boolean; // When true, inject accept: application/vnd.pgrst.object+json; exit 1 on 0 rows, exit 2 on 2+ rows
}

/**
 * Parse target into server and tool name
 */
function parseTarget(target: string): { server: string; tool: string } {
  const slashIndex = target.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(formatCliError(invalidTargetError(target)));
  }
  return {
    server: target.substring(0, slashIndex),
    tool: target.substring(slashIndex + 1),
  };
}

/**
 * Parse JSON arguments from string or stdin
 */
async function parseArgs(
  argsString?: string,
): Promise<Record<string, unknown>> {
  let jsonString: string;

  if (argsString) {
    jsonString = argsString;
  } else if (!process.stdin.isTTY) {
    // Read from stdin with timeout - use timer cleanup to prevent memory leak
    const timeoutMs = getTimeoutMs();
    const chunks: Buffer[] = [];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8').trim();
    })();

    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`stdin read timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      jsonString = await Promise.race([readPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } else {
    // No arguments provided
    return {};
  }

  if (!jsonString) {
    return {};
  }

  try {
    return JSON.parse(jsonString);
  } catch (e) {
    throw new Error(
      formatCliError(invalidJsonArgsError(jsonString, (e as Error).message)),
    );
  }
}

// Exit codes for --single mode
const SINGLE_NO_ROWS = 1;
const SINGLE_MULTIPLE_ROWS = 2;

/**
 * Handle --single response: extract text, detect 0-row and multi-row cases.
 * Exits the process directly with the appropriate code.
 */
async function handleSingleResult(
  result: unknown,
  connection: McpConnection,
): Promise<void> {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };

  let text = '';
  if (r.content && Array.isArray(r.content)) {
    text = r.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text as string)
      .join('\n');
  }

  if (r.isError) {
    // Server signalled an error — distinguish 0 vs 2+ rows by message content
    const isZeroRows = /\b0\s+rows?\b/i.test(text);
    if (isZeroRows) {
      console.error('Error [SINGLE_NO_ROWS]: Query returned 0 rows');
      await safeClose(connection.close);
      process.exit(SINGLE_NO_ROWS);
    } else {
      console.error('Error [SINGLE_MULTIPLE_ROWS]: Query returned multiple rows');
      await safeClose(connection.close);
      process.exit(SINGLE_MULTIPLE_ROWS);
    }
  }

  if (text === 'null') {
    console.error('Error [SINGLE_NO_ROWS]: Query returned 0 rows');
    await safeClose(connection.close);
    process.exit(SINGLE_NO_ROWS);
  }

  console.log(text);
}

/**
 * Execute the call command
 */
export async function callCommand(options: CallOptions): Promise<void> {
  // Parse and validate JSON args early (before loading config/connecting)
  // so that bad arguments are reported immediately without network I/O.
  let args: Record<string, unknown>;
  try {
    args = await parseArgs(options.args);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  if (options.single) {
    args = { ...args, accept: 'application/vnd.pgrst.object+json' };
  }

  let config: McpServersConfig;

  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let serverName: string;
  let toolName: string;

  try {
    const parsed = parseTarget(options.target);
    serverName = parsed.server;
    toolName = parsed.tool;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let serverConfig: ServerConfig;
  try {
    serverConfig = getServerConfig(config, serverName);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let connection: McpConnection;

  try {
    connection = await getConnection(serverName, serverConfig);
  } catch (error) {
    console.error(
      formatCliError(
        serverConnectionError(serverName, (error as Error).message),
      ),
    );
    process.exit(ErrorCode.NETWORK_ERROR);
  }

  let result: unknown;
  try {
    result = await connection.callTool(toolName, args);
  } catch (error) {
    let availableTools: string[] | undefined;
    try {
      const tools = await connection.listTools();
      availableTools = tools.map((t) => t.name);
    } catch {
      // Ignore - we'll show error without tool list
    }

    const errMsg = (error as Error).message;
    if (errMsg.includes('not found') || errMsg.includes('unknown tool')) {
      console.error(
        formatCliError(toolNotFoundError(toolName, serverName, availableTools)),
      );
    } else {
      console.error(
        formatCliError(toolExecutionError(toolName, serverName, errMsg)),
      );
    }
    await safeClose(connection.close);
    process.exit(ErrorCode.SERVER_ERROR);
  }

  if (options.single) {
    await handleSingleResult(result, connection);
    await safeClose(connection.close);
    return;
  }

  try {
    console.log(formatToolResult(result, options.diag));
  } catch (error) {
    if (options.diag && error instanceof McpToolError) {
      console.log(JSON.stringify(error.rawResult, null, 2));
    }
    console.error((error as Error).message);
    await safeClose(connection.close);
    process.exit(ErrorCode.SERVER_ERROR);
  }

  await safeClose(connection.close);
}
