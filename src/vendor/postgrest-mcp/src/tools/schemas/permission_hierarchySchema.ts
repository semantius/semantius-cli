/**
 * Shared schema for permission_hierarchy table
 * Used by both create_permission_hierarchy and update_permission_hierarchy tools
 */

import { z } from 'zod/v4'

export const permission_hierarchySchema = z.looseObject({
  id: z.string().optional().describe('Generated identifier (including_permission_name.included_permission_name) - Auto-generated'),
  including_permission_name: z.string().describe('The broader permission that does the including, by name (e.g. "crm:manage" in "crm:manage includes crm:read"). Implies the included_permission_name.'),
  included_permission_name: z.string().describe('The narrower permission that is included by the broader one, by name (e.g. "crm:read" in "crm:manage includes crm:read").'),
  origin: z
    .enum(['system', 'model', 'model_master', 'user'])
    .optional()
    .describe(
      'How this hierarchy entry was created: "system" (platform-seeded at DB init), "model" (row declared in a model file\'s §2 Permissions summary table), "model_master" (auto-created by the deployer during promotion or Branch A wire-up; covers both the master\'s internal chain and cross-module bridges), or "user" (admin-added; default for new records). Strictly immutable after INSERT — no upgrade paths.'
    ),
})
