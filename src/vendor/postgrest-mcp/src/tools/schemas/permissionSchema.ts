/**
 * Shared schema for permissions table
 * Used by both create_permission and update_permission tools
 */

import { z } from 'zod/v4'

export const permissionSchema = z.looseObject({
  permission_name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)*$/,
      'permission_name must be colon-separated segments of [a-z0-9_-], each starting with a letter or digit'
    )
    .describe(
      'The permission itself, and the key other tables use to name it. Colon-separated segments of a-z, 0-9, - and _, each starting with a letter or digit, e.g. crm:read or service-catalog:view. No spaces, commas or dots: scope strings are split on commas and whitespace, and a dot would make permission_hierarchy ids ambiguous.'
    ),
  description: z.string().optional().describe('What the permission allows'),
  module_id: z.number().int().optional().nullable().describe('Module this permission belongs to'),
})
