/**
 * Generate Spec Tool
 * Renders the live model of a module as a semantic-spec markdown document.
 */

import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { handleToolError } from '../utils/errorHandler.ts'
import type { AuthInfoLike, Row } from '../utils/postgrest.ts'
import { fetchEntitiesByName, fetchFields, findModule, inList, pgGet } from '../utils/postgrest.ts'
import { buildRelationshipDiagram, isRelationship } from '../utils/relationshipDiagram.ts'

/** The live model of one module: its entities, fields and the relationships leaving and entering it. */
interface ModuleModel {
  module: Row
  /** Entities that belong to the module. */
  entities: Row[]
  /** Every field of the module's entities. */
  fields: Row[]
  /** reference/parent fields of the module's entities (outgoing relationships). */
  outgoing: Row[]
  /** reference/parent fields of OTHER modules' entities that point at this module (empty when not requested). */
  incoming: Row[]
  /** External entities touched by any relationship, by table_name. */
  external: Map<string, Row>
  /** module id -> slug (or name) for the external entities' modules. */
  externalModules: Map<number, string>
  /** The `modules` rows of the external entities' modules. */
  externalModuleRows: Row[]
}

async function loadModuleModel(
  moduleRef: string,
  authInfo: AuthInfoLike | undefined,
  includeIncoming: boolean,
): Promise<ModuleModel | null> {
  const module = await findModule(moduleRef, authInfo)
  if (!module) return null

  const entities = await pgGet(`/entities?module_id=eq.${module.id}&order=table_name.asc&limit=10000`, authInfo)
  const ownNames = entities.map((e) => e.table_name as string)
  const ownSet = new Set(ownNames)

  const fields = await fetchFields(ownNames, authInfo)
  let incoming: Row[] = []
  if (ownNames.length && includeIncoming) {
    const rows = await pgGet(
      `/fields?format=in.(reference,parent)&reference_table=${inList(ownNames)}&limit=10000`,
      authInfo,
    )
    // Fields of this module's own entities are already in `fields`.
    incoming = rows.filter((f) => !ownSet.has(f.table_name))
  }
  const outgoing = fields.filter(isRelationship)

  const externalNames = new Set<string>()
  for (const f of outgoing) if (!ownSet.has(f.reference_table)) externalNames.add(f.reference_table)
  for (const f of incoming) externalNames.add(f.table_name)
  const external = await fetchEntitiesByName([...externalNames], authInfo)

  const externalModules = new Map<number, string>()
  let externalModuleRows: Row[] = []
  const moduleIds = [...new Set([...external.values()].map((e) => e.module_id).filter((id) => id != null))]
  if (moduleIds.length) {
    // Every column, not a select list: `version` feeds deployed_related_versions, and naming
    // it would make the read fail outright on a platform that has no version column yet.
    externalModuleRows = await pgGet(`/modules?id=${inList(moduleIds)}&limit=10000`, authInfo)
    for (const r of externalModuleRows) externalModules.set(r.id, r.module_slug || r.module_name)
  }

  return { module, entities, fields, outgoing, incoming, external, externalModules, externalModuleRows }
}

/**
 * Renders the live model of a module as a semantic-spec markdown document
 * (frontmatter, §1 Overview, §2 Entity
 * summary + diagram, §3 Entities, §4 Relationship summary, §5 Enumerations,
 * §6 Cross-model relationships, §7 Open questions, §8.1 Permissions catalog,
 * §9.1 Governance).
 *
 * Handoffs and business-rule intents (§6 handoffs, §8.2) are design-time
 * material that is not stored on the platform, so they are not generated.
 */

const SPEC_VERSION = '4.0'

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

/** A JSON rule value worth printing: a non-empty array, or an object with at least one key. */
function isNonEmpty(v: unknown): boolean {
  if (v == null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return false
}

function deleteMode(f: Row): string {
  return f.reference_delete_mode || (f.format === 'parent' ? 'cascade' : 'restrict')
}

/** A JSON column's value, parsed when it arrives as a string (undefined when it does not parse). */
function jsonColumn(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

/** The module's `settings` column as an object (it can arrive as a JSON string). */
function moduleSettings(m: Row): Record<string, unknown> {
  const s = jsonColumn(m.settings)
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {}
}

// ---------- permission analysis (§8.1 tiers) ----------

/** Text before the colon of `<prefix>:<suffix>`. */
const permPrefix = (name: string) => name.split(':')[0]
/** Text after the colon of `<prefix>:<suffix>`. */
const permSuffix = (name: string) => name.split(':').pop() || name

/** The code an entity's edit permission carries, if it is one of a module's codes: none on a
 *  computed entity, which has no write tier, and none at the platform's column default `admin`. */
const editCode = (e: Row): string =>
  e.entity_type === 'computed' || e.edit_permission === 'admin' ? '' : e.edit_permission || ''

/** Permission name -> the names it directly includes. */
function includesIndex(hierarchy: Row[]): Map<string, string[]> {
  const includes = new Map<string, string[]>()
  for (const h of hierarchy) {
    if (!includes.has(h.including_permission_name)) includes.set(h.including_permission_name, [])
    includes.get(h.including_permission_name)!.push(h.included_permission_name)
  }
  return includes
}

/** Every permission `root` includes, transitively. */
function includedClosure(root: string, includes: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length) {
    for (const next of includes.get(stack.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next) }
  }
  return seen
}

/** A `<prefix>:write_<entity>` that includes its own `<prefix>:read_<entity>`, as every
 *  entity-write row does. That row tells it from a gate named `write_off_invoice`. */
function writesEntity(name: string, includes: Map<string, string[]>): boolean {
  const suffix = permSuffix(name)
  if (!suffix.startsWith('write_')) return false
  return (includes.get(name) ?? []).includes(`${permPrefix(name)}:read_${suffix.slice('write_'.length)}`)
}

/** A code that includes a write permission is a bundle, not a gate. */
function includesWrite(name: string, includes: Map<string, string[]>): boolean {
  for (const n of includedClosure(name, includes)) if (writesEntity(n, includes)) return true
  return false
}

/** Codes a JsonLogic value cites through `require_permission` or `has_permission`. */
function citedPermissions(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) citedPermissions(x, out)
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'require_permission' || k === 'has_permission') {
        for (const a of Array.isArray(x) ? x : [x]) {
          if (typeof a === 'string') out.add(a)
          else citedPermissions(a, out)
        }
      } else citedPermissions(x, out)
    }
  }
  return out
}

/** A JsonLogic value that carries `{"value_changed": "workflow_state"}`: a state transition rule. */
function hasStateTransition(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasStateTransition)
  if (v === null || typeof v !== 'object') return false
  return Object.entries(v).some(([k, x]) =>
    k === 'value_changed' ? (Array.isArray(x) ? x[0] : x) === 'workflow_state' : hasStateTransition(x))
}

/** The insert check `{"==": [{"var": "$old"}, null]}`, in either operand order. */
function isInsertCheck(v: any): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v['==']) || v['=='].length !== 2) return false
  const isOld = (x: any) => x !== null && typeof x === 'object' && !Array.isArray(x) && x.var === '$old'
  const [a, b] = v['==']
  return (isOld(a) && b === null) || (isOld(b) && a === null)
}

/** Codes in the gated branch of a create guard: `{"if": [<insert check>, <gate check>, true]}`. */
function createGateCodes(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) createGateCodes(x, out)
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'if' && Array.isArray(x) && x.length >= 2 && isInsertCheck(x[0])) citedPermissions(x[1], out)
      createGateCodes(x, out)
    }
  }
  return out
}

/** Codes in a `has_permission` branch of an `or` that also holds an `is_raci_actor` branch. */
function raciGateCodes(v: unknown, out: Set<string> = new Set()): Set<string> {
  const isOp = (b: any, op: string) => b !== null && typeof b === 'object' && !Array.isArray(b) && op in b
  if (Array.isArray(v)) {
    for (const x of v) raciGateCodes(x, out)
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'or' && Array.isArray(x) && x.some((b) => isOp(b, 'is_raci_actor'))) {
        for (const b of x) {
          if (!isOp(b, 'has_permission')) continue
          for (const a of Array.isArray(b.has_permission) ? b.has_permission : [b.has_permission]) {
            if (typeof a === 'string') out.add(a)
          }
        }
      }
      raciGateCodes(x, out)
    }
  }
  return out
}

/**
 * The §8.1 rows: tier, `included in :admin?` and `high risk?` per permission.
 *
 * The platform stores no tier, so the tier is a heuristic over what the live model proves, one of
 * `baseline-read`, `baseline-manage`, `baseline-admin`, `entity-read`, `entity-write`, `bundle`,
 * `narrow`, `workflow-gate (lifecycle)`, `workflow-gate (rule)` and `override`, tested in this order:
 *   entity-write   a `write_*` an owned entity's edit permission names, or that includes its
 *                  own `read_*`. Not under `access_scope: custom`.
 *   entity-read    a `read_*` an owned entity's view permission names, or that the module's
 *                  `read` or an entity-write row includes. Not under `access_scope: custom`.
 *   bundle         a code that includes other permissions and is granted to a role directly, or
 *                  that includes one of the module's `read` / `manage` / `admin` bundles: a
 *                  container built to be granted, whose content is its hierarchy rows. Tested
 *                  before narrow, which a bundle over `manage` would otherwise match.
 *   narrow         a code that includes a write permission, or any other code an owned
 *                  entity's edit permission names.
 *   workflow-gate (rule)       `bypass_submit_lock`, by name.
 *   override       a `view_all_*` / `manage_all_*` code, by name.
 *   workflow-gate (lifecycle)  cited by a `workflow_state` transition rule, next to
 *                  `is_raci_actor` in an `or`, or in a create guard.
 *   workflow-gate (rule)       cited by any other validation rule.
 *   override       cited by select rules only: it widens which rows its holder sees and guards
 *                  no write, like a `view_all_*` code.
 *   workflow-gate (lifecycle)  everything else.
 * `included in :admin?` is ✓ when the admin permission transitively includes the row (with no
 * admin permission, ✓ on every row). `high risk?` is ✓ only under `access_scope: raci`, on a
 * lifecycle gate the admin does not include: under `gated` the admin holds every gate, so live
 * state cannot show which gates are high-risk.
 */
function permissionRows(
  m: Row,
  permissions: Row[],
  hierarchy: Row[],
  owned: Row[],
  granted: Set<string>,
): Array<{ p: Row; tier: string; inAdmin: string; highRisk: string }> {
  const includes = includesIndex(hierarchy)
  const editColumns = new Set(owned.map(editCode).filter(Boolean))
  const entityReads = new Set<string>(owned.map((e) => e.view_permission).filter(Boolean))
  for (const h of hierarchy) {
    const by: string = h.including_permission_name
    if (permSuffix(by) === 'read' || writesEntity(by, includes)) entityReads.add(h.included_permission_name)
  }
  const baselines = new Set(
    permissions.map((p) => p.permission_name as string).filter((n) => ['read', 'manage', 'admin'].includes(permSuffix(n))),
  )
  const isBundle = (name: string) => {
    const inner = includes.get(name) ?? []
    return inner.length > 0 && (granted.has(name) || inner.some((n) => baselines.has(n)))
  }
  const perEntity = String(m.access_scope) !== 'custom'
  // Validation-rule citations are gate evidence; a select-rule citation only scopes visibility.
  const ruleCited = new Set<string>()
  const selectCited = new Set<string>()
  const lifecycleCited = new Set<string>()
  for (const e of owned) {
    const rules = Array.isArray(e.validation_rules) ? e.validation_rules : e.validation_rules ? [e.validation_rules] : []
    for (const rule of rules) {
      const codes = citedPermissions(rule)
      for (const c of codes) ruleCited.add(c)
      if (hasStateTransition(rule)) for (const c of codes) lifecycleCited.add(c)
      for (const c of raciGateCodes(rule)) lifecycleCited.add(c)
      for (const c of createGateCodes(rule)) lifecycleCited.add(c)
    }
    for (const c of citedPermissions(e.select_rule ?? {})) selectCited.add(c)
  }
  const raci = String(m.access_scope) === 'raci'
  const adminPerm = permissions.find((p) => hasValue(m.admin_permission) && p.permission_name === m.admin_permission) ??
    permissions.find((p) => permSuffix(p.permission_name) === 'admin')
  const adminClosure = adminPerm ? includedClosure(adminPerm.permission_name, includes) : null

  const rank = (name: string) => {
    const s = permSuffix(name)
    return s === 'read' ? 0 : s === 'manage' ? 1 : s === 'admin' ? 2 : 3
  }
  return [...permissions]
    .sort((a, b) => rank(a.permission_name) - rank(b.permission_name) || a.permission_name.localeCompare(b.permission_name))
    .map((p) => {
      const name: string = p.permission_name
      const suffix = permSuffix(name)
      let tier: string
      if (suffix === 'read') tier = 'baseline-read'
      else if (suffix === 'manage') tier = 'baseline-manage'
      else if (suffix === 'admin') tier = 'baseline-admin'
      else if (perEntity && suffix.startsWith('write_') && (editColumns.has(name) || writesEntity(name, includes))) tier = 'entity-write'
      else if (perEntity && suffix.startsWith('read_') && entityReads.has(name)) tier = 'entity-read'
      else if (isBundle(name)) tier = 'bundle'
      else if (editColumns.has(name) || includesWrite(name, includes)) tier = 'narrow'
      else if (suffix === 'bypass_submit_lock') tier = 'workflow-gate (rule)'
      else if (/^(view_all_|manage_all_)/.test(suffix)) tier = 'override'
      else if (lifecycleCited.has(name)) tier = 'workflow-gate (lifecycle)'
      else if (ruleCited.has(name)) tier = 'workflow-gate (rule)'
      else if (selectCited.has(name)) tier = 'override'
      else tier = 'workflow-gate (lifecycle)'
      const inAdmin = tier === 'baseline-admin' ? '-' : !adminClosure || adminClosure.has(name) ? '✓' : '-'
      const highRisk = raci && tier === 'workflow-gate (lifecycle)' && inAdmin === '-' ? '✓' : '-'
      return { p, tier, inAdmin, highRisk }
    })
}

// ---------- permissions / roles (live) ----------

interface Governance {
  permissions: Row[]
  hierarchy: Row[]
  roles: Row[]
  rolePermissions: Row[]
  /** The module's RACI processes (`processes.module_id`), in stored ordering. */
  processes: Row[]
  /** The RACI matrix rows of those processes. */
  raciAssignments: Row[]
  /** The gates of those processes: which entity transition each one governs. */
  processGates: Row[]
  /** role id -> slug, for every role an assignment names (other modules' roles included). */
  roleSlugs: Map<number, string>
}

/** Rows of a platform table that an older platform may not have: none when the table is missing
 *  (PostgREST `PGRST205`, PostgreSQL `42P01`). Any other failure still throws. */
async function optionalGet(path: string, authInfo: AuthInfoLike | undefined): Promise<Row[]> {
  try {
    return await pgGet(path, authInfo)
  } catch (error) {
    if (/PGRST205|42P01/.test(String((error as Error)?.message))) return []
    throw error
  }
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

  // Every column of the three RACI tables, so no stored value is dropped.
  const processes = await optionalGet(
    `/processes?module_id=eq.${model.module.id}&order=ordering.asc.nullslast,process_key.asc&limit=10000`,
    authInfo,
  )
  const processIds = processes.map((p) => p.id)
  const raciAssignments = processIds.length
    ? await optionalGet(`/raci_assignments?process_id=${inList(processIds)}&limit=10000`, authInfo)
    : []
  const processGates = processIds.length
    ? await optionalGet(`/process_gates?process_id=${inList(processIds)}&limit=10000`, authInfo)
    : []
  const roleSlugs = new Map<number, string>(roles.map((r) => [r.id, r.slug || r.role_name]))
  const otherRoleIds = [...new Set(raciAssignments.map((a) => a.role_id).filter((id) => id != null && !roleSlugs.has(id)))]
  if (otherRoleIds.length) {
    for (const r of await pgGet(`/roles?id=${inList(otherRoleIds)}&limit=10000`, authInfo)) roleSlugs.set(r.id, r.slug || r.role_name)
  }
  return { permissions, hierarchy, roles, rolePermissions, processes, raciAssignments, processGates, roleSlugs }
}

/**
 * The §9.1 RACI tables: the module's processes, the RACI matrix and the gates, every stored
 * column but the ids, the timestamps and the computed `name` of an assignment or a gate (it
 * mirrors the letter or the gate kind). A module with no process says so in one line.
 */
function raciTables(g: Governance): string[] {
  if (!g.processes.length) return ['**Processes:** _(none: the module stores no RACI processes)_']
  const keyOf = new Map<number, string>(g.processes.map((p) => [p.id, p.process_key]))
  const position = new Map<number, number>(g.processes.map((p, i) => [p.id, i]))
  const byProcess = (a: Row, b: Row) => (position.get(a.process_id) ?? 0) - (position.get(b.process_id) ?? 0)
  const letter = ['responsible', 'accountable', 'consulted', 'informed']
  const role = (id: unknown) => {
    const slug = id == null ? undefined : g.roleSlugs.get(id as number)
    return slug ? bt(slug) : cell(id)
  }
  const flag = (v: unknown) => (typeof v === 'boolean' ? yesNo(v) : cell(v))

  const out = [
    '**Processes:**',
    '',
    '| process_key | name | description | ordering |',
    '| --- | --- | --- | --- |',
    ...g.processes.map((p) => `| ${bt(p.process_key)} | ${cell(p.name)} | ${cell(p.description)} | ${cell(p.ordering)} |`),
    '',
    '**RACI assignments:**',
    '',
  ]
  const assignments = [...g.raciAssignments].sort((a, b) =>
    byProcess(a, b) || letter.indexOf(a.raci) - letter.indexOf(b.raci) || String(role(a.role_id)).localeCompare(String(role(b.role_id))))
  out.push(
    ...(assignments.length
      ? [
        '| process_key | role | raci | consult_mode | origin |',
        '| --- | --- | --- | --- | --- |',
        ...assignments.map((a) =>
          `| ${bt(keyOf.get(a.process_id) ?? String(a.process_id))} | ${role(a.role_id)} | ${cell(a.raci)} | ${cell(a.consult_mode)} | ${cell(a.origin)} |`),
      ]
      : ['_(none)_']),
    '',
    '**Process gates:**',
    '',
  )
  const gates = [...g.processGates].sort((a, b) =>
    byProcess(a, b) || String(a.entity).localeCompare(String(b.entity)) || String(a.to_state ?? '').localeCompare(String(b.to_state ?? '')))
  out.push(
    ...(gates.length
      ? [
        '| process_key | entity | gate_kind | to_state | state_column | emits_events |',
        '| --- | --- | --- | --- | --- | --- |',
        ...gates.map((x) =>
          `| ${bt(keyOf.get(x.process_id) ?? String(x.process_id))} | ${x.entity ? bt(x.entity) : ''} | ${cell(x.gate_kind)} | ` +
          `${cell(x.to_state)} | ${cell(x.state_column)} | ${flag(x.emits_events)} |`),
      ]
      : ['_(none)_']),
  )
  return out
}

// ---------- front matter ----------

/**
 * The keys the platform stores, in a fixed order. The authored keys (`license`,
 * the `description` block, `created_at`, `reconciled_*`, `source_blueprint`, `persona`,
 * `initial_request`, …) are not stored on the platform, so they are not generated: a value
 * here would be invented, not read.
 */
function frontmatter(model: ModuleModel, ordered: Row[], externalModuleSlugs: string[], today: string): string {
  const m = model.module
  const settings = moduleSettings(m)
  const out: string[] = ['---', 'artifact: semantic-spec', `version: "${SPEC_VERSION}"`]
  out.push(`system_name: ${JSON.stringify(m.module_name)}`)
  // The module's description column holds the spec's one-line tagline.
  if (hasValue(m.description)) out.push(`tagline: ${JSON.stringify(String(m.description).trim())}`)
  if (m.icon_name) out.push(`icon_name: ${m.icon_name}`)
  out.push(`system_slug: ${m.module_slug}`)
  if (m.module_type) out.push(`module_type: ${m.module_type}`)
  if (hasValue(settings.module_kind)) out.push(`module_kind: ${settings.module_kind}`)
  if (m.access_scope) out.push(`access_scope: ${m.access_scope}`)
  // The module's own permission pointers (its read, manage and admin bundles).
  if (hasValue(m.view_permission)) out.push(`view_permission: ${m.view_permission}`)
  if (hasValue(m.manage_permission)) out.push(`manage_permission: ${m.manage_permission}`)
  if (hasValue(m.admin_permission)) out.push(`admin_permission: ${m.admin_permission}`)
  if (m.domain_code) out.push(`domain_code: ${m.domain_code}`)
  if (hasValue(m.catalog_module_code)) out.push(`catalog_module_code: ${m.catalog_module_code}`)
  if (hasValue(settings.naming_mode)) out.push(`naming_mode: ${settings.naming_mode}`)
  // Every other settings key, as JSON (a YAML flow mapping), so no stored setting is dropped.
  const otherSettings = Object.fromEntries(
    Object.entries(settings).filter(([k]) => k !== 'module_kind' && k !== 'naming_mode'),
  )
  if (Object.keys(otherSettings).length) out.push(`settings: ${JSON.stringify(otherSettings)}`)
  // Quoted: YAML reads an unquoted `#` as the start of a comment.
  if (hasValue(m.logo_color)) out.push(`logo_color: "${m.logo_color}"`)
  if (hasValue(m.home_page)) out.push(`home_page: ${m.home_page}`)
  // A platform without a version column omits the deploy provenance.
  if (hasValue(m.version)) {
    out.push(`deployed_version: ${m.version}`)
    if (hasValue(m.version_date)) out.push(`deployed_version_date: "${m.version_date}"`)
    // The modules this one depends on: those its own fields reference, not those referencing it.
    const dependsOn = new Set(
      model.outgoing.map((f) => model.external.get(f.reference_table)?.module_id).filter((id) => id != null),
    )
    const related = model.externalModuleRows
      .filter((r) => dependsOn.has(r.id) && hasValue(r.version) && r.id !== m.id)
      .map((r) => [String(r.module_slug || r.module_name), r.version] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    if (related.length) out.push('deployed_related_versions:', ...related.map(([s, v]) => `  ${s}: ${v}`))
  }
  out.push(`generated_at: ${today}`, 'generated_from: live Semantius model')
  out.push('entities:', ...ordered.map((e) => `  - ${e.table_name}`))
  if (externalModuleSlugs.length) out.push('related_modules:', ...externalModuleSlugs.map((s) => `  - ${s}`))
  out.push('---')
  return out.join('\n')
}

// ---------- §3 entity blocks ----------

/** A field's `ctype` worth printing: empty (and the legacy `custom`) is an ordinary field. */
const fieldCtype = (f: Row): string => (hasValue(f.ctype) && f.ctype !== 'custom' ? String(f.ctype) : '')

/**
 * The Notes cell. Every stored property of the field that has no column of its own, each left
 * out at the platform default listed in §3's opening note (precision prints at every value).
 */
function fieldNotes(f: Row, entity: Row): string {
  const parts: string[] = []
  if (entity.label_column && f.field_name === entity.label_column) parts.push(bt('label_column'))
  if (f.is_pk) parts.push(bt('primary key'))

  if (isRelationship(f)) {
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
  // The decimal scale of a number column, at every value (the platform default 2 included; a
  // rollup's is copied from its value field). Other formats ignore the column.
  if (f.format === 'number' && f.precision != null) parts.push(`precision: ${f.precision}`)
  if (hasValue(f.default_value)) parts.push(`default: "${f.default_value}"`)
  if (f.unique_value && !isRelationship(f)) parts.push(bt('unique'))
  // Whenever the live flag is on, the label column included.
  if (f.searchable) parts.push(bt('searchable'))
  if (fieldCtype(f)) parts.push(`ctype: ${fieldCtype(f)}`)
  if (hasValue(f.width) && f.width !== 'default') parts.push(`width: ${f.width}`)
  if (hasValue(f.cube_type) && f.cube_type !== 'auto') parts.push(`cube_type: ${f.cube_type}`)
  if (hasValue(f.singular_label_parent) || hasValue(f.plural_label_parent)) {
    parts.push(`parent label: "${f.singular_label_parent ?? ''}" / "${f.plural_label_parent ?? ''}"`)
  }
  if (hasValue(f.catalog_field_code)) parts.push(`catalog_field_code: "${f.catalog_field_code}"`)
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

async function buildModuleSpec(
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
  const dashboard = jsonColumn(m.dashboard_config)
  if (isNonEmpty(dashboard)) parts.push(['**Dashboard config**', '', '```json', JSON.stringify(dashboard, null, 2), '```'].join('\n'))

  // §2
  const rows = ordered.map((e, i) =>
    `| ${i + 1} | ${bt(e.table_name)} | ${cell(e.singular_label || e.table_name)} | ${cell(firstSentence(e.description))} |`)
  const diagram = await buildRelationshipDiagram({ module_slugs: [slug] }, authInfo)
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
  const s3: string[] = [
    '## 3. Entities',
    // What a missing line or marker means, so the spec covers every stored value without
    // printing each platform default.
    'A property left out holds its platform default. Entity: id column `id`, key type ' +
    '`auto_increment`, edit mode `auto`, cube mode `auto`, managed `yes`, plural name equal to the ' +
    'table name. Field: an ordinary field (no `ctype`), not the primary key, width `default`, ' +
    'cube_type `auto`, no default value, not unique, not searchable, no parent label, no catalog ' +
    'field code. Every other empty property holds nothing. Precision is printed on every `number` ' +
    'field, at the default 2 too.',
  ]
  ordered.forEach((e, i) => {
    const table: string = e.table_name
    const own = ownSet.has(table)
    const b: string[] = [`### 3.${i + 1} ${bt(table)} - ${e.singular_label || table}`, '']
    const meta: string[] = [`**Plural label:** ${e.plural_label || table}`]

    if (own) {
      // Every field row of the entity, the platform-created ones (`id`, the label field,
      // `created_at`, `updated_at`, other protected columns) included, in stored field_order.
      const fields = fieldsByTable.get(table) ?? []
      if (hasValue(e.singular)) meta.push(`**Singular name:** ${bt(e.singular)}`)
      if (hasValue(e.plural) && e.plural !== table) meta.push(`**Plural name:** ${bt(e.plural)}`)
      if (hasValue(e.label_column)) meta.push(`**Label column:** ${bt(e.label_column)}`)
      if (hasValue(e.order_column)) meta.push(`**Order column:** ${bt(e.order_column)}`)
      if (hasValue(e.id_column) && e.id_column !== 'id') meta.push(`**Id column:** ${bt(e.id_column)}`)
      if (hasValue(e.id_type) && e.id_type !== 'auto_increment') meta.push(`**Key type:** ${e.id_type}`)
      if (hasValue(e.id_prefix)) meta.push(`**Key prefix:** ${e.id_prefix}`)
      if (hasValue(e.id_refentity)) meta.push(`**Based on:** ${bt(e.id_refentity)}`)
      if (hasValue(e.label_parent)) meta.push(`**Label parent:** ${bt(e.label_parent)}`)
      meta.push(`**Audit log:** ${yesNo(e.audit_log)}`)
      if (e.managed === false) meta.push('**Managed:** no')
      if (hasValue(e.view_permission)) meta.push(`**View permission:** ${e.view_permission}`)
      if (hasValue(e.edit_permission)) meta.push(`**Edit permission:** ${e.edit_permission}`)
      if (hasValue(e.edit_mode) && e.edit_mode !== 'auto') meta.push(`**Edit mode:** ${e.edit_mode}`)
      if (hasValue(e.cube_mode) && e.cube_mode !== 'auto') meta.push(`**Cube mode:** ${e.cube_mode}`)
      if (hasValue(e.icon_name)) meta.push(`**Icon:** ${e.icon_name}`)
      if (hasValue(e.name_sort)) meta.push(`**Name sort:** ${e.name_sort}`)
      if (hasValue(e.catalog_entity_code)) meta.push(`**Catalog entity code:** ${bt(e.catalog_entity_code)}`)
      if (hasValue(e.entity_type)) meta.push(`**Entity type:** ${e.entity_type}`)
      if (hasValue(e.catalog_owner_module)) meta.push(`**Catalog owner:** ${e.catalog_owner_module}`)
      // One line per absorbed identity: `alias_code: …, source_domain: …, source_module: …`.
      const aliases = jsonColumn(e.catalog_entity_aliases)
      for (const a of Array.isArray(aliases) ? aliases : []) {
        const text = a !== null && typeof a === 'object'
          ? Object.entries(a).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')
          : String(a)
        meta.push(`**Catalog alias:** ${text}`)
      }
      if (hasValue(e.description)) meta.push(`**Description:** ${String(e.description).trim()}`)
      // Bold key lines need a trailing double-space/line break to stay separate lines in markdown.
      b.push(meta.map((l) => `${l}  `).join('\n').replace(/ {2}$/, ''), '')

      if (fields.length) {
        b.push(
          '**Fields**',
          '',
          '| Field name | Format | Input type | Label | Description | Reference / Notes | Order |',
          '|---|---|---|---|---|---|---|',
          ...fields.map((f) =>
            `| ${bt(f.field_name)} | ${bt(f.format)} | ${cell(f.input_type)} | ${cell(f.title)} | ${cell(f.description)} | ${cell(fieldNotes(f, e))} | ${cell(f.field_order)} |`),
          '',
        )
      }

      const outgoing = fields.filter(isRelationship)
      const incomingFromAll = allRel.filter((f) => f.reference_table === table)
      const bullets = relationshipBullets(table, isJunction(e), outgoing, isJunction(e) ? [] : incomingFromAll)
      if (bullets.length) b.push('**Relationships**', '', ...bullets, '')

      if (Array.isArray(e.computed_fields) && e.computed_fields.length) {
        b.push('**Computed fields**', '', '```json', JSON.stringify(e.computed_fields, null, 2), '```', '')
      }
      if (Array.isArray(e.validation_rules) && e.validation_rules.length) {
        b.push('**Validation rules**', '', '```json', JSON.stringify(e.validation_rules, null, 2), '```', '')
      }
      // Every field of the entity, not only the §3 table's: a rule on a hidden field is still part of the model.
      const inputTypeRules = (fieldsByTable.get(table) ?? [])
        .filter((f) => isNonEmpty(f.input_type_rule))
        .map((f) => ({ field: f.field_name, jsonlogic: f.input_type_rule }))
      if (inputTypeRules.length) {
        b.push('**Input type rules**', '', '```json', JSON.stringify(inputTypeRules, null, 2), '```', '')
      }
      if (isNonEmpty(e.select_rule)) {
        b.push('**Select rule**', '', '```json', JSON.stringify(e.select_rule, null, 2), '```', '')
      }
    } else {
      // Entity of another module that this module references.
      const modSlug = e.module_id != null ? model.externalModules.get(e.module_id) : undefined
      // Its stored flag; none when the entity could not be read.
      if (typeof e.audit_log === 'boolean') meta.push(`**Audit log:** ${yesNo(e.audit_log)}`)
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
    // Every permission a role of the module is granted directly, by role.
    const permsByRole = new Map<number, string[]>()
    for (const rp of g.rolePermissions) {
      if (!permsByRole.has(rp.role_id)) permsByRole.set(rp.role_id, [])
      permsByRole.get(rp.role_id)!.push(rp.permission_name)
    }
    const granted = new Set<string>(g.rolePermissions.map((rp) => rp.permission_name))
    if (g.permissions.length) {
      parts.push(
        [
          '## 8.1 Permissions catalog',
          '',
          '| permission | tier | description | included in `:admin`? | high risk? |',
          '| --- | --- | --- | --- | --- |',
          ...permissionRows(m, g.permissions, g.hierarchy, model.entities, granted).map(({ p, tier, inAdmin, highRisk }) =>
            `| ${bt(p.permission_name)} | ${tier} | ${cell(p.description)} | ${inAdmin} | ${highRisk} |`),
        ].join('\n'),
      )
    }
    // §9.1 is always present: its Processes line says whether the module stores a RACI matrix.
    {
      // The module's default-role FKs: which role a new member of each tier is given.
      const defaultTiers = new Map<number, string[]>()
      for (const [tier, id] of [
        ['viewer', m.default_viewer_role_id],
        ['manager', m.default_manager_role_id],
        ['admin', m.default_admin_role_id],
      ] as const) {
        if (id == null) continue
        if (!defaultTiers.has(id)) defaultTiers.set(id, [])
        defaultTiers.get(id)!.push(tier)
      }
      // Default roles first, in tier order (viewer, manager, admin), then the others by name.
      const tierRank = (r: Row) => {
        const t = defaultTiers.get(r.id)?.[0]
        return t === 'viewer' ? 0 : t === 'manager' ? 1 : t === 'admin' ? 2 : 3
      }
      const roles = [...g.roles].sort((a, b) => tierRank(a) - tierRank(b))
      const gov: string[] = [`## 9. Governance`, '', `### 9.1 ${bt(slug.toUpperCase())}`]
      if (roles.length) {
        gov.push(
          '',
          '**Roles:**',
          '',
          // Every role of the module with every permission it is granted directly. `default` names
          // the tier whose module pointer names the role. Every row is `♻ exists` (U+267B, no
          // variation selector): the spec is read from live state.
          '| role | name | description | grants | origin | catalog role code | default | reconciliation |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          ...roles.map((r) => {
            const grants = [...(permsByRole.get(r.id) ?? [])].sort().map(bt).join(', ')
            const tiers = defaultTiers.get(r.id)?.join(', ') ?? '-'
            return `| ${bt(r.slug || r.role_name)} | ${cell(r.role_name)} | ${cell(r.description)} | ${grants} | ` +
              `${cell(r.origin)} | ${cell(r.catalog_role_code)} | ${tiers} | ♻ exists |`
          }),
        )
      }
      if (g.hierarchy.length) {
        gov.push(
          '',
          '**Permission hierarchy:**',
          '',
          '| permission | includes | origin | reconciliation |',
          '| --- | --- | --- | --- |',
          ...g.hierarchy.map((h) =>
            `| ${bt(h.including_permission_name)} | ${bt(h.included_permission_name)} | ${cell(h.origin)} | ♻ exists |`),
        )
      }
      gov.push('', ...raciTables(g))
      parts.push(gov.join('\n'))
    }
  }

  return parts.join('\n\n') + '\n'
}

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
      `(module and external entities in different colors, one-line entity label nodes, arrows labelled by relationship_label), ` +
      `3. Entities (properties, fields, relationships, computed fields, validation rules, input type rules, select rule), ` +
      `4. Relationship summary, 5. Enumerations, ` +
      `6. Cross-model relationships, 7. Open questions, 8.1 Permissions catalog and 9.1 Governance ` +
      `(every role of the module with all its direct grants and its default tier, the permission hierarchy, ` +
      `and the module's RACI processes, RACI assignments and process gates). ` +
      `It covers every stored property of the module, its entities, all their fields (the platform-created id, label, ` +
      `created_at and updated_at rows included), its permissions, hierarchy rows and roles; a property left out holds ` +
      `the platform default that section 3 states. Not covered: the fields of entities owned by other modules, the ` +
      `computed entity flags searchable and is_child, the computed name of a RACI assignment or gate, ` +
      `processes with no module, and when and by whom a role was granted a permission. ` +
      `The permission tier is inferred, since the platform stores none. ` +
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
