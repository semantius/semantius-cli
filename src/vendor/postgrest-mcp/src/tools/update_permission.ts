/**
 * Update Permission Tool
 * Updates an existing permission record by name
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { permissionSchema } from './schemas/permissionSchema.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  permission_name: oneOrMany(z.string()).describe('permission_name of the permission to update, or a non-empty array of permission_names. When an array is given, the same "data" is applied to every matching record.'),
  data: permissionSchema.partial().describe(
    `Object containing the fields to update and their new values. ` +
    `All fields are optional for partial updates. ` +
    `Only include fields you want to change - omitted fields remain unchanged.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "permission_name" is an array.'),
}

export const updatePermissionTool: Tool<typeof inputSchema, undefined> = {
  name: 'update_permission',
  options: {
    title: 'Update Permission',
    description: `Updates an existing permission record by permission_name, which is the primary key of the permissions table. ` +
      `Provide the permission_name and the fields to update. ` +
      `Only the fields included in "data" will be updated; other fields remain unchanged. ` +
      `Renaming a permission (setting "permission_name" in "data") cascades to every table that names it, and regenerates the affected RLS policies. ` +
      `Returns the updated record with all current field values. ` +
      `"permission_name" may also be an array to apply the same update to several records in one request; the response is always an array of updated records.`,
    inputSchema,
  },
  handler: async ({ permission_name, data, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/permissions?${keyFilter('permission_name', permission_name)}`,
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
