/**
 * Send Email tool — proxies to the Semantius email service, forwarding the
 * caller's Authorization bearer token or x-api-key for upstream auth.
 */

import { z } from 'zod/v4'
import type { Tool } from '../../types.ts'
import { handleToolError } from '../utils/errorHandler.ts'
import { getSemantiusOrg } from '../utils/semantiusOrg.ts'

const recipient = z.string().email()
const recipients = z.union([recipient, z.array(recipient).min(1)])

const inputSchema = {
  to: recipients.describe('Recipient email address, or array of addresses'),
  from: recipient.optional().describe(
    "Sender email address. Defaults to the authenticated user's email.",
  ),
  subject: z.string().min(1).describe('Email subject line'),
  html: z.string().optional().describe('HTML body content'),
  text: z.string().optional().describe('Plain-text body content'),
  replyTo: recipient.optional().describe('Reply-To address. Defaults to `from`.'),
  cc: recipients.optional().describe('CC recipient address(es)'),
  bcc: recipients.optional().describe('BCC recipient address(es)'),
}

export const sendEmailTool: Tool<typeof inputSchema, undefined> = {
  name: 'sendEmail',
  options: {
    title: 'Send Email',
    description:
      'Sends a transactional email. Provide either `html` or `text` (or both). ' +
      'Returns the provider messageId on success.',
    inputSchema,
  },
  handler: async (input, { authInfo, request }) => {
    try {
      if (!input.html && !input.text) {
        throw new Error('SendMail: Either `html` or `text` must be provided')
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      const bearer = authInfo?.token
      const apiKey = request?.headers?.['x-api-key']
      if (bearer) {
        headers['Authorization'] = `Bearer ${bearer}`
      } else if (apiKey) {
        headers['x-api-key'] = apiKey
      } else {
        throw new Error('SendMail: No Authorization bearer token or x-api-key was provided')
      }

      const org = getSemantiusOrg(request)
      if (!org) {
        throw new Error('SendMail: could not determine organization slug from request')
      }
      const url = `https://${org}.semantius.cloud/api/email/send`

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })

      const responseText = await response.text()
      let data: any
      try {
        data = responseText ? JSON.parse(responseText) : null
      } catch {
        data = responseText
      }

      if (!response.ok) {
        const upstream =
          (data && typeof data === 'object' && (data.error || data.message)) ||
          (typeof data === 'string' && data) ||
          'no body'
        const authMode = bearer ? 'Bearer' : 'x-api-key'
        throw new Error(
          `SendMail: upstream ${response.status} (auth=${authMode}): ${upstream}`,
        )
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      }
    } catch (error: any) {
      const message = error?.message ?? 'Request failed'
      const prefixed = message.startsWith('SendMail') ? message : `SendMail: ${message}`
      return handleToolError({ message: prefixed })
    }
  },
}
