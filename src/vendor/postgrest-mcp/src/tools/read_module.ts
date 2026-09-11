/**
 * Read Module Tool
 * Reads and queries modules from the modules table
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'

const inputSchema = {
  filters: z
    .string()
    .optional()
    .describe(
      `PostgREST query filter string to specify which records to retrieve. ` +
      `Uses PostgREST operators: eq (equals), neq (not equals), gt (greater than), gte (>=), lt (<), lte (<=), ` +
      `like (pattern match), ilike (case-insensitive pattern), in (list), is (null check). ` +
      `Examples: "id=eq.1" (get by ID), "email=eq.user@example.com" (exact match), ` +
      `"is_active=eq.true" (boolean), "name=ilike.*smith*" (case-insensitive search), ` +
      `"id=in.(1,2,3)" (multiple values). ` +
      `Multiple filters can be combined with "&": "is_active=eq.true&role=eq.admin". ` +
      `Leave empty to retrieve all records (subject to limit).`
    ),
  select: z
    .string()
    .optional()
    .describe(
      `Comma-separated list of columns to include in the response. ` +
      `Examples: "id,name,email" (specific columns), "*" (all columns - default if omitted). ` +
      `Supports nested resources and related data using PostgREST embedded resource syntax. ` +
      `Leave empty to select all columns.`
    ),
  limit: z
    .number()
    .positive()
    .int()
    .optional()
    .describe(
      `Maximum number of records to return. Use for pagination. ` +
      `Must be a positive integer. Example: 10, 50, 100. ` +
      `Combine with "offset" for pagination: limit=10&offset=20 returns records 21-30.`
    ),
  offset: z
    .number()
    .nonnegative()
    .int()
    .optional()
    .describe(
      `Number of records to skip before returning results. Use for pagination. ` +
      `Must be a non-negative integer. Example: 0 (first page), 10 (second page if limit=10). ` +
      `Formula: offset = (page - 1) * limit`
    ),
  order: z
    .string()
    .optional()
    .describe(
      `Column(s) to sort results by. Use ".desc" suffix for descending order, ".asc" for ascending (default). ` +
      `Examples: "created_at.desc" (newest first), "name.asc" (alphabetical), ` +
      `"priority.desc,created_at.asc" (multiple columns). ` +
      `Default order depends on database implementation.`
    ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export)'),
}

export const readModuleTool: Tool<typeof inputSchema, undefined> = {
  name: 'read_module',
  options: {
    title: 'Read Module',
    description: `Reads and queries modules from the modules table. ` +
      `Supports flexible filtering, column selection, pagination, and sorting using PostgREST query syntax. ` +
      `Returns an array of matching records. Use filters to narrow results, select to choose columns, ` +
      `limit/offset for pagination, and order for sorting.`,
    inputSchema,
  },
  handler: async ({ filters, select, limit, offset, order, accept }, { authInfo }) => {
    try {
      const params = new URLSearchParams()
      if (select) params.set('select', select)
      if (limit) params.set('limit', limit.toString())
      if (offset) params.set('offset', offset.toString())
      if (order) params.set('order', order)

      let path = '/modules'
      if (filters) {
        path += `?${filters}`
        if (params.toString()) {
          path += `&${params.toString()}`
        }
      } else if (params.toString()) {
        path += `?${params.toString()}`
      }

      const result = await makePostgrestRequest({
        path,
        method: 'GET',
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
