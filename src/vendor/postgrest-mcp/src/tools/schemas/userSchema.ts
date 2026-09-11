/**
 * Shared schema for users table
 * Used by both create_user and update_user tools
 */

import { z } from 'zod/v4'

export const userSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal user identifier - Auto-generated'),
  external_id: z.string().describe('External identifier from authentication provider'),
  email: z.string().email().describe('User email address'),
  display_name: z.string().optional().describe('Display name from the JWT name claim'),
  first_name: z.string().optional().describe('First name from the JWT given_name claim'),
  last_name: z.string().optional().describe('Last name from the JWT family_name claim'),
  is_agent: z.boolean().optional().describe('When TRUE, this user is a service principal (agent) rather than a human. Default FALSE.'),
  is_disabled: z.boolean().optional().describe('Whether user account is disabled'),
  settings: z.unknown().optional().describe('User-specific settings and preferences (JSON)'),
  last_seen: z.string().optional().nullable().describe('Timestamp when user was last active (ISO 8601)'),
})
