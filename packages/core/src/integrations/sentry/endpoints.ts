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

export function sentryIssueUrl(host: string, organizationSlug: string, issueId: string): string {
  return `${sentryRestBase(host)}/api/0/organizations/${encodeURIComponent(organizationSlug)}/issues/${encodeURIComponent(issueId)}/`;
}

export function sentryOrgIssuesUrl(
  host: string,
  organizationSlug: string,
  params: { query: string; limit: number; cursor?: string },
): string {
  const search = new URLSearchParams({ query: params.query, limit: String(params.limit) });
  if (params.cursor) search.set('cursor', params.cursor);
  return `${sentryRestBase(host)}/api/0/organizations/${encodeURIComponent(organizationSlug)}/issues/?${search.toString()}`;
}
