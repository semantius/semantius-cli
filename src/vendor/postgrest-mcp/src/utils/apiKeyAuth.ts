/**
 * API key to OAuth token exchange utility.
 *
 * When a request arrives with an `x-api-key` header instead of a Bearer token,
 * this exchanges the key for an access token via the client_credentials grant.
 */

export async function exchangeApiKeyForToken(orgSlug: string, apiKey: string): Promise<string> {
  const tokenUrl = `https://${orgSlug}.semantius.cloud/token`

  console.log(`[apiKeyAuth] Exchanging x-api-key for token via ${tokenUrl}`)

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-api-key': apiKey,
    },
    body: 'grant_type=client_credentials',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Token exchange failed (${response.status}): ${body}`)
  }

  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Token exchange response missing access_token')
  }

  return data.access_token as string
}
