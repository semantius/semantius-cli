/**
 * Delete Permission Tool
 * Permanently deletes a permission record by name
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  permission_name: oneOrMany(z.string()).describe(
    `permission_name of the permission to delete, or a non-empty array of permission_names to delete several records in one request. ` +
    `A permission that an entity, module or queue still names is refused: those columns are foreign keys to it. ` +
    `WARNING: This operation is permanent and cannot be undone. ` +
    `Consider using an update to set a "deleted" flag instead of permanent deletion.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "permission_name" is an array.'),
}

export const deletePermissionTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_permission',
  options: {
    title: 'Delete Permission',
    description: `Permanently deletes a permission record by permission_name, which is the primary key of the permissions table. ` +
      `This operation cannot be undone, and it is refused while an entity, module or queue still names the permission. ` +
      `Returns the deleted record for confirmation (always an array; "permission_name" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Consider using update operations with a "deleted" or "archived" flag for soft deletes instead.`,
    inputSchema,
  },
  handler: async ({ permission_name, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/permissions?${keyFilter('permission_name', permission_name)}`,
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
