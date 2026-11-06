/**
 * Shared schema for webhook_receivers table
 * Used by both create_webhook_receiver and update_webhook_receiver tools
 */

import { z } from 'zod/v4'

export const webhook_receiverSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal identifier, assigned automatically'),
  label: z.string().describe('Name that identifies this webhook receiver'),
  table_name: z.string().optional().describe('Table name of the entity that receives the webhook data (must be an existing entity; deleting the entity deletes its receivers). Defaults to an empty string, which makes every delivery fail with result 40.'),
  description: z.string().optional().describe('Description of webhook receiver purpose'),
  auth_type: z.enum(['none', 'hmac', 'header']).optional().describe('Type of authentication: none (open, accepts every request), hmac (signed webhook-id/webhook-signature headers, needs secret), or header (request must carry header_name with exactly header_value).'),
  secret: z.string().optional().describe('Secret for webhook authentication. Required for auth_type hmac: without it every delivery is refused.'),
  header_name: z.string().optional().describe('Custom header name for authentication'),
  header_value: z.string().optional().describe('Expected value for custom header authentication'),
  jsonata: z.string().optional().describe('Optional JSONata expression to transform incoming data'),
})
