/**
 * Shared schema for webhook_receiver_logs table
 * Used by both create_webhook_receiver_log and update_webhook_receiver_log tools
 */

import { z } from 'zod/v4'

export const webhook_receiver_logSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal identifier, assigned automatically'),
  webhook_receiver_id: z.number().int().describe('Parent webhook receiver this log belongs to (FK to webhook_receivers.id)'),
  message_id: z.string().optional().describe('The sender\'s webhook-id header, or a key derived from the request when it sends none. A delivery whose message_id already succeeded is skipped.'),
  webhook_timestamp: z.string().optional().describe('Timestamp from webhook source (ISO 8601)'),
  received_timestamp: z.string().optional().describe('Timestamp when webhook was received (ISO 8601)'),
  payload: z.unknown().optional().describe('Webhook payload data (JSON)'),
  result: z.enum(['10', '20', '30', '40', '50', '60']).optional().describe('Processing result: 10=success, 20=signature failed, 30=invalid JSON, 40=target table not found, 50=insert failed, 60=JSONata transform error'),
  error_message: z.string().optional().describe('Error message if processing failed'),
})
