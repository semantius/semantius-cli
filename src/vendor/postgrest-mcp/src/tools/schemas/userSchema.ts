/**
 * Shared schema for users table
 * Used by both create_user and update_user tools
 */

import { z } from 'zod/v4'

export const userSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal identifier, assigned automatically'),
  external_id: z.string().optional().describe('Identity: the JWT sub claim from the authentication provider. Required and unique, never empty. A human user must bring one; an agent (is_agent true) inserted without one gets agent:<uuid>. It cannot be blanked later. Read-only in the UI: set it on create, since changing it detaches the user from their login.'),
  email: z.string().email().optional().describe('Email address of the user. Optional: agents and pre-provisioned users may have none.'),
  display_name: z.string().optional().describe('Display name from the JWT name claim'),
  first_name: z.string().optional().describe('First name from JWT given_name claim'),
  last_name: z.string().optional().describe('Last name from JWT family_name claim'),
  is_agent: z.boolean().optional().describe('When TRUE this user is a service principal (agent). Default FALSE.'),
  is_disabled: z.boolean().optional().describe('When TRUE, the user account is disabled and its roles are ignored for permission checks. Disabling the last enabled Administrator is refused (hint code 90104).'),
  settings: z.unknown().optional().describe('User-specific settings and preferences (JSON)'),
  last_seen: z.string().optional().nullable().describe('Timestamp when user was last active (ISO 8601). Set by the platform on login; do not set it. A user created with last_seen set while no Administrator exists becomes the Administrator.'),
})
