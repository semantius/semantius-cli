/**
 * Builds the Mermaid entity relationship diagram of a loaded module model.
 *
 * - Module entities and external (other-module) entities get different colors.
 * - Every node shows its entity type; external nodes also show their module.
 * - Edge labels are the relationship_label of the reference/parent field.
 * - Arrows run from the referenced (one) side to the entity holding the field
 *   (many side); a unique reference is drawn as a flat line (1:1).
 */

import type { ModuleModel, Row } from './moduleModel.ts'

export type Direction = 'LR' | 'TB' | 'RL' | 'BT'

export interface ModuleDiagram {
  /** The ```mermaid fenced block. */
  mermaid: string
  entityCount: number
  externalCount: number
  relationshipCount: number
  unlabelledCount: number
}

// Words Mermaid treats specially when used as a bare node id.
const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'style', 'click', 'default'])

const nodeId = (table: string) => (RESERVED.has(table.toLowerCase()) ? `${table}_` : table)
const esc = (s: string) => s.replace(/"/g, '#quot;')

export function buildModuleDiagram(model: ModuleModel, direction: Direction = 'LR'): ModuleDiagram {
  const own = model.entities
  const ownSet = new Set(own.map((e) => e.table_name as string))
  const edges: Row[] = [...model.outgoing, ...model.incoming]

  const externalNames = new Set<string>()
  for (const f of edges) {
    for (const t of [f.table_name, f.reference_table]) if (!ownSet.has(t)) externalNames.add(t)
  }

  const label = (e: Row | undefined, table: string, moduleSlug?: string) => {
    const parts = [`<b>${esc(e?.plural_label || e?.singular_label || table)}</b>`]
    parts.push(`<i>${esc(e?.entity_type || 'unclassified')}</i>`)
    if (moduleSlug) parts.push(`module: ${esc(moduleSlug)}`)
    return parts.join('<br/>')
  }

  const lines: string[] = [
    '```mermaid',
    `flowchart ${direction}`,
    '  classDef module fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px,color:#1e3a8a;',
    '  classDef external fill:#d4f4dd,stroke:#27ae60,stroke-dasharray:4 3,color:#1a4d2e;',
  ]
  const classes: string[] = []

  for (const e of own) {
    lines.push(`  ${nodeId(e.table_name)}["${label(e, e.table_name)}"]`)
    classes.push(`  class ${nodeId(e.table_name)} module;`)
  }
  for (const name of [...externalNames].sort()) {
    const e = model.external.get(name)
    const slug = e?.module_id != null ? model.externalModules.get(e.module_id) : undefined
    lines.push(`  ${nodeId(name)}["${label(e, name, slug ?? 'unknown')}"]`)
    classes.push(`  class ${nodeId(name)} external;`)
  }

  for (const f of edges) {
    const from = nodeId(f.reference_table) // referenced (one) side
    const to = nodeId(f.table_name) // entity holding the field (many side)
    const verb = typeof f.relationship_label === 'string' ? f.relationship_label.trim() : ''
    const connector = f.unique_value ? '---' : '-->'
    lines.push(verb ? `  ${from} ${connector}|"${esc(verb)}"| ${to}` : `  ${from} ${connector} ${to}`)
  }
  lines.push(...classes, '```')

  return {
    mermaid: lines.join('\n'),
    entityCount: own.length,
    externalCount: externalNames.size,
    relationshipCount: edges.length,
    unlabelledCount: edges.filter((f) => !(typeof f.relationship_label === 'string' && f.relationship_label.trim())).length,
  }
}
