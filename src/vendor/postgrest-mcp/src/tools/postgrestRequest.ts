import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'

const inputSchema = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
  path: z.string().describe('PostgREST API path (e.g., /users, /posts?userId=eq.1)'),
  body: z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())),
    ])
    .optional()
    .describe('Request body for POST/PUT/PATCH requests. Either one object or an array of objects (bulk insert). With an array, PostgREST requires every item to have the same keys unless the path adds ?columns=col1,col2 (then omitted keys become NULL). For bulk writes prefer the typed create_*/update_*/delete_* tools, which handle this for you.'),
  accept: z
    .string()
    .optional()
    .describe('Accept header value (e.g., application/vnd.pgrst.object+json to return a single object, text/csv for CSV export)'),
}

export const postgrestRequestTool: Tool<typeof inputSchema, undefined> = {
  name: 'postgrestRequest',
  options: {
    title: 'Call PostgREST API',
    description: 'Performs a raw HTTP request against the PostgREST API. Use only for queries or filter-based mutations the typed CRUD tools cannot express; the typed tools already support arrays for bulk create/update/delete.',
    inputSchema,
  },
  handler: async ({ method, path, body, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path,
        method,
        body,
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
        additionalHeaders: accept ? { accept } : undefined,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    }
    catch (error: any) {
      return handleToolError(error)
    }
  },
}
