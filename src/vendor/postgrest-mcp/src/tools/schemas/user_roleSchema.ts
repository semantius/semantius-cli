/**
 * Shared schema for user_roles table
 * Used by both create_user_role and update_user_role tools
 */

import { z } from 'zod/v4'

export const user_roleSchema = z.looseObject({
  id: z.string().optional().describe('Generated identifier (user_id.role_id) - Auto-generated'),
  user_id: z.number().int().describe('User this role is assigned to'),
  role_id: z.number().int().describe('Role assigned to the user'),
  assigned_at: z.string().optional().describe('Timestamp when role was assigned (ISO 8601)'),
  assigned_by: z.number().int().optional().nullable().describe('User who assigned this role'),
})
