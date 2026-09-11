/**
 * Update Entity Tool
 * Updates an existing entity record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { resetSchemaCache } from '../utils/resetSchemaCache.ts'
import { entitySchema } from './schemas/entitySchema.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  table_name: oneOrMany(z.string()).describe('table_name of the entity to update, or a non-empty array of table_names. When an array is given, the same "data" is applied to every matching entity.'),
  data: entitySchema.partial().describe(
    `Object containing the fields to update and their new values. ` +
    `All fields are optional for partial updates. ` +
    `Only include fields you want to change - omitted fields remain unchanged.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "table_name" is an array.'),
}

export const updateEntityTool: Tool<typeof inputSchema, undefined> = {
  name: 'update_entity',
  options: {
    title: 'Update Entity',
    description: `Updates an existing entity record by table_name. ` +
      `Provide the table_name and the fields to update. ` +
      `Only the fields included in "data" will be updated; other fields remain unchanged. ` +
      `Returns the updated record with all current field values. ` +
      `"table_name" may also be an array to apply the same update to several records in one request; the response is always an array of updated records.`,
    inputSchema,
  },
  handler: async ({ table_name, data, accept }, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/entities?${keyFilter('table_name', table_name)}`,
        method: 'PATCH',
        body: data,
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
