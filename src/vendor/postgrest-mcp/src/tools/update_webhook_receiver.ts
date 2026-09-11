/**
 * Update Webhook Receiver Tool
 * Updates an existing webhook receiver record by ID
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { webhook_receiverSchema } from './schemas/webhook_receiverSchema.ts'
import { oneOrMany, keyFilter } from '../utils/bulk.ts'

const inputSchema = {
  id: oneOrMany(z.number().int()).describe('ID of the webhook receiver to update, or a non-empty array of IDs. When an array is given, the same "data" is applied to every matching record.'),
  data: webhook_receiverSchema.partial().describe(
    `Object containing the fields to update and their new values. ` +
    `All fields are optional for partial updates. ` +
    `Only include fields you want to change - omitted fields remain unchanged.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "id" is an array.'),
}

export const updateWebhookReceiverTool: Tool<typeof inputSchema, undefined> = {
  name: 'update_webhook_receiver',
  options: {
    title: 'Update Webhook Receiver',
    description: `Updates an existing webhook receiver record by ID. ` +
      `Provide the id and the fields to update. ` +
      `Only the fields included in "data" will be updated; other fields remain unchanged. ` +
      `Returns the updated record with all current field values. ` +
      `"id" may also be an array to apply the same update to several records in one request; the response is always an array of updated records.`,
    inputSchema,
  },
  handler: async ({ id, data, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: `/webhook_receivers?${keyFilter('id', id)}`,
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
