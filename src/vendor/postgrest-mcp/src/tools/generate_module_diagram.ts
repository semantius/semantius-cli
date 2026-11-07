/**
 * Generate Module Diagram Tool
 * Builds a Mermaid entity relationship diagram for selected entities (or all entities of
 * selected modules) from the live entities and fields (see utils/relationshipDiagram.ts for the rules).
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { handleToolError } from '../utils/errorHandler.ts'
import { buildRelationshipDiagram } from '../utils/relationshipDiagram.ts'

const inputSchema = {
  module_slugs: z
    .array(z.string())
    .optional()
    .describe(`Module slugs (e.g. ["crm"]) whose entities are diagrammed. Ignored when table_names is provided.`),
  table_names: z
    .array(z.string())
    .optional()
    .describe(`Entity table names (e.g. ["contacts", "companies"]) to diagram. When provided, module_slugs is ignored.`),
  show_table_name: z
    .boolean()
    .optional()
    .describe(`When true, nodes show the table_name; when false/default they show the entity label.`),
  include_incoming: z
    .boolean()
    .optional()
    .describe(
      `When true/default, entities that reference a selected entity (incoming links) are included besides the ` +
        `entities the selection references. Set false to show only outgoing links; useful for hub entities such as users.`,
    ),
}

export const generateModuleDiagramTool: Tool<typeof inputSchema, undefined> = {
  name: 'generate_module_diagram',
  options: {
    title: 'Generate Module Diagram',
    description:
      `Generates a Mermaid entity relationship diagram (database model). ` +
      `Provide module_slugs and/or table_names; at least one is required, and table_names take precedence. ` +
      `The diagram contains the selected entities (all entities of the modules, or the given table_names) ` +
      `and the entities they reference through reference and parent fields (outgoing), plus the entities that ` +
      `reference them (incoming, unless include_incoming is false). ` +
      `Selected and referenced-only entities get different colors, every node is a single line with the entity label ` +
      `(or the table_name with show_table_name), and each arrow is labelled with the field's relationship_label. ` +
      `Arrows run from the referenced (one) side to the entity holding the field (many side); ` +
      `a flat line marks a unique (one-to-one) reference. ` +
      `Returns the diagram as a mermaid code block, ready to paste into a spec or markdown document.`,
    inputSchema,
  },
  handler: async ({ module_slugs, table_names, show_table_name, include_incoming }, { authInfo }) => {
    try {
      const d = await buildRelationshipDiagram({ module_slugs, table_names, show_table_name, include_incoming }, authInfo)
      const summary =
        `${d.entityCount} entities, ${d.referencedCount} referenced entities, ${d.relationshipCount} relationships` +
        (d.unlabelledCount ? ` (${d.unlabelledCount} without a relationship_label, drawn as bare arrows)` : '') + '.'
      return { content: [{ type: 'text' as const, text: `${summary}\n\n${d.mermaid}` }] }
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
