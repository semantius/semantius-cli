/**
 * Get CLI Config Tool
 * Generates a fresh API key for the current user and returns markdown
 * configuration instructions for the Semantius CLI.
 */

import type { Tool } from '../../types.ts'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { getSemantiusOrg } from '../utils/semantiusOrg.ts'

const inputSchema = {}

export const getCliConfigTool: Tool<typeof inputSchema, undefined> = {
  name: 'get_cli_config',
  options: {
    title: 'Get CLI Config',
    description:
      `Returns markdown-formatted configuration instructions for the Semantius CLI, ` +
      `including a freshly generated API key and the user's organization slug. ` +
      `The API key is only shown once, so store it securely.`,
    inputSchema,
  },
  handler: async (_, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        path: '/rpc/generate_api_key',
        method: 'POST',
        body: { p_user_id: 0, p_description: 'Semantius CLI' },
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      const apiKey = result.response.data
      const org = getSemantiusOrg(request)

      const markdown =
        `**A new API key has been generated for the Semantius CLI. ` +
        `It is only shown once below and cannot be retrieved later, ` +
        `so copy and store it securely immediately.**\n\n` +
        `Use the following values to configure your Semantius CLI:\n\n` +
        `SEMANTIUS_API_KEY=${apiKey}\n` +
        `SEMANTIUS_ORG=${org}\n\n` +
        `You can store them in your environment with the following commands\n` +
        `export SEMANTIUS_API_KEY=${apiKey}\n` +
        `export SEMANTIUS_ORG=${org}\n`

      return {
        content: [
          {
            type: 'text' as const,
            text: markdown,
          },
        ],
      }
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
