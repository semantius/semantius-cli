/**
 * Shared schema for permission_hierarchy table
 * Used by both create_permission_hierarchy and update_permission_hierarchy tools
 */

import { z } from 'zod/v4'

export const permission_hierarchySchema = z.looseObject({
  id: z.string().optional().describe('Generated identifier (including_permission_name.included_permission_name) - Auto-generated'),
  including_permission_name: z.string().describe('The broader permission, by name: holding it implies the included permission (e.g. crm:manage includes crm:read).'),
  included_permission_name: z.string().describe('The narrower permission that is included by the broader one, by name (e.g. "crm:read" in "crm:manage includes crm:read").'),
  origin: z
    .enum(['system', 'model', 'model_master', 'user'])
    .optional()
    .describe(
      'How the hierarchy entry was created: system (platform built-in), model (declared in the model of a domain module), model_master (created by the deployer for a master module, inside it or between it and other modules) or user (added by an admin). Set on insert and never changed.'
    ),
})
