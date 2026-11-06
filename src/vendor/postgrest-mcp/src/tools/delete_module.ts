/**
 * Delete Module Tool
 * Permanently deletes a module record by ID (cascades to its entities, fields, and records)
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  id: oneOrMany(z.number().int()).describe(
    `ID of the module to delete, or a non-empty array of IDs to delete several modules in one request. If one fails, none is deleted. ` +
    `Deleting a module automatically deletes ALL of its entities, fields, and business records, and its permissions. ` +
    `WARNING: This operation is permanent and cannot be undone.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const deleteModuleTool: Tool<typeof inputSchema, undefined> = {
  name: 'delete_module',
  options: {
    title: 'Delete Module',
    description: `Permanently deletes a module by ID INCLUDING all of its entities, their fields, and all business records and its permissions (automatic cascade, one request). ` +
      `This operation cannot be undone. ` +
      `Returns the deleted record for confirmation (always an array; "id" may be an array to delete several modules in one request). ` +
      `Do NOT delete entities first. ` +
      `Before deleting: get explicit user confirmation and back up with the semantius CLI \`export_module\` if available (it is not a tool of this server). ` +
      `Refused with 90260 while a field of another module references one of its entities, and with 90266 while a rollup of another module aggregates over one: delete those fields or point them at another entity first. Also refused with 90247 while an is_a or has_a entity of the module has records, and with 90256 while an object of another author is built on the views of an is_a or has_a entity of the module. ` +
      `References between its own entities do not count; two modules that reference each other need one such field removed first. ` +
      `WARNING: Be extremely careful to avoid deleting unintended records.`,
    inputSchema,
  },
  handler: async ({ id, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/modules?${keyFilter('id', id)}`,
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
