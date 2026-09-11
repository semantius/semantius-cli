import type { Tool } from '../../types.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { formatSuccessResponse } from '../utils/formatResponse.ts'
import { resetSchemaCache } from '../utils/resetSchemaCache.ts'

export const refreshSchemaCacheTool: Tool<Record<never, never>, undefined> = {
  name: 'refresh_schema_cache',
  options: {
    title: 'Refresh Schema Cache',
    description: 'Forces a schema cache refresh',
    inputSchema: {},
  },
  handler: async (_input, { authInfo, request }) => {
    try {
      const host = request?.headers?.['x-forwarded-host'] || request?.headers?.['host'] || ''
      console.log('[refresh_schema_cache] url:', request?.url, 'x-forwarded-host:', request?.headers?.['x-forwarded-host'], 'host:', request?.headers?.['host'], '→ using:', host)
      const result = await resetSchemaCache(host, authInfo?.token)
      return formatSuccessResponse(result)
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
