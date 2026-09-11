/**
 * List API Keys Tool
 * Lists API keys for the current user or (admin) for a specified user.
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'

const inputSchema = {
  p_user_id: z.number().int().optional().describe(
    `Target user id. Pass 0 (or omit) to list keys for the currently authenticated user. ` +
    `Pass a specific user id to list keys belonging to another user — this requires the "admin" permission.`
  ),
}

export const listApiKeysTool: Tool<typeof inputSchema, undefined> = {
  name: 'list_api_keys',
  options: {
    title: 'List API Keys',
    description:
      `Returns the API keys for the current user, or (with admin permission) for a specified user. ` +
      `Each entry contains key_id, description, last_used_at, and created_at — the secret hash is never returned. ` +
      `Use this to review existing keys before generating or revoking one. ` +
      `Results are ordered by created_at descending.`,
    inputSchema,
  },
  handler: async ({ p_user_id }, { authInfo }) => {
    try {
      const body: Record<string, unknown> = { p_user_id: p_user_id ?? 0 }

      const result = await makePostgrestRequest({
        path: '/rpc/list_api_keys',
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
