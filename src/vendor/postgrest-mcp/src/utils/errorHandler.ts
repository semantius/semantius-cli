/**
 * Reusable error handler for MCP tools
 */

export function handleToolError(error: any): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${error.message || 'Request failed'}`,
      },
    ],
    isError: true,
  }
}
