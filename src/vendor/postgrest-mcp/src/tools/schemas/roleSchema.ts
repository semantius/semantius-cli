/**
 * Shared schema for roles table
 * Used by both create_role and update_role tools
 */

import { z } from 'zod/v4'

export const roleSchema = z.looseObject({
  id: z.number().int().optional().describe('Internal role identifier - Auto-generated'),
  role_name: z.string().describe('Unique role name'),
  slug: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'slug must be snake_case (lowercase letters, digits, and underscores)')
    .optional()
    .describe(
      'Snake_case unique identifier for the role. Auto-derived from role_name via slugify on INSERT when omitted. Immutable when origin is "system", "model", or "model_master"; mutable for origin = "user".'
    ),
  description: z.string().optional().describe('Description of the role'),
  origin: z
    .enum(['system', 'model', 'model_master', 'user'])
    .optional()
    .describe(
      'How the role was created: "system" (platform built-ins seeded at DB init, e.g. Administrator, User), "model" (scaffold role on a domain module from a *-semantic-model.md deploy), "model_master" (scaffold role on a master module from promotion or master-model deploy), or "user" (admin-created; default for new records). Allowed transitions after INSERT: only "user" -> "model" and "user" -> "model_master" (auto-claim into a scaffold). All other transitions are blocked, including any change involving "system".'
    ),
  module_id: z.number().int().optional().nullable().describe('Module this role belongs to'),
  catalog_role_code: z
    .string()
    .optional()
    .describe(
      'Catalog/blueprint provenance: the stable catalog persona/role this role was provisioned from (lineage; non-unique). Empty = created outside the deploy pipeline. Populated by the deploy pipeline; do not set manually.'
    ),
})
