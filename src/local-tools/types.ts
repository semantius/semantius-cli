/**
 * Contract for tools hosted by the built-in "utils" MCP server.
 *
 * Each tool lives in its own module and default-exports defineLocalTool({...}).
 * Heavy dependencies must be imported inside the handler (dynamic import) so
 * listing tools never pays their load cost.
 */

import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';

export interface LocalTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: ToolCallback<Shape>;
}

/**
 * Identity helper: infers the schema shape so handler args are fully typed at
 * the definition site, then erases it — handlers are contravariant in their
 * args, so shaped tools aren't assignable to LocalTool<ZodRawShape> and a
 * heterogeneous registry array needs the erased form.
 */
export function defineLocalTool<Shape extends ZodRawShape>(
  tool: LocalTool<Shape>,
): LocalTool {
  return tool as unknown as LocalTool;
}
