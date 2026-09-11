import type { Tool } from '../../types.ts'
import { makePostgrestRequest } from '../utils/postgrest.ts'
import { getEnv } from '../utils/env.ts'
import { getSemantiusOrg } from '../utils/semantiusOrg.ts'

const inputSchema = {}

export const getCurrentUserTool: Tool<typeof inputSchema, undefined> = {
  name: 'getCurrentUser',
  options: {
    title: 'Get Current User',
    description: 'Retrieves comprehensive profile information for the authenticated user, including email, roles, permissions, accessible modules, and user metadata',
    inputSchema,
  },
  handler: async (_, { authInfo, request }) => {
    try {
      const result = await makePostgrestRequest({
        path: '/rpc/get_userinfo',
        method: 'POST',
        body: '{}',
        token: authInfo?.token,
        apiBaseUrl: authInfo?.apiBaseUrl,
      })

      // Derive the service base URL so callers can invoke hook endpoints
      // via api_baseurl + "/hook/:id"
      const supabaseUrl = getEnv('SUPABASE_URL')
      const basePath = supabaseUrl ? '/functions/v1/postgrest-mcp' : ''
      const apiBaseUrl = request?.url
        ? `${new URL(request.url).origin}${basePath}`
        : null

      if (result.response?.status >= 200 && result.response?.status < 300) {
        const semantiusOrg = getSemantiusOrg(request)
        result.response.data.api_baseurl = apiBaseUrl
        result.response.data.semantius_org = semantiusOrg
        result.response.data.ui_baseurl = semantiusOrg
          ? `https://${semantiusOrg}.semantius.app`
          : null
      }

      

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    }
    catch (error: any) {
      console.error('getCurrentUser failed:', error)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error.message || 'Request failed'}`,
          },
        ],
        isError: true,
      }
    }
  },
}
