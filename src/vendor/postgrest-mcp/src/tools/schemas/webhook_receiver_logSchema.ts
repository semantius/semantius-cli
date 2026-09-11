/**
 * Shared schema for webhook_receiver_logs table
 * Used by both create_webhook_receiver_log and update_webhook_receiver_log tools
 */

import { z } from 'zod/v4'

export const webhook_receiver_logSchema = z.looseObject({
  id: z.number().int().optional().describe('Auto-generated identifier'),
  webhook_id: z.string().describe('Webhook identifier'),
  webhook_receiver_id: z.number().int().optional().describe('Reference to webhook receiver configuration'),
  webhook_timestamp: z.string().optional().describe('Timestamp from webhook source (ISO 8601)'),
  received_timestamp: z.string().optional().describe('Timestamp when webhook was received (ISO 8601)'),
  payload: z.unknown().optional().describe('Webhook payload data (JSON)'),
  result: z.enum(['10', '20', '90']).optional().describe('Processing result: 10=received, 20=processed, 90=failed'),
  error_message: z.string().optional().describe('Error message if processing failed'),
})
