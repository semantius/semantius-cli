/**
 * Derives the Semantius organization slug from the inbound request URL.
 * The slug is the first hostname segment (e.g. "acme" in "acme.semantius.cloud").
 */
export function getSemantiusOrg(request?: { url?: string }): string | null {
  if (!request?.url) return null
  return new URL(request.url).hostname.split('.')[0] || null
}
