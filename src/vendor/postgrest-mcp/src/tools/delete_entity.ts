/**
 * Delete Entity Tool
 * Permanently deletes a entity record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'
import { resetSchemaCache } from '../utils/resetSchemaCache.ts'

const inputSchema = {
  table_name: oneOrMany(z.string()).describe(
    `table_name of the entity to delete, or a non-empty array of table_names to delete several entities in one request. ` +
    `WARNING: This operation is permanent and cannot be undone. ` +
    `Consider using an update to set a "deleted" flag instead of permanent deletion.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "table_name" is an array.'),
}

export const deleteEntityTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_entity',
  options: {
    title: 'Delete Entity',
    description: `Permanently deletes a entity record by table_name. ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "table_name" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Consider using update operations with a "deleted" or "archived" flag for soft deletes instead.`,
    inputSchema,
  },
  handler: async ({ table_name, accept }, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/entities?${keyFilter('table_name', table_name)}`,
        method: 'DELETE',
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
        additionalHeaders: accept ? { accept } : undefined,
      })

      const host = request?.headers?.['x-forwarded-host'] || request?.headers?.['host'] || ''
      resetSchemaCache(host, authInfo?.token).catch(() => {})
      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
