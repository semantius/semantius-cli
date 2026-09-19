/**
 * Shared schema for modules table
 * Used by both create_module and update_module tools
 */

import { z } from 'zod/v4'

export const moduleSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal identifier, assigned automatically'),
  module_name: z.string().describe('Unique module name'),
  description: z.string().optional().describe('What the module covers'),
  module_type: z
    .enum(['domain', 'master'])
    .optional()
    .describe(
      'Module type: domain (normal) or master (promoted for sharing). Read-only.'
    ),
  view_permission: z
    .string()
    .optional()
    .describe(
      'Permission required to view this module, by name. It must already exist when the module is created: this is a foreign key, and each request is its own transaction, so a permission created by a later request is too late. Create the module with an existing permission (the default "user:read" works), then create the module\'s own permissions, then update the module.'
    ),
  manage_permission: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Manage permission of this module, by name. A foreign key: the permission must already exist.'
    ),
  admin_permission: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Admin permission of this module, by name. A foreign key: the permission must already exist.'
    ),
  default_viewer_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'Default viewer role of this module (FK to roles.id)'
    ),
  default_manager_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'Default manager role of this module (FK to roles.id)'
    ),
  default_admin_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'Default admin role of this module (FK to roles.id)'
    ),
  logo_color: z.string().optional().describe('Hex color code for module logo'),
  icon_name: z.string().optional().describe('Icon or logo name identifier'),
  home_page: z.string().optional().describe('Default home page path for module'),
  module_slug: z
    .string()
    // Same rule as the platform's (90702). Empty is allowed: the platform then
    // derives the slug from module_name.
    .regex(
      /^([a-z0-9][a-z0-9_-]*)?$/,
      "module_slug must be lowercase, start with a letter or digit, and contain only a-z, 0-9, '-' and '_'"
    )
    .optional()
    .describe('URL-safe unique identifier for the module: lowercase, starting with a letter or digit, using only a-z, 0-9, - and _. Derived from the module name when left empty.'),
  settings: z.unknown().optional().describe('Module-specific settings and configuration (JSON)'),
  dashboard_config: z.unknown().optional().describe('Layout and widgets of the module dashboard (JSON)'),
  catalog_module_code: z
    .string()
    .optional()
    .describe(
      'Catalog blueprint this module was provisioned/cloned from; also the domain axis (non-unique). Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec.'
    ),
  domain_code: z
    .string()
    .optional()
    .describe(
      'Short uppercase code for the business domain this module belongs to (e.g. ATS, HCM, ITSM, CRM).'
    ),
  access_scope: z
    .enum(['basic', 'full'])
    .optional()
    .describe(
      'Access tier: basic (simple read/edit) or full (role tiers, approvals and gating). Omitted, it is basic.'
    ),
})
