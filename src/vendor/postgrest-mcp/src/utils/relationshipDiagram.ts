/**
 * Relationship diagram: a Mermaid entity relationship diagram of selected entities
 * (the given table names, otherwise all entities of the given module slugs) and the
 * entities they reference through reference and parent fields.
 *
 * Used by generate_module_diagram and generate_spec.
 *
 * - Selected entities and referenced-only entities get different colors (fill).
 * - The border width and dash pattern follow the entity_type, for both kinds of node.
 * - Every node is one plain line: the entity label, or the table_name with show_table_name.
 * - Edge labels are the relationship_label of the reference/parent field.
 * - Arrows run from the referenced (one) side to the entity holding the field
 *   (many side); a unique reference is drawn as a flat line (1:1).
 */

import type { AuthInfoLike, Row } from './postgrest.ts'
import { fetchEntitiesByName, fetchFields, findModule, inList, pgGet } from './postgrest.ts'

export interface RelationshipDiagramParams {
  /** Module slugs whose entities are diagrammed; ignored when table_names is given. */
  module_slugs?: string[]
  /** Entity table names to diagram. */
  table_names?: string[]
  /** Show the table_name on the nodes instead of the entity label (default false). */
  show_table_name?: boolean
}

export interface RelationshipDiagram {
  /** The ```mermaid fenced block. */
  mermaid: string
  entityCount: number
  referencedCount: number
  relationshipCount: number
  unlabelledCount: number
}

export const isRelationship = (f: Row) => (f.format === 'reference' || f.format === 'parent') && !!f.reference_table

// ---------- diagram ----------

// Words Mermaid treats specially when used as a bare node id.
const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'style', 'click', 'default'])

/** Border style per entity_type; unknown or missing types fall back to unclassified. */
const TYPE_BORDERS: Record<string, string> = {
  operational_workflow: 'stroke-width:3px',
  operational_record: 'stroke-width:1.5px',
  catalog: 'stroke-width:2px,stroke-dasharray:2 2',
  junction: 'stroke-width:1px,stroke-dasharray:5 3',
  computed: 'stroke-width:1.5px,stroke-dasharray:8 3 2 3',
  unclassified: 'stroke-width:1px',
}
const typeClass = (type: unknown) => `t_${typeof type === 'string' && type in TYPE_BORDERS ? type : 'unclassified'}`

const nodeId = (table: string) => (RESERVED.has(table.toLowerCase()) ? `${table}_` : table)
const esc = (s: string) => s.replace(/"/g, '#quot;')
const hasLabel = (f: Row) => typeof f.relationship_label === 'string' && f.relationship_label.trim() !== ''

/** The selected entities: the given table names, otherwise all entities of the given module slugs. */
async function selectEntities(params: RelationshipDiagramParams, authInfo: AuthInfoLike | undefined): Promise<Row[]> {
  const tableNames = (params.table_names ?? []).map((t) => t.trim()).filter(Boolean)
  const moduleSlugs = (params.module_slugs ?? []).map((m) => m.trim()).filter(Boolean)
  if (!tableNames.length && !moduleSlugs.length) throw new Error('Provide at least one of module_slugs or table_names.')

  if (tableNames.length) {
    const found = await fetchEntitiesByName(tableNames, authInfo)
    const missing = tableNames.filter((t) => !found.has(t))
    if (missing.length) throw new Error(`Entities not found: ${missing.join(', ')}`)
    return [...found.values()].sort((a, b) => a.table_name.localeCompare(b.table_name))
  }

  const ids: number[] = []
  for (const slug of moduleSlugs) {
    const m = await findModule(slug, authInfo)
    if (!m) throw new Error(`Module not found: ${slug}`)
    ids.push(m.id)
  }
  return await pgGet(`/entities?module_id=${inList(ids)}&order=table_name.asc&limit=10000`, authInfo)
}

/**
 * Builds the relationship diagram for the given parameters.
 * Throws when nothing is selected or a table name or module does not exist.
 */
export async function buildRelationshipDiagram(
  params: RelationshipDiagramParams,
  authInfo: AuthInfoLike | undefined,
): Promise<RelationshipDiagram> {
  const entities = await selectEntities(params, authInfo)
  if (!entities.length) throw new Error('No entities found for the selection.')

  const selected = new Set(entities.map((e) => e.table_name as string))
  const relationships = (await fetchFields([...selected], authInfo)).filter(isRelationship)
  const referencedNames = [...new Set(relationships.map((f) => f.reference_table as string))].filter((t) => !selected.has(t))
  const referenced = await fetchEntitiesByName(referencedNames, authInfo)

  const label = (e: Row | undefined, table: string) =>
    esc(params.show_table_name === true ? table : e?.plural_label || e?.singular_label || table)

  const lines: string[] = [
    '```mermaid',
    'flowchart LR',
    // Fill, border color and text color: selected vs referenced-only.
    '  classDef module fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;',
    '  classDef external fill:#d4f4dd,stroke:#27ae60,color:#1a4d2e;',
    // Border width and dash pattern: entity_type (same for selected and referenced-only).
    ...Object.entries(TYPE_BORDERS).map(([type, border]) => `  classDef ${typeClass(type)} ${border};`),
  ]
  const classes: string[] = []
  const addClasses = (table: string, e: Row | undefined, fill: 'module' | 'external') => {
    classes.push(`  class ${nodeId(table)} ${fill};`)
    classes.push(`  class ${nodeId(table)} ${typeClass(e?.entity_type)};`)
  }

  for (const e of entities) {
    lines.push(`  ${nodeId(e.table_name)}["${label(e, e.table_name)}"]`)
    addClasses(e.table_name, e, 'module')
  }
  for (const name of referencedNames.sort()) {
    const e = referenced.get(name)
    lines.push(`  ${nodeId(name)}["${label(e, name)}"]`)
    addClasses(name, e, 'external')
  }

  for (const f of relationships) {
    const from = nodeId(f.reference_table) // referenced (one) side
    const to = nodeId(f.table_name) // entity holding the field (many side)
    const connector = f.unique_value ? '---' : '-->'
    lines.push(hasLabel(f)
      ? `  ${from} ${connector}|"${esc(f.relationship_label.trim())}"| ${to}`
      : `  ${from} ${connector} ${to}`)
  }
  lines.push(...classes, '```')

  return {
    mermaid: lines.join('\n'),
    entityCount: entities.length,
    referencedCount: referencedNames.length,
    relationshipCount: relationships.length,
    unlabelledCount: relationships.filter((f) => !hasLabel(f)).length,
  }
}
