/**
 * Generate Spec Tool
 * Renders the live model of a module as a semantic-spec markdown document.
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { handleToolError } from '../utils/errorHandler.ts'
import { loadModuleModel } from '../utils/moduleModel.ts'
import { buildModuleSpec } from '../utils/moduleSpec.ts'

const inputSchema = {
  module: z
    .string()
    .describe(`The module to document: its module_slug (e.g. "product-roadmap"), its module_name, or its numeric id.`),
  include_incoming: z
    .boolean()
    .optional()
    .describe(
      `Also include relationships from entities of OTHER modules that reference an entity of this module ` +
      `(default true): drawn in the diagram, listed under "may have many", and in section 6.`
    ),
  include_governance: z
    .boolean()
    .optional()
    .describe(`Include the permissions catalog (8.1) and the roles and permission hierarchy (9.1). Default true.`),
}

export const generateSpecTool: Tool<typeof inputSchema, undefined> = {
  name: 'generate_spec',
  options: {
    title: 'Generate Spec',
    description:
      `Generates the semantic spec document (<slug>-semantic-spec.md) of a module from the live model. ` +
      `The markdown has front matter, 1. Overview, 2. Entity summary with the entity relationship diagram ` +
      `(module and external entities in different colors, entity type on every node, arrows labelled by relationship_label), ` +
      `3. Entities (properties, fields, relationships, validation rules), 4. Relationship summary, 5. Enumerations, ` +
      `6. Cross-model relationships, 7. Open questions, 8.1 Permissions catalog and 9.1 Governance. ` +
      `Handoffs and business-rule intents are design-time material that is not stored on the platform and are not generated. ` +
      `Returns the markdown as text: save it as <module_slug>-semantic-spec.md.`,
    inputSchema,
  },
  handler: async ({ module, include_incoming, include_governance }, { authInfo }) => {
    try {
      const includeIncoming = include_incoming !== false
      const model = await loadModuleModel(module, authInfo, includeIncoming)
      if (!model) {
        return { content: [{ type: 'text' as const, text: `Module not found: ${module}` }], isError: true }
      }
      const markdown = await buildModuleSpec(model, authInfo, {
        includeIncoming,
        includeGovernance: include_governance !== false,
      })
      return { content: [{ type: 'text' as const, text: markdown }] }
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
