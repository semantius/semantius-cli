/**
 * The local "crud" MCP server: the vendored postgrest-mcp tools registered on
 * an in-process McpServer, so the CLI gets the same schemas, validation and
 * result envelopes as from the remote server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { version as VERSION } from '../../../package.json' with {
  type: 'json',
};
import type { HostFacts } from '../../host.js';
import { tools } from '../../vendor/postgrest-mcp/registry.js';
import { instructions } from '../../vendor/postgrest-mcp/src/generated/instructions.js';
import type { ToolContext } from './context.js';

/**
 * Tools that assume the cloud token endpoint / org slug; not registered on
 * self-hosted instances.
 */
export const CLOUD_ONLY_TOOLS: readonly string[] = [
  'sendEmail',
  'get_cli_token',
  'get_cli_config',
];

interface VendoredTool {
  name: string;
  options: { title: string; description: string; inputSchema: ZodRawShape };
  handler: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

// The registry array is a union of per-tool generic types; erase them once
// here (handlers are contravariant in their input, so no common supertype).
const vendoredTools = tools as unknown as VendoredTool[];

/** The instructions the remote server sends, with ${slug} → org. */
export function crudInstructions(org: string | null): string {
  return org ? instructions.replace(/\$\{slug\}/g, org) : instructions;
}

export function createCrudServer(
  getContext: () => ToolContext,
  host: Pick<HostFacts, 'mode' | 'org'>,
): McpServer {
  const server = new McpServer(
    { name: 'crud', version: VERSION },
    { instructions: crudInstructions(host.org) },
  );
  for (const tool of vendoredTools) {
    if (host.mode === 'selfhosted' && CLOUD_ONLY_TOOLS.includes(tool.name)) {
      continue;
    }
    // The SDK passes (args, extra); extra carries no request/auth info over
    // InMemoryTransport and upstream ignores it too.
    server.registerTool(tool.name, tool.options, (input) =>
      tool.handler(input as Record<string, unknown>, getContext()),
    );
  }
  return server;
}
