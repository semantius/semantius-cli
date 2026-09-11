/**
 * Delete Field Tool
 * Permanently deletes a field record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'
import { resetSchemaCache } from '../utils/resetSchemaCache.ts'

const inputSchema = {
  id: oneOrMany(z.string()).describe(
    `ID of the field to delete, or a non-empty array of IDs to delete several records in one request. ` +
    `WARNING: This operation is permanent and cannot be undone. ` +
    `Consider using an update to set a "deleted" flag instead of permanent deletion.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const deleteFieldTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_field',
  options: {
    title: 'Delete Field',
    description: `Permanently deletes a field record by ID. ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "id" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Consider using update operations with a "deleted" or "archived" flag for soft deletes instead.`,
    inputSchema,
  },
  handler: async ({ id, accept }, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/fields?${keyFilter('id', id)}`,
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
