/**
 * Registry for the built-in "utils" MCP server.
 *
 * Adding a tool: create a module next to this one that default-exports
 * defineLocalTool({...}) and add it to the localTools array.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { version as VERSION } from '../../package.json' with { type: 'json' };
import exportEntities from './export-entities.js';
import exportModule from './export-module.js';
import getCsvSchema from './get-csvschema.js';
import importEntities from './import-entities.js';
import importModule from './import-module.js';
import type { LocalTool } from './types.js';

export const UTILS_INSTRUCTIONS =
  "Built-in utility tools bundled with the semantius CLI. get_csvschema works on local files only; export_entities, export_module, import_entities and import_module move entities and modules between hosts through the host's PostgREST (--host picks the host). File paths are resolved relative to the current working directory.";

export const localTools: LocalTool[] = [
  getCsvSchema,
  exportEntities,
  exportModule,
  importEntities,
  importModule,
];

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
