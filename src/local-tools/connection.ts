/**
 * In-process McpConnection for the built-in "utils" server.
 *
 * A real McpServer wired to the CLI's Client over InMemoryTransport, so
 * built-in tools get the same schema validation and result envelope as any
 * remote server. No daemon, JWT, or retry layers here: the in-process
 * transport cannot fail, and the transfer tools, which do talk to a host,
 * carry their own token refresh and retries (transfer/postgrest.ts).
 *
 * A call times out after ${PREFIX}_TIMEOUT without progress, not after
 * ${PREFIX}_TIMEOUT in total: the transfer tools report progress after every
 * answer from the host, so a long import is not cut off while it is moving.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { version as VERSION } from '../../package.json' with { type: 'json' };
import type { McpConnection, ToolInfo } from '../client.js';
import {
  type ServerConfig,
  debug,
  filterTools,
  getTimeoutMs,
  isToolAllowed,
} from '../config.js';
import { createUtilsServer } from './index.js';

export async function createBuiltinConnection(
  _serverName: string,
  config: ServerConfig,
): Promise<McpConnection> {
  const server = createUtilsServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: 'semantius', version: VERSION },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    async listTools(): Promise<ToolInfo[]> {
      const result = await client.listTools();
      const tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      return filterTools(tools, config);
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      if (!isToolAllowed(toolName, config)) {
        throw new Error(`Tool "${toolName}" is disabled by configuration`);
      }
      return client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: getTimeoutMs(),
        resetTimeoutOnProgress: true,
        onprogress: (progress) => {
          if (progress.message) debug(`${toolName}: ${progress.message}`);
        },
      });
    },
    async getInstructions(): Promise<string | undefined> {
      return client.getInstructions();
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
    isDaemon: false,
  };
}
