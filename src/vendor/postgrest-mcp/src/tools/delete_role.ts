/**
 * Delete Role Tool
 * Permanently deletes a role record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  id: oneOrMany(z.number().int()).describe(
    `ID of the role to delete, or a non-empty array of IDs to delete several records in one request. If one fails, none is deleted. Deleting a role also deletes all its user assignments and permission grants. ` +
    `WARNING: This operation is permanent and cannot be undone.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const deleteRoleTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_role',
  options: {
    title: 'Delete Role',
    description: `Permanently deletes a role record by ID. ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "id" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Refused (90104) when this would leave the system without an enabled Administrator, and refused (foreign key violation) while a module names the role as its default_viewer_role_id, default_manager_role_id or default_admin_role_id.`,
    inputSchema,
  },
  handler: async ({ id, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/roles?${keyFilter('id', id)}`,
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
