/**
 * In-process McpConnection for the built-in "utils" server.
 *
 * A real McpServer wired to the CLI's Client over InMemoryTransport, so
 * built-in tools get the same schema validation and result envelope as any
 * remote server. No daemon, JWT, or retry layers — nothing can transiently
 * fail in-process.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { version as VERSION } from '../../package.json' with { type: 'json' };
import type { McpConnection, ToolInfo } from '../client.js';
import { type ServerConfig, filterTools, isToolAllowed } from '../config.js';
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
      return client.callTool({ name: toolName, arguments: args });
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
