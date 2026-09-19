/**
 * Shared schema for roles table
 * Used by both create_role and update_role tools
 */

import { z } from 'zod/v4'

export const roleSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal identifier, assigned automatically'),
  role_name: z.string().describe('Unique role name'),
  slug: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'slug must be snake_case (lowercase letters, digits, and underscores)')
    .optional()
    .describe(
      'Snake_case unique identifier for the role, derived from role_name when omitted. Cannot be changed on a system role.'
    ),
  description: z.string().optional().describe('What the role is for'),
  origin: z
    .enum(['system', 'model', 'model_master', 'user'])
    .optional()
    .describe(
      'How the role was created: system (platform built-in), model (scaffold role of a domain module), model_master (scaffold role of a master module) or user (created by an admin). Set on insert and never changed.'
    ),
  module_id: z.number().int().optional().nullable().describe('Module this role belongs to'),
  catalog_role_code: z
    .string()
    .optional()
    .describe(
      'Stable catalog persona/role this role was provisioned from (lineage; non-unique). Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'
    ),
})
