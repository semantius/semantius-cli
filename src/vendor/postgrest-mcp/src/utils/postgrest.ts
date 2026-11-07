/**
 * Utility for making PostgREST API requests
 */

import { getEnv } from './env.ts'

interface PostgrestRequestOptions {
  path: string
  /**
   * Per-request tenant PostgREST base URL. The key is REQUIRED (every caller
   * must thread it) so routing is never read from shared isolate-global state.
   * The value may be undefined in the type because it flows through a loosely
   * typed context bag; it is validated (fail-closed) at runtime below and in
   * the /mcp handler, which 500s before any tool runs if it cannot resolve.
   */
  apiBaseUrl: string | undefined
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown> | Array<Record<string, unknown>> | string
  token?: string
  additionalHeaders?: Record<string, string>
}

/** PostgREST's JSON error. */
export interface PostgrestErrorBody {
  code?: string
  message: string
  details?: unknown
  hint?: unknown
}

const PLACEHOLDER = /\$\{([a-z][a-z0-9_]*)\}/g

/** The parameters of a platform error: a hint that starts with `{` and parses. */
function hintParameters(hint: unknown): Record<string, unknown> | undefined {
  if (typeof hint !== 'string' || !hint.startsWith('{')) return undefined
  try {
    return JSON.parse(hint)
  } catch {
    return undefined
  }
}

const shown = (value: unknown): string =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)

/**
 * A PostgREST error as one line: `(code) message (details) (rest) Hint: hint`.
 *
 * The platform never fills its own messages (semantius docs/error-contract.md,
 * "Client rules"): the message and the suggestion under the hint's `hint` key
 * are templates, and the client fills their ${name} placeholders from the JSON
 * in the hint. Any other hint is PostgreSQL's or PostgREST's own text, shown as
 * it is. `rest` is what no template named, which can still matter: why a value
 * field was refused, or the catalog number behind a 42501.
 */
export function formatPostgrestError(error: PostgrestErrorBody): string {
  const parameters = hintParameters(error.hint)
  const used = new Set(['hint'])
  const fill = (template: string): string =>
    template.replace(PLACEHOLDER, (placeholder, name: string) => {
      if (!parameters || !Object.hasOwn(parameters, name)) return placeholder
      used.add(name)
      return shown(parameters[name])
    })

  let text = fill(String(error.message))
  if (error.code) text = `(${error.code}) ${text}`
  if (error.details) text += ` (${error.details})`
  const suggestion = parameters ? parameters.hint : error.hint
  const hint = suggestion ? ` Hint: ${fill(String(suggestion))}` : ''
  const rest = Object.entries(parameters ?? {})
    .filter(([name]) => !used.has(name))
    .map(([name, value]) => `${name}: ${shown(value)}`)
  if (rest.length) text += ` (${rest.join(', ')})`
  return text + hint
}

function getHeaders(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  token?: string,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  const apiKey = getEnv('API_KEY') || getEnv('SUPABASE_ANON_KEY')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'prefer': 'return=representation',
    ...additionalHeaders,
  }

  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  // Add API key if configured (API_KEY takes precedence over SUPABASE_ANON_KEY)
  if (apiKey) {
    headers.apikey = apiKey
  }

  return headers
}

/**
 * Reads a successful response body by content type: JSON is parsed, other
 * types (e.g. text/csv) are returned as text, an empty body yields null.
 */
export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  const contentType = response.headers.get('content-type') ?? ''
  if (/\bjson\b/i.test(contentType) || contentType === '') {
    return JSON.parse(text)
  }
  return text
}

/**
 * Makes a request to the PostgREST API
 * @param options - Request options including path, method, body, token
 * @returns An object containing request details, response data, and response headers
 */
export async function makePostgrestRequest(options: PostgrestRequestOptions): Promise<any> {
  const { path, method = 'GET', body, token, additionalHeaders, apiBaseUrl } = options

  // Prefer the per-request apiBaseUrl. The env fallbacks are only ever STATIC
  // single-tenant config now (no code writes API_BASE_URL at runtime), so they
  // cannot leak one tenant's URL into another tenant's request.
  const SUPABASE_URL = getEnv('SUPABASE_URL')
  const API_BASE_URL = apiBaseUrl || getEnv('API_BASE_URL') || (SUPABASE_URL ? `${new URL(SUPABASE_URL).origin}/rest/v1` : '')

  if (!API_BASE_URL) {
    throw new Error('apiBaseUrl is required: no tenant PostgREST URL was resolved for this request')
  }

  const url = new URL(`${API_BASE_URL}${path}`)

  console.log(`Making ${method} request to PostgREST:`, url.toString())

  const headers = getHeaders(method, token, additionalHeaders)

  const response = await fetch(url, {
    method,
    headers,
    body: body
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : undefined,
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errmsg = errorText
    try {
      const json = JSON.parse(errorText)
      errmsg = formatPostgrestError({ ...json, message: json.message || errorText })
      console.error('PostgREST request failed:', url.toString(), method, body, json)
    } catch {
      console.error('PostgREST request failed:', url.toString(), method, body, errorText)
    }
    throw new Error(errmsg)
  }

  const responseData = await parseResponseBody(response)

  // Convert response headers to a plain object
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  return {
    request: {
      method,
      url: url.toString(),
      headers,
      body: body || null,
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data: responseData,
    },
  }
}

export type Row = Record<string, any>

export interface AuthInfoLike {
  token?: string
  apiBaseUrl?: string
}

// ---------- read helpers for the semantic model ----------

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

/** Resolves a module by slug, name or numeric id. Returns null when none matches. */
export async function findModule(ref: string, authInfo: AuthInfoLike | undefined): Promise<Row | null> {
  const trimmed = ref.trim()
  const enc = encodeURIComponent(trimmed)
  const filter = /^\d+$/.test(trimmed) ? `id=eq.${enc}` : `or=(module_slug.eq.${enc},module_name.eq.${enc})`
  const rows = await pgGet(`/modules?${filter}&limit=1`, authInfo)
  return rows[0] ?? null
}

/** All fields of the given entities, in display order. */
export async function fetchFields(tableNames: string[], authInfo: AuthInfoLike | undefined): Promise<Row[]> {
  if (!tableNames.length) return []
  return await pgGet(`/fields?table_name=${inList(tableNames)}&order=table_name.asc,field_order.asc&limit=10000`, authInfo)
}

/** The entities with the given table names, by table_name. */
export async function fetchEntitiesByName(
  tableNames: string[],
  authInfo: AuthInfoLike | undefined,
): Promise<Map<string, Row>> {
  const byName = new Map<string, Row>()
  if (!tableNames.length) return byName
  for (const r of await pgGet(`/entities?table_name=${inList(tableNames)}&limit=10000`, authInfo)) {
    byName.set(r.table_name, r)
  }
  return byName
}
