/**
 * Shared schema for webhook_receivers table
 * Used by both create_webhook_receiver and update_webhook_receiver tools
 */

import { z } from 'zod/v4'

export const webhook_receiverSchema = z.looseObject({
  id: z.number().int().optional().describe('Auto-generated identifier'),
  label: z.string().describe('Webhook receiver label'),
  table_name: z.string().optional().describe('Target table for webhook data'),
  description: z.string().optional().describe('Description of webhook receiver purpose'),
  auth_type: z.enum(['none', 'hmac', 'header']).optional().describe('Type of authentication (none, hmac, or custom header)'),
  secret: z.string().optional().describe('Secret for webhook authentication'),
  header_name: z.string().optional().describe('Custom header name for authentication'),
  header_value: z.string().optional().describe('Expected value for custom header authentication'),
  jsonata: z.string().optional().describe('Optional JSONata expression to transform incoming data'),
})
