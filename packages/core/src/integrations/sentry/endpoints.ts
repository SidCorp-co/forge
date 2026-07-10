/**
 * Sentry host normalization. The operator may paste a bare host
 * (`logs.canawan.com`) or a full URL; we strip any scheme + trailing slash so
 * both the REST probe base and the MCP `SENTRY_HOST` env are well-formed.
 */
export function sentryHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/** REST API base used for the test-connection probe. Always https. */
export function sentryRestBase(host: string): string {
  return `https://${sentryHost(host)}`;
}
