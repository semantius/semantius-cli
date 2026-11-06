/**
 * Get CLI Config Tool
 * Returns markdown configuration instructions for the Semantius CLI.
 * Does not create an API key; use generate_api_key for that.
 */

import type { Tool } from '../../types.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { getSemantiusOrg } from '../utils/semantiusOrg.ts'

const inputSchema = {}

export const getCliConfigTool: Tool<typeof inputSchema, undefined> = {
  name: 'get_cli_config',
  options: {
    title: 'Get CLI Config',
    description:
      `Returns markdown-formatted configuration instructions for the Semantius CLI, ` +
      `including the user's organization slug. Read-only: it does not create an API key. ` +
      `Call generate_api_key to get one.`,
    inputSchema,
  },
  handler: async (_, { request }) => {
    try {
      const org = getSemantiusOrg(request)

      const markdown =
        `Use the following values to configure your Semantius CLI:\n\n` +
        `SEMANTIUS_ORG=${org}\n` +
        `SEMANTIUS_API_KEY=<your API key>\n\n` +
        `This tool does not create an API key. To get one, call the ` +
        `\`generate_api_key\` tool: it returns \`{api_key, key_id}\` and the ` +
        `plaintext key is shown only once, so store it securely. ` +
        `Use \`list_api_keys\` and \`delete_api_key\` to review or remove keys.\n\n` +
        `You can store the values in your environment with the following commands\n` +
        `export SEMANTIUS_ORG=${org}\n` +
        `export SEMANTIUS_API_KEY=<your API key>\n`

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
