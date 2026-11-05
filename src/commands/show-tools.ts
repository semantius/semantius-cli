/**
 * showTools - the one implementation behind `info` and `tools`.
 *
 *   no server       the local servers (crud, utils), or all with --all
 *   <server>        that server's tools with their parameters
 *   <server> <tool> one tool: description and input schema
 *
 * `info` calls it with intro = true, `tools` with intro = false. The intro is
 * the only difference: the server and tool lines, the transport and the
 * instruction text. Everything else is the same code and the same output.
 */

import { authLayerExitCode } from '../auth/token.js';
import {
  type McpConnection,
  type ToolInfo,
  debug,
  getConcurrencyLimit,
  getConnection,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  getServerConfig,
  isLocalServer,
  listServerNames,
  loadConfig,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  isAuthErrorMessage,
  serverConnectionError,
  toolNotFoundError,
} from '../errors.js';
import {
  formatServerDetails,
  formatServerList,
  formatToolDefinition,
  formatToolSchema,
  formatToolsSection,
} from '../output.js';

export interface ShowToolsOptions {
  server?: string;
  tool?: string;
  /** true for `info`, false for `tools`. */
  intro: boolean;
  withDescriptions: boolean;
  /** Also contact remote servers (--all). Default: only the local crud and utils. */
  all?: boolean;
  /** Indent the schema for reading (--pretty); default is compact. */
  pretty?: boolean;
  configPath?: string;
}

interface ServerWithTools {
  name: string;
  tools: ToolInfo[];
  instructions?: string;
  error?: string;
}

/**
 * Process items with limited concurrency, preserving order
 * Uses a worker pool pattern where each worker grabs the next item from a shared index
 */
async function processWithConcurrency<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  maxConcurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await processor(items[index], index);
    }
  }

  // Start workers up to concurrency limit
  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Fetch tools from a single server (uses daemon if enabled)
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
    debug(`${serverName}: loaded ${tools.length} tools`);
    return { name: serverName, tools, instructions };
  } catch (error) {
    const errorMsg = (error as Error).message;
    debug(`${serverName}: connection failed - ${errorMsg}`);
    return {
      name: serverName,
      tools: [],
      error: errorMsg,
    };
  } finally {
    if (connection) {
      await safeClose(connection.close);
    }
  }
}

/** No server given: the local servers, or every server with --all. */
async function showServers(
  config: McpServersConfig,
  options: ShowToolsOptions,
): Promise<void> {
  const allNames = listServerNames(config);
  const remoteNames = allNames.filter(
    (name) => !isLocalServer(config.mcpServers[name]),
  );
  const serverNames = options.all
    ? allNames
    : allNames.filter((name) => isLocalServer(config.mcpServers[name]));

  if (serverNames.length === 0) {
    console.error(
      'Warning: No servers configured. Add servers to mcp_servers.json',
    );
    return;
  }

  const concurrencyLimit = getConcurrencyLimit();
  debug(
    `Processing ${serverNames.length} servers with concurrency ${concurrencyLimit}`,
  );

  // Process servers in parallel with concurrency limit
  const servers = await processWithConcurrency(
    serverNames,
    (name) => fetchServerTools(name, config),
    concurrencyLimit,
  );

  // Sort by name to ensure consistent output order
  servers.sort((a, b) => a.name.localeCompare(b.name));

  // Convert errors to tool-like display for human output
  const displayServers = servers.map((s) => ({
    name: s.name,
    instructions: s.instructions,
    tools: s.error
      ? [
          {
            name: `<error: ${s.error}>`,
            description: undefined,
            inputSchema: {},
          },
        ]
      : s.tools,
  }));

  console.log(
    formatServerList(displayServers, options.withDescriptions, options.intro),
  );

  if (!options.all) {
    const command = options.intro ? 'info' : 'tools';
    console.log('');
    console.log('Next:');
    for (const name of remoteNames) {
      console.log(
        `  semantius ${command} ${name}          remote server, not contacted`,
      );
    }
    console.log(
      `  semantius ${command} crud <tool>      one tool's definition`,
    );
    console.log('  semantius grep "<pattern>"      search tool names');
    if (remoteNames.length > 0) {
      console.log(
        '  --all                           also contact the remote servers',
      );
    }
  }
}

export async function showTools(options: ShowToolsOptions): Promise<void> {
  let config: McpServersConfig;

  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  if (!options.server) {
    await showServers(config, options);
    return;
  }

  const serverName = options.server;

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
    const own = authLayerExitCode(error);
    if (own !== undefined) {
      console.error((error as Error).message);
      process.exit(own);
    }
    const message = (error as Error).message;
    console.error(formatCliError(serverConnectionError(serverName, message)));
    process.exit(
      isAuthErrorMessage(message)
        ? ErrorCode.AUTH_ERROR
        : ErrorCode.NETWORK_ERROR,
    );
  }

  try {
    const tools = await connection.listTools();

    if (options.tool) {
      const tool = tools.find((t) => t.name === options.tool);

      if (!tool) {
        console.error(
          formatCliError(
            toolNotFoundError(
              options.tool,
              serverName,
              tools.map((t) => t.name),
            ),
          ),
        );
        process.exit(ErrorCode.CLIENT_ERROR);
      }

      console.log(
        options.intro
          ? formatToolSchema(serverName, tool, options.pretty)
          : formatToolDefinition(tool, options.pretty),
      );
    } else {
      console.log(
        options.intro
          ? formatServerDetails(
              serverName,
              serverConfig,
              tools,
              options.withDescriptions,
              await connection.getInstructions(),
            )
          : formatToolsSection(tools, options.withDescriptions),
      );
    }
  } finally {
    await safeClose(connection.close);
  }
}
