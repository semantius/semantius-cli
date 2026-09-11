/**
 * Create Webhook Receiver Log Tool
 * Creates a new webhook receiver log record in the webhook_receiver_logs table
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { webhook_receiver_logSchema } from './schemas/webhook_receiver_logSchema.ts'
import { oneOrMany, bulkInsertOptions } from '../utils/bulk.ts'

const inputSchema = {
  data: oneOrMany(webhook_receiver_logSchema).describe(
    `Data object containing fields for the new webhook receiver log, or a non-empty array of such objects to create several webhook receiver log records in one request. ` +
    `Array items may have different keys; keys omitted from an item take the column default. ` +
    `All fields are defined with their types and descriptions. ` +
    `Required fields must be provided. Optional fields can be omitted. ` +
    `Auto-generated fields (like IDs) will be populated automatically and should not be included in the input.`
  ),
  accept: z
    .string()
    .optional()
    .describe('Accept header value forwarded to PostgREST (e.g., application/vnd.pgrst.object+json to return a single object instead of an array, text/csv for CSV export). Do not use application/vnd.pgrst.object+json when "data" is an array.'),
}

export const createWebhookReceiverLogTool: Tool<typeof inputSchema, undefined> = {
  name: 'create_webhook_receiver_log',
  options: {
    title: 'Create Webhook Receiver Log',
    description: `Creates a new webhook receiver log record in the webhook_receiver_logs table. ` +
      `This tool validates input data and returns the complete created record. ` +
      `Auto-generated fields (like IDs) will be populated automatically. ` +
      `Accepts a single object or an array of objects (bulk insert in one request); the response is always an array of created records.`,
    inputSchema,
  },
  handler: async ({ data, accept }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        ...bulkInsertOptions('/webhook_receiver_logs', data, accept),
        method: 'POST',
        body: data,
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      return formatSuccessResponse(result.response.data)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
