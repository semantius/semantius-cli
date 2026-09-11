/**
 * Utility for formatting tool responses
 */

/**
 * Formats a successful response with data
 * @param data The data to return (will be JSON stringified)
 * @returns Formatted MCP tool response
 */
export function formatSuccessResponse(data: any) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}
