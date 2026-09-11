/**
 * Get CLI Token Tool
 * Exchanges the inbound x-api-key header for a short-lived JWT and returns
 * it along with its expiration time (shortened by 10 seconds for safety).
 */

import type { Tool } from '../../types.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { exchangeApiKeyForToken } from '../utils/apiKeyAuth.ts'
import { getSemantiusOrg } from '../utils/semantiusOrg.ts'

const inputSchema = {}

function decodeJwtExp(jwt: string): number {
  const parts = jwt.split('.')
  if (parts.length < 2) throw new Error('Invalid JWT format')
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
  const decoded = JSON.parse(atob(padded))
  if (typeof decoded.exp !== 'number') throw new Error('JWT missing exp claim')
  return decoded.exp
}

export const getCliTokenTool: Tool<typeof inputSchema, undefined> = {
  name: 'get_cli_token',
  options: {
    title: 'Get CLI Token',
    description:
      `Exchanges the caller's x-api-key for a short-lived JWT and returns ` +
      `it together with its expiration time. Fails if the inbound request ` +
      `did not include an x-api-key header.`,
    inputSchema,
  },
  handler: async (_, { request }) => {
    try {
      const apiKey = request?.headers?.['x-api-key']
      if (!apiKey) {
        throw new Error('x-api-key header is required')
      }

      const org = getSemantiusOrg(request)
      if (!org) {
        throw new Error('Could not determine organization slug from request')
      }

      const jwt = await exchangeApiKeyForToken(org, apiKey)
      const expSeconds = decodeJwtExp(jwt)
      const expires = new Date((expSeconds - 10) * 1000).toISOString()

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ expires, jwt }),
          },
        ],
      }
    } catch (error: any) {
      return handleToolError(error)
    }
  },
}
