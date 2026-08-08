/**
 * Registry for the built-in "utils" MCP server.
 *
 * Adding a tool: create a module next to this one that default-exports
 * defineLocalTool({...}) and add it to the localTools array.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { version as VERSION } from '../../package.json' with { type: 'json' };
import getCsvSchema from './get-csvschema.js';
import type { LocalTool } from './types.js';

export const UTILS_INSTRUCTIONS =
  'Built-in utility tools bundled with the semantius CLI (no server connection involved). File paths are resolved relative to the current working directory.';

export const localTools: LocalTool[] = [getCsvSchema];

export function createUtilsServer(): McpServer {
  const server = new McpServer(
    { name: 'utils', version: VERSION },
    { instructions: UTILS_INSTRUCTIONS },
  );
  for (const tool of localTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler,
    );
  }
  return server;
}
