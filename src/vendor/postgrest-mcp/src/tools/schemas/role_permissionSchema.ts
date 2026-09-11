/**
 * Shared schema for role_permissions table
 * Used by both create_role_permission and update_role_permission tools
 */

import { z } from 'zod/v4'

export const role_permissionSchema = z.looseObject({
  id: z.string().optional().describe('Generated identifier (role_id.permission_name) - Auto-generated'),
  role_id: z.number().int().describe('Role this permission is granted to'),
  permission_name: z.string().describe('Permission granted to the role, by name (permissions is keyed by permission_name)'),
  granted_at: z.string().optional().describe('Timestamp when permission was granted (ISO 8601)'),
  granted_by: z.number().int().optional().nullable().describe('User who granted this permission'),
})
