/**
 * Media URL shape validation.
 *
 * Bncr treats internal and public destinations identically: the connected
 * Bncr client is trusted, so no destination (SSRF) restriction is applied.
 * This guard only enforces basic URL shape so the fetch layer receives a
 * well-formed http(s) URL: scheme must be http/https, no embedded credentials,
 * and a host must be present.
 *
 * Reachability is verified separately by the callers (marker reachability
 * probe, MIME probe, download), never by this shape check.
 */
export async function assertFetchableMediaUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('media url is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`media url scheme is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('media url must not embed credentials');
  }
  if (!parsed.hostname) {
    throw new Error('media url is missing a host');
  }
}
