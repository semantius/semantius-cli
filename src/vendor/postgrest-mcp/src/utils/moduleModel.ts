/**
 * Loads the live semantic model of one module: the module row, its entities,
 * all their fields, the relationships that leave and enter the module, and the
 * external (other-module) entities those relationships touch.
 *
 * Shared by generate_module_diagram and generate_spec.
 */

import { makePostgrestRequest } from './postgrest.ts'

export type Row = Record<string, any>

export interface ModuleModel {
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
}

export interface AuthInfoLike {
  token?: string
  apiBaseUrl?: string
}

export async function pgGet(path: string, authInfo: AuthInfoLike | undefined): Promise<Row[]> {
  const result = await makePostgrestRequest({
    path,
    method: 'GET',
    token: authInfo?.token,
    apiBaseUrl: authInfo?.apiBaseUrl,
  })
  const data = result.response.data
  return Array.isArray(data) ? data : []
}

/** PostgREST `in.(...)` list with each value URL-encoded. */
export const inList = (values: Array<string | number>) =>
  `in.(${values.map((v) => encodeURIComponent(String(v))).join(',')})`

const isRelationship = (f: Row) => (f.format === 'reference' || f.format === 'parent') && !!f.reference_table

/** Resolves a module by slug, name or numeric id. Returns null when none matches. */
export async function findModule(ref: string, authInfo: AuthInfoLike | undefined): Promise<Row | null> {
  const trimmed = ref.trim()
  const enc = encodeURIComponent(trimmed)
  const filter = /^\d+$/.test(trimmed) ? `id=eq.${enc}` : `or=(module_slug.eq.${enc},module_name.eq.${enc})`
  const rows = await pgGet(`/modules?${filter}&limit=1`, authInfo)
  return rows[0] ?? null
}

export async function loadModuleModel(
  moduleRef: string,
  authInfo: AuthInfoLike | undefined,
  includeIncoming: boolean,
): Promise<ModuleModel | null> {
  const module = await findModule(moduleRef, authInfo)
  if (!module) return null

  const entities = await pgGet(`/entities?module_id=eq.${module.id}&order=table_name.asc&limit=10000`, authInfo)
  const ownNames = entities.map((e) => e.table_name as string)
  const ownSet = new Set(ownNames)

  let fields: Row[] = []
  let incoming: Row[] = []
  if (ownNames.length) {
    fields = await pgGet(
      `/fields?table_name=${inList(ownNames)}&order=table_name.asc,field_order.asc&limit=10000`,
      authInfo,
    )
    if (includeIncoming) {
      const rows = await pgGet(
        `/fields?format=in.(reference,parent)&reference_table=${inList(ownNames)}&limit=10000`,
        authInfo,
      )
      // Fields of this module's own entities are already in `fields`.
      incoming = rows.filter((f) => !ownSet.has(f.table_name))
    }
  }
  const outgoing = fields.filter(isRelationship)

  const externalNames = new Set<string>()
  for (const f of outgoing) if (!ownSet.has(f.reference_table)) externalNames.add(f.reference_table)
  for (const f of incoming) externalNames.add(f.table_name)

  const external = new Map<string, Row>()
  if (externalNames.size) {
    const rows = await pgGet(`/entities?table_name=${inList([...externalNames])}&limit=10000`, authInfo)
    for (const r of rows) external.set(r.table_name, r)
  }

  const externalModules = new Map<number, string>()
  const moduleIds = [...new Set([...external.values()].map((e) => e.module_id).filter((id) => id != null))]
  if (moduleIds.length) {
    const rows = await pgGet(`/modules?id=${inList(moduleIds)}&select=id,module_name,module_slug&limit=10000`, authInfo)
    for (const r of rows) externalModules.set(r.id, r.module_slug || r.module_name)
  }

  return { module, entities, fields, outgoing, incoming, external, externalModules }
}
