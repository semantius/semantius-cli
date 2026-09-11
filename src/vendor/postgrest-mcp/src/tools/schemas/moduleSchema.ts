/**
 * Shared schema for modules table
 * Used by both create_module and update_module tools
 */

import { z } from 'zod/v4'

export const moduleSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal module identifier - Auto-generated'),
  module_name: z.string().describe('Unique module name'),
  description: z.string().optional().describe('Description of the module'),
  module_type: z
    .enum(['domain', 'master'])
    .optional()
    .describe(
      'Module type: "domain" (default, normal module) or "master" (promoted for sharing). Set to "master" only by the promotion flow, not manually.'
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
      'The manage permission for this module, by name. Populated by the scaffold pass; do not set manually.'
    ),
  admin_permission: z
    .string()
    .optional()
    .nullable()
    .describe(
      'The admin permission for this module, by name. Populated by the scaffold pass when any entity in the module carries edit_permission "admin"; do not set manually.'
    ),
  default_viewer_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'FK to roles.id for the default viewer role. Populated by the scaffold pass; do not set manually.'
    ),
  default_manager_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'FK to roles.id for the default manager role. Populated by the scaffold pass; do not set manually.'
    ),
  default_admin_role_id: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe(
      'FK to roles.id for the default admin role. Populated by the scaffold pass when admin_permission is present; do not set manually.'
    ),
  logo_color: z.string().optional().describe('Hex color code for module logo'),
  icon_name: z.string().optional().describe('Name of the icon to display for this module'),
  home_page: z.string().optional().describe('Default home page path for module'),
  module_slug: z
    .string()
    .regex(
      /^[a-z0-9_-]+$/,
      'module_slug must be lowercase alphanumeric, underscore, or hyphen'
    )
    .describe('URL-safe slug for module (lowercase letters, digits, underscore, or hyphen)'),
  settings: z.unknown().optional().describe('Module-specific settings and configuration (JSON)'),
  dashboard_config: z.unknown().optional().describe('Module dashboard layout/config (JSON)'),
  catalog_module_code: z
    .string()
    .optional()
    .describe(
      'Catalog/blueprint provenance: the catalog blueprint this module was provisioned/cloned from; also the domain axis (non-unique). Write-once (cannot be changed once set). Empty = greenfield. Populated by the deploy pipeline; do not set manually.'
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
      'Access tier: "basic" for simple read/edit; "full" for role tiers, approvals & gating.'
    ),
})
