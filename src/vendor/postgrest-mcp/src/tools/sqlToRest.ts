import type { Tool } from '../../types.ts'
import { processSql, renderHttp } from '@supabase/sql-to-rest'
import { z } from 'zod/v4'

const inputSchema = {
  sql: z.string().describe('SQL query to convert to PostgREST API request'),
}

export const sqlToRestTool: Tool<typeof inputSchema, undefined> = {
  name: 'sqlToRest',
  options: {
    title: 'SQL to REST',
    description: 'Converts SQL query to a PostgREST API request (method, path). Translation only: it returns {method, path} and runs nothing; pass the result to postgrestRequest. Unsupported SQL returns an error.',
    inputSchema,
  },
  handler: async ({ sql }) => {
    try {
      const statement = await processSql(sql)
      const request = await renderHttp(statement)

      const result = {
        method: request.method,
        path: request.fullPath,
      }

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
      console.error('SQL to REST conversion failed:', error)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error.message || 'Conversion failed'}`,
          },
        ],
        isError: true,
      }
    }
  },
}
