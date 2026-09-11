/**
 * Update User Role Tool
 * Updates an existing user role record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { user_roleSchema } from './schemas/user_roleSchema.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  id: oneOrMany(z.string()).describe('ID of the user role to update, or a non-empty array of IDs. When an array is given, the same "data" is applied to every matching record.'),
  data: user_roleSchema.partial().describe(
    `Object containing the fields to update and their new values. ` +
    `All fields are optional for partial updates. ` +
    `Only include fields you want to change - omitted fields remain unchanged.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const updateUserRoleTool: Tool<typeof inputSchema, undefined> = {
  name: 'update_user_role',
  options: {
    title: 'Update User Role',
    description: `Updates an existing user role record by ID. ` +
      `Provide the id and the fields to update. ` +
      `Only the fields included in "data" will be updated; other fields remain unchanged. ` +
      `Returns the updated record with all current field values. ` +
      `"id" may also be an array to apply the same update to several records in one request; the response is always an array of updated records.`,
    inputSchema,
  },
  handler: async ({ id, data, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/user_roles?${keyFilter('id', id)}`,
        method: 'PATCH',
        body: data,
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
        additionalHeaders: accept ? { accept } : undefined,
      })

      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
