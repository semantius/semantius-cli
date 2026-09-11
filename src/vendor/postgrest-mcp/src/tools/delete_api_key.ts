/**
 * Delete API Key Tool
 * Revokes an API key by its public key_id.
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'

const inputSchema = {
  p_key_id: z.string().describe(
    `The public identifier of the API key to revoke (e.g. "uk-abcdef012345" or "sk-abcdef012345"). ` +
    `This is the prefix portion of the full key, NOT the secret. ` +
    `Use list_api_keys to find the key_id of an existing key.`
  ),
}

export const deleteApiKeyTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_api_key',
  options: {
    title: 'Delete API Key',
    description:
      `Permanently revokes an API key by its public key_id. ` +
      `Users may delete their own keys; deleting a key that belongs to another user requires the "admin" permission. ` +
      `Returns true on success and raises an error if the key does not exist or the caller lacks permission. ` +
      `WARNING: This operation cannot be undone — any client still using the revoked key will immediately fail to authenticate.`,
    inputSchema,
  },
  handler: async ({ p_key_id }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: '/rpc/delete_api_key',
        method: 'POST',
        body: { p_key_id },
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
