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
    `table_name of the entity to delete, or a non-empty array of table_names to delete several entities in one request. If one fails, none is deleted. ` +
    `WARNING: This operation is permanent and cannot be undone.`
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
    description: `Permanently deletes an entity by table_name, drops its database table with ALL its records, and deletes its fields and webhook receivers. ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "table_name" may be an array to delete several records in one request). ` +
      `WARNING: Be extremely careful to avoid deleting unintended records. ` +
      `Refused with 90260 while fields of other entities reference it, whatever their reference_delete_mode: find them with \`read_field\` filters "reference_table=eq.<table_name>", then delete them or point them at another entity first. ` +
      `Refused with 90266 while a rollup of another entity aggregates over it, and with 90256 while an object of another author is built on the views of an is_a or has_a entity. ` +
      `Refused with 90247 while an is_a or has_a entity or a base has records, and with 90248 while entities are based on it (find them with read_entity filter id_refentity=eq.<table_name>). ` +
      `To delete a whole module and all its tables at once, use \`delete_module\` (cascades); do not loop \`delete_entity\`.`,
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
