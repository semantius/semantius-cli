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
      'The permission, and the primary key of the permissions table. Colon-separated segments over the same alphabet module_slug uses, each starting with a letter or digit, e.g. "crm:read" or "service-catalog:view". No spaces, commas or dots: a scope string is split on commas and whitespace, and a dot would make the permission_hierarchy key ambiguous. Every other table names a permission by this value.'
    ),
  description: z.string().optional().describe('Description of the permission'),
  module_id: z.number().int().optional().nullable().describe('Module this permission belongs to'),
})
