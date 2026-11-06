/**
 * Delete User Role Tool
 * Permanently deletes a user role record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  id: oneOrMany(z.string()).describe(
    `ID of the user role to delete (a string of the form <user_id>.<role_id>), or a non-empty array of IDs to delete several records in one request. If one fails, none is deleted. ` +
    `WARNING: This operation is permanent and cannot be undone.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const deleteUserRoleTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_user_role',
  options: {
    title: 'Delete User Role',
    description: `Permanently deletes a user role record by ID. ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "id" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Role 1 (User) cannot be removed from a user (90103), and the Administrator role (role 2) cannot be removed from the last enabled Administrator (90104).`,
    inputSchema,
  },
  handler: async ({ id, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/user_roles?${keyFilter('id', id)}`,
        method: 'DELETE',
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
