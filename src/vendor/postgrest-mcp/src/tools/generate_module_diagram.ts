/**
 * Generate Module Diagram Tool
 * Builds a Mermaid entity relationship diagram for a module from the live
 * entities and fields (see utils/moduleDiagram.ts for the rules).
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { handleToolError } from '../utils/errorHandler.ts'
import { loadModuleModel } from '../utils/moduleModel.ts'
import { buildModuleDiagram } from '../utils/moduleDiagram.ts'

const inputSchema = {
  module: z
    .string()
    .describe(`The module to diagram: its module_slug (e.g. "crm"), its module_name, or its numeric id.`),
  include_incoming: z
    .boolean()
    .optional()
    .describe(
      `Also draw relationships from entities of OTHER modules that reference an entity of this module ` +
      `(default true). Set false to show only what the module's own entities reference.`
    ),
  direction: z
    .enum(['LR', 'TB', 'RL', 'BT'])
    .optional()
    .describe(`Mermaid flowchart direction (default LR).`),
}

export const generateModuleDiagramTool: Tool<typeof inputSchema, undefined> = {
  name: 'generate_module_diagram',
  options: {
    title: 'Generate Module Diagram',
    description:
      `Generates a Mermaid entity relationship diagram (database model) for a module. ` +
      `Reads the module's entities and all their reference and parent fields. ` +
      `Entities of the module and external entities (referenced from, or referencing, other modules) get different colors, ` +
      `external nodes also show their module, every node shows its entity type, and each arrow is labelled with the ` +
      `field's relationship_label. Arrows run from the referenced (one) side to the entity holding the field (many side); ` +
      `a flat line marks a unique (one-to-one) reference. ` +
      `Returns the diagram as a mermaid code block, ready to paste into a spec or markdown document.`,
    inputSchema,
  },
  handler: async ({ module, include_incoming, direction }, { authInfo }) => {
    try {
      const model = await loadModuleModel(module, authInfo, include_incoming !== false)
      if (!model) {
        return { content: [{ type: 'text' as const, text: `Module not found: ${module}` }], isError: true }
      }
      const d = buildModuleDiagram(model, direction)
      const summary =
        `Module "${model.module.module_name}" (${model.module.module_slug}): ${d.entityCount} entities, ` +
        `${d.externalCount} external entities, ${d.relationshipCount} relationships` +
        (d.unlabelledCount ? ` (${d.unlabelledCount} without a relationship_label, drawn as bare arrows)` : '') + '.'
      return { content: [{ type: 'text' as const, text: `${summary}\n\n${d.mermaid}` }] }
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
