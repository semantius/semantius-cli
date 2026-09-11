/**
 * Generate API Key Tool
 * Generates a new API key for the current user or (admin) for a specified user.
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'

const inputSchema = {
  p_user_id: z.number().int().describe(
    `Target user id. Pass 0 to generate a key for the currently authenticated user ` +
    `(the resulting key will use the "uk-" prefix). ` +
    `Pass a specific user id to generate a key on behalf of another user — this requires ` +
    `the "admin" permission and the resulting key will use the "sk-" prefix.`
  ),
  p_description: z.string().optional().describe(
    `Optional human-readable label stored alongside the key (e.g. "CI deploy", "Local dev laptop"). ` +
    `Defaults to an empty string.`
  ),
}

export const generateApiKeyTool: Tool<typeof inputSchema, undefined> = {
  name: 'generate_api_key',
  options: {
    title: 'Generate API Key',
    description:
      `Generates a new API key and returns the full plaintext key. ` +
      `IMPORTANT: The key is only shown once at creation time and cannot be retrieved later — ` +
      `make sure to copy and store it securely immediately. ` +
      `By default (p_user_id=0) a personal key is generated for the currently authenticated user. ` +
      `Admins may also pass a specific user id to generate a key on behalf of another user.`,
    inputSchema,
  },
  handler: async ({ p_user_id, p_description }, { authInfo }) => {
    try {
      const body: Record<string, unknown> = { p_user_id }
      if (p_description !== undefined) body.p_description = p_description

      const result = await makePostgrestRequest({
        path: '/rpc/generate_api_key',
        method: 'POST',
        body,
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
