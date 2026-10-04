/**
 * The channel instance an external id belongs to, as a stable string: the
 * server's lowercased host and port, plus the base path it is served under,
 * with the scheme and any trailing slash dropped.
 */
export function namespaceFromServerUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    const host = url.host.toLowerCase();
    if (!host) return null;
    const base = url.pathname.replace(/\/+$/, '');
    return base ? `${host}${base}` : host;
  } catch {
    return null;
  }
}
