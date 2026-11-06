/**
 * Renders the live model of a module as a semantic-spec markdown document
 * (the same shape the analyst skill writes: frontmatter, §1 Overview, §2 Entity
 * summary + diagram, §3 Entities, §4 Relationship summary, §5 Enumerations,
 * §6 Cross-model relationships, §7 Open questions, §8.1 Permissions catalog,
 * §9.1 Governance).
 *
 * Handoffs and business-rule intents (§6 handoffs, §8.2) are design-time
 * material that is not stored on the platform, so they are not generated.
 */

import type { AuthInfoLike, ModuleModel, Row } from './moduleModel.ts'
import { inList, pgGet } from './moduleModel.ts'
import { buildModuleDiagram } from './moduleDiagram.ts'

const SPEC_VERSION = '3.1'

// ---------- small helpers ----------

const cell = (s: unknown) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
const bt = (s: string) => `\`${s}\``
const yesNo = (b: unknown) => (b ? 'yes' : 'no')
const article = (w: string) => (/^[aeiou]/i.test(w) ? 'An' : 'A')

function firstSentence(text: unknown): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const m = t.match(/^.*?[.!?](?=\s|$)/)
  return m ? m[0] : t
}

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== ''

function isRel(f: Row) {
  return (f.format === 'reference' || f.format === 'parent') && !!f.reference_table
}

function deleteMode(f: Row): string {
  return f.reference_delete_mode || (f.format === 'parent' ? 'cascade' : 'restrict')
}

// ---------- permissions / roles (live) ----------

interface Governance {
  permissions: Row[]
  hierarchy: Row[]
  roles: Row[]
  rolePermissions: Row[]
}

async function loadGovernance(model: ModuleModel, authInfo: AuthInfoLike | undefined): Promise<Governance> {
  const permissions = await pgGet(`/permissions?module_id=eq.${model.module.id}&order=permission_name.asc&limit=10000`, authInfo)
  const roles = await pgGet(`/roles?module_id=eq.${model.module.id}&order=role_name.asc&limit=10000`, authInfo)
  const names = permissions.map((p) => p.permission_name as string)
  const hierarchy = names.length
    ? await pgGet(`/permission_hierarchy?including_permission_name=${inList(names)}&limit=10000`, authInfo)
    : []
  const rolePermissions = roles.length
    ? await pgGet(`/role_permissions?role_id=${inList(roles.map((r) => r.id))}&limit=10000`, authInfo)
    : []
  return { permissions, hierarchy, roles, rolePermissions }
}

// ---------- front matter ----------

function frontmatter(model: ModuleModel, ordered: Row[], externalModuleSlugs: string[], today: string): string {
  const m = model.module
  const out: string[] = ['---', 'artifact: semantic-spec', `version: "${SPEC_VERSION}"`, 'license: MIT']
  out.push(`system_name: ${JSON.stringify(m.module_name)}`)
  if (m.icon_name) out.push(`icon_name: ${m.icon_name}`)
  if (hasValue(m.description)) {
    out.push('description: |')
    for (const l of String(m.description).split(/\r?\n/)) out.push(l ? `  ${l}` : '')
  }
  out.push(`system_slug: ${m.module_slug}`)
  if (m.module_type) out.push(`module_kind: ${m.module_type}`)
  if (m.access_scope) out.push(`access_scope: ${m.access_scope}`)
  if (m.domain_code) out.push(`domain_code: ${m.domain_code}`)
  out.push(`generated_at: ${today}`, 'generated_from: live Semantius model')
  out.push('entities:', ...ordered.map((e) => `  - ${e.table_name}`))
  if (externalModuleSlugs.length) out.push('related_modules:', ...externalModuleSlugs.map((s) => `  - ${s}`))
  out.push('---')
  return out.join('\n')
}

// ---------- §3 entity blocks ----------

function fieldNotes(f: Row, entity: Row): string {
  const parts: string[] = []
  if (f.ctype === 'label' || (entity.label_column && f.field_name === entity.label_column)) parts.push(bt('label_column'))

  if (isRel(f)) {
    const card = f.unique_value ? '1:1' : 'N:1'
    const label = typeof f.relationship_label === 'string' && f.relationship_label.trim()
      ? `, relationship_label: "${f.relationship_label.trim()}"`
      : ''
    parts.push(
      f.format === 'parent'
        ? `↳ ${bt(f.reference_table)} (${card}, ${deleteMode(f)})${label}`
        : `→ ${bt(f.reference_table)} (${card})${label}`,
    )
  }

  if (Array.isArray(f.enum_values) && f.enum_values.length) {
    const vals = f.enum_values.map((v: any) => bt(typeof v === 'string' ? v : v.value))
    parts.push(`enum_values: ${vals.join(', ')}`)
  }
  if (hasValue(f.default_value)) parts.push(`default: "${f.default_value}"`)
  if (f.unique_value && !isRel(f)) parts.push('unique')
  if (f.rollup && Object.keys(f.rollup).length) parts.push(`rollup: ${bt(JSON.stringify(f.rollup))}`)
  return parts.join('; ')
}

function relationshipBullets(
  table: string,
  entityIsJunction: boolean,
  outgoing: Row[],
  incomingFromAll: Row[],
): string[] {
  const out: string[] = []

  if (entityIsJunction) {
    const legs = outgoing.filter((f) => f.format === 'parent')
    if (legs.length === 2) {
      out.push(
        `- Each ${bt(table)} relates one ${bt(legs[0].reference_table)} to one ${bt(legs[1].reference_table)} ` +
        `(junction, both legs ${legs[0].reference_delete_mode || 'cascade'} on delete).`,
      )
      return out
    }
  }

  for (const f of outgoing) {
    const card = f.unique_value ? '1:1' : 'N:1'
    const required = f.input_type === 'required'
    out.push(
      `- ${article(table)} ${bt(table)} record ${required ? 'belongs to one' : 'may belong to one'} ${bt(f.reference_table)} ` +
      `via ${bt(f.field_name)} (${card}, ${required ? 'required' : 'optional'}, ${deleteMode(f)} on delete).`,
    )
  }
  for (const f of incomingFromAll) {
    out.push(
      `- ${article(table)} ${bt(table)} record may have many ${bt(f.table_name)} ` +
      `(${f.unique_value ? '1:1' : '1:N'}, via ${bt(`${f.table_name}.${f.field_name}`)}).`,
    )
  }
  return out
}

// ---------- main ----------

export async function buildModuleSpec(
  model: ModuleModel,
  authInfo: AuthInfoLike | undefined,
  options: { includeIncoming: boolean; includeGovernance: boolean },
): Promise<string> {
  const m = model.module
  const slug: string = m.module_slug
  const today = new Date().toISOString().slice(0, 10)

  const ownSet = new Set(model.entities.map((e) => e.table_name as string))
  const isJunction = (e: Row) => e.entity_type === 'junction'

  // Canonical order: regular entities, then junctions, then entities reused from other modules.
  const regular = model.entities.filter((e) => !isJunction(e))
  const junctions = model.entities.filter(isJunction)
  const reusedNames = [...new Set(model.outgoing.map((f) => f.reference_table as string).filter((t) => !ownSet.has(t)))].sort()
  const reused: Row[] = reusedNames.map((t) => model.external.get(t) ?? { table_name: t })
  const ordered = [...regular, ...junctions, ...reused]

  const externalModuleSlugs = [...new Set(
    [...model.external.values()].map((e) => (e.module_id != null ? model.externalModules.get(e.module_id) : undefined)),
  )].filter((s): s is string => !!s).sort()

  // All relationship fields touching the module, for "may have many" bullets.
  const allRel = [...model.outgoing, ...model.incoming]
  const fieldsByTable = new Map<string, Row[]>()
  for (const f of model.fields) {
    if (!fieldsByTable.has(f.table_name)) fieldsByTable.set(f.table_name, [])
    fieldsByTable.get(f.table_name)!.push(f)
  }

  const parts: string[] = []
  parts.push(frontmatter(model, ordered, externalModuleSlugs, today))
  parts.push(`# ${m.module_name}: Semantic Model`)

  // §1
  parts.push('## 1. Overview')
  parts.push(hasValue(m.description) ? String(m.description).trim() : '_(the module has no description)_')

  // §2
  const rows = ordered.map((e, i) =>
    `| ${i + 1} | ${bt(e.table_name)} | ${cell(e.singular_label || e.table_name)} | ${cell(firstSentence(e.description))} |`)
  const diagram = buildModuleDiagram(model)
  parts.push(
    [
      '## 2. Entity summary',
      '',
      '| # | Table name | Singular label | Purpose |',
      '|---|---|---|---|',
      ...rows,
      '',
      '### Entity-relationship diagram',
      '',
      diagram.mermaid,
    ].join('\n'),
  )

  // §3
  const s3: string[] = ['## 3. Entities']
  ordered.forEach((e, i) => {
    const table: string = e.table_name
    const own = ownSet.has(table)
    const b: string[] = [`### 3.${i + 1} ${bt(table)} - ${e.singular_label || table}`, '']
    const meta: string[] = [`**Plural label:** ${e.plural_label || table}`]

    if (own) {
      const fields = (fieldsByTable.get(table) ?? []).filter((f) => !['id', 'audit', 'core'].includes(f.ctype) && !String(f.field_name).startsWith('_') && !f.is_pk)
      if (e.label_column && !isJunction(e)) meta.push(`**Label column:** ${bt(e.label_column)}`)
      if (hasValue(e.order_column)) meta.push(`**Order column:** ${bt(e.order_column)}`)
      if (hasValue(e.id_column) && e.id_column !== 'id') meta.push(`**Id column:** ${bt(e.id_column)}`)
      if (hasValue(e.id_type) && e.id_type !== 'auto_increment') meta.push(`**Key type:** ${e.id_type}`)
      if (hasValue(e.id_prefix)) meta.push(`**Key prefix:** ${e.id_prefix}`)
      if (hasValue(e.id_refentity)) meta.push(`**Based on:** ${bt(e.id_refentity)}`)
      if (hasValue(e.label_parent)) meta.push(`**Label parent:** ${bt(e.label_parent)}`)
      meta.push(`**Audit log:** ${yesNo(e.audit_log)}`)
      if (hasValue(e.view_permission)) meta.push(`**View permission:** ${e.view_permission}`)
      if (hasValue(e.edit_permission)) meta.push(`**Edit permission:** ${e.edit_permission}`)
      if (hasValue(e.edit_mode) && e.edit_mode !== 'auto') meta.push(`**Edit mode:** ${e.edit_mode}`)
      if (hasValue(e.cube_mode) && e.cube_mode !== 'auto') meta.push(`**Cube mode:** ${e.cube_mode}`)
      if (hasValue(e.icon_name)) meta.push(`**Icon:** ${e.icon_name}`)
      if (hasValue(e.catalog_entity_code)) meta.push(`**Catalog entity code:** ${bt(e.catalog_entity_code)}`)
      if (hasValue(e.entity_type)) meta.push(`**Entity type:** ${e.entity_type}`)
      if (hasValue(e.catalog_owner_module)) meta.push(`**Catalog owner:** ${e.catalog_owner_module}`)
      if (hasValue(e.description)) meta.push(`**Description:** ${String(e.description).trim()}`)
      // Bold key lines need a trailing double-space/line break to stay separate lines in markdown.
      b.push(meta.map((l) => `${l}  `).join('\n').replace(/ {2}$/, ''), '')

      if (fields.length) {
        b.push(
          '**Fields**',
          '',
          '| Field name | Format | Required | Label | Description | Reference / Notes |',
          '|---|---|---|---|---|---|',
          ...fields.map((f) =>
            `| ${bt(f.field_name)} | ${bt(f.format)} | ${f.input_type === 'required' ? 'yes' : 'no'} | ${cell(f.title)} | ${cell(f.description)} | ${cell(fieldNotes(f, e))} |`),
          '',
        )
      }

      const outgoing = fields.filter(isRel)
      const incomingFromAll = allRel.filter((f) => f.reference_table === table)
      const bullets = relationshipBullets(table, isJunction(e), outgoing, isJunction(e) ? [] : incomingFromAll)
      if (bullets.length) b.push('**Relationships**', '', ...bullets, '')

      if (Array.isArray(e.computed_fields) && e.computed_fields.length) {
        b.push('**Computed fields**', '', '```json', JSON.stringify(e.computed_fields, null, 2), '```', '')
      }
      if (Array.isArray(e.validation_rules) && e.validation_rules.length) {
        b.push('**Validation rules**', '', '```json', JSON.stringify(e.validation_rules, null, 2), '```', '')
      }
    } else {
      // Entity of another module that this module references.
      const modSlug = e.module_id != null ? model.externalModules.get(e.module_id) : undefined
      meta.push('**Audit log:** no')
      meta.push(`**Reconciliation:** reuse-from ${modSlug ?? 'unknown'}.${table}`)
      if (hasValue(e.description)) meta.push(`**Description:** ${String(e.description).trim()}`)
      b.push(meta.map((l) => `${l}  `).join('\n').replace(/ {2}$/, ''), '')
      const bullets = relationshipBullets(
        table,
        false,
        [],
        model.outgoing.filter((f) => f.reference_table === table),
      )
      if (bullets.length) b.push('**Relationships**', '', ...bullets, '')
    }
    s3.push(b.join('\n').replace(/\n+$/, ''))
  })
  s3.push('---')
  parts.push(s3.join('\n\n'))

  // §4
  const relRows = model.outgoing.map((f) => {
    const kind = f.format === 'parent' ? (isJunction(model.entities.find((e) => e.table_name === f.table_name) ?? {}) ? 'junction' : 'parent') : 'reference'
    return `| ${bt(f.table_name)} | ${bt(f.field_name)} | ${bt(f.reference_table)} | ${f.unique_value ? '1:1' : 'N:1'} | ${kind} | ${f.format} | ${deleteMode(f)} |`
  })
  parts.push(
    [
      '## 4. Relationship summary',
      '',
      '| FK table | FK field | References | Cardinality | Kind | fk_format | Delete behavior |',
      '|---|---|---|---|---|---|---|',
      ...(relRows.length ? relRows : ['| _(none)_ |  |  |  |  |  |  |']),
    ].join('\n'),
  )

  // §5
  const enumBlocks: string[] = []
  for (const e of model.entities) {
    for (const f of fieldsByTable.get(e.table_name) ?? []) {
      if (!Array.isArray(f.enum_values) || !f.enum_values.length) continue
      const lines = [`### ${bt(`${e.table_name}.${f.field_name}`)}`]
      for (const v of f.enum_values) {
        if (typeof v === 'string') {
          lines.push(`- ${bt(v)}`)
          continue
        }
        lines.push(`- ${bt(v.value)}`)
        if (v.label) lines.push(`  - label: ${v.label}`)
        if (v.description) lines.push(`  - description: ${v.description}`)
        if (v.color) lines.push(`  - color: ${bt(v.color)}`)
        if (v.icon) lines.push(`  - icon: ${bt(v.icon)}`)
      }
      enumBlocks.push(lines.join('\n'))
    }
  }
  if (enumBlocks.length) parts.push(['## 5. Enumerations', ...enumBlocks].join('\n\n'))

  // §6
  const cross: string[] = []
  for (const f of model.outgoing) {
    if (ownSet.has(f.reference_table)) continue
    const ext = model.external.get(f.reference_table)
    const modSlug = ext?.module_id != null ? model.externalModules.get(ext.module_id) : undefined
    cross.push(`| outbound | ${bt(`${f.table_name}.${f.field_name}`)} | ${bt(f.reference_table)} | ${cell(modSlug ?? 'unknown')} | ${cell(f.relationship_label)} |`)
  }
  for (const f of model.incoming) {
    const ext = model.external.get(f.table_name)
    const modSlug = ext?.module_id != null ? model.externalModules.get(ext.module_id) : undefined
    cross.push(`| inbound | ${bt(`${f.table_name}.${f.field_name}`)} | ${bt(f.reference_table)} | ${cell(modSlug ?? 'unknown')} | ${cell(f.relationship_label)} |`)
  }
  parts.push(
    [
      '## 6. Cross-model relationship suggestions',
      '',
      cross.length
        ? ['| direction | field | references | other module | relationship_label |', '|---|---|---|---|---|', ...cross].join('\n')
        : '_(none: every relationship is between entities of this module)_',
    ].join('\n'),
  )

  // §7
  parts.push(
    [
      '## 7. Open questions',
      '',
      '### 7.1 🔴 Decisions needed (blockers)',
      '',
      '_(none)_',
      '',
      '### 7.2 🟡 Future considerations (deferred scope)',
      '',
      '_(none)_',
    ].join('\n'),
  )

  // §8.1 / §9.1
  if (options.includeGovernance) {
    const g = await loadGovernance(model, authInfo)
    if (g.permissions.length) {
      const adminPerm: string | undefined = m.admin_permission || `${slug}:admin`
      const included = new Map<string, string[]>()
      for (const h of g.hierarchy) {
        if (!included.has(h.including_permission_name)) included.set(h.including_permission_name, [])
        included.get(h.including_permission_name)!.push(h.included_permission_name)
      }
      const reach = new Set<string>()
      const stack = [adminPerm]
      while (stack.length) {
        const p = stack.pop()!
        for (const c of included.get(p) ?? []) if (!reach.has(c)) { reach.add(c); stack.push(c) }
      }

      const tables = ordered.filter((e) => ownSet.has(e.table_name)).map((e) => e.table_name as string)
      const classify = (p: string): { tier: string; rank: number } => {
        if (p === `${slug}:read`) return { tier: 'baseline-read', rank: 0 }
        if (p === `${slug}:manage`) return { tier: 'baseline-manage', rank: 1 }
        if (p === `${slug}:admin`) return { tier: 'baseline-admin', rank: 2 }
        for (let i = 0; i < tables.length; i++) {
          if (p === `${slug}:read_${tables[i]}`) return { tier: 'entity-read', rank: 10 + i * 2 }
          if (p === `${slug}:write_${tables[i]}`) return { tier: 'entity-write', rank: 11 + i * 2 }
        }
        return { tier: 'custom', rank: 1000 }
      }
      const perms = g.permissions
        .map((p) => ({ p, ...classify(p.permission_name) }))
        .sort((a, b) => a.rank - b.rank || a.p.permission_name.localeCompare(b.p.permission_name))

      parts.push(
        [
          '## 8.1 Permissions catalog',
          '',
          '| permission | tier | description | included in `:admin`? |',
          '| --- | --- | --- | --- |',
          ...perms.map(({ p, tier }) =>
            `| ${bt(p.permission_name)} | ${tier} | ${cell(p.description)} | ${p.permission_name === adminPerm ? '-' : reach.has(p.permission_name) ? '✓' : '-'} |`),
        ].join('\n'),
      )

      const baseline = new Set([`${slug}:read`, `${slug}:manage`, `${slug}:admin`])
      const permsByRole = new Map<number, string[]>()
      for (const rp of g.rolePermissions) {
        if (!permsByRole.has(rp.role_id)) permsByRole.set(rp.role_id, [])
        permsByRole.get(rp.role_id)!.push(rp.permission_name)
      }
      const gov: string[] = [`## 9. Governance`, '', `### 9.1 ${bt(slug.toUpperCase())}`]
      if (g.roles.length) {
        gov.push(
          '',
          '**Baseline roles:**',
          '',
          '| role | baseline grant | origin | catalog role code |',
          '| --- | --- | --- | --- |',
          ...g.roles.map((r) => {
            const grant = (permsByRole.get(r.id) ?? []).filter((p) => baseline.has(p)).map(bt).join(', ')
            return `| ${bt(r.slug || r.role_name)} | ${grant} | ${cell(r.origin)} | ${cell(r.catalog_role_code)} |`
          }),
        )
      }
      if (g.hierarchy.length) {
        gov.push(
          '',
          '**Permission hierarchy:**',
          '',
          '| permission | includes |',
          '| --- | --- |',
          ...g.hierarchy.map((h) => `| ${bt(h.including_permission_name)} | ${bt(h.included_permission_name)} |`),
        )
      }
      parts.push(gov.join('\n'))
    }
  }

  return parts.join('\n\n') + '\n'
}
