/**
 * Create Entity Tool
 * Creates a new entity record in the entities table
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { resetSchemaCache } from '../utils/resetSchemaCache.ts'
import { entitySchema } from './schemas/entitySchema.ts'
import { oneOrMany, bulkInsertOptions } from '../utils/bulk.ts'

const inputSchema = {
  data: oneOrMany(entitySchema).describe(
    `Data object containing fields for the new entity, or a non-empty array of such objects to create several entity records in one request. ` +
    `Array items may have different keys; a key omitted from an item takes the column default and an explicit null inserts NULL. All items are inserted in one transaction: if one is rejected, none is created. ` +
    `All fields are defined with their types and descriptions. ` +
    `Required fields must be provided. Optional fields can be omitted. ` +
    `The server fills created_at, updated_at, plural (always table_name), searchable and is_child, and derives singular and singular_label when blank; do not include them.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "data" is an array.'),
}

export const createEntityTool: Tool<typeof inputSchema, undefined> = {
  name: 'create_entity',
  options: {
    title: 'Create Entity',
    description: `Creates a new entity record in the entities table. ` +
      `This tool validates input data and returns the complete created record. ` +
      `The server fills created_at, updated_at, plural, searchable and is_child, and derives singular and singular_label when blank. ` +
      `Unless managed is false this creates the physical table with its row-level security policies and its id, label, created_at and updated_at fields (never create them with create_field). Defaults: view_permission public:read, edit_permission admin, id_column id, label_column label. ` +
      `Accepts a single object or an array of objects (bulk insert in one request); the response is always an array of created records.`,
    inputSchema,
  },
  handler: async ({ data, accept }, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        ...bulkInsertOptions('/entities', data, accept),
        method: 'POST',
        body: data,
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      const host = request?.headers?.['x-forwarded-host'] || request?.headers?.['host'] || ''
      resetSchemaCache(host, authInfo?.token).catch(() => {})
      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
