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

/**
 * One Sentry issue, under its organization.
 *
 * The organization-scoped form is Sentry's current one; the bare `/api/0/issues/<id>/` it replaced
 * is deprecated. Scoping by org is also what makes the binding's labelled target load-bearing
 * rather than decorative: the caller has to say WHICH declared target it means before core will
 * touch an issue (ISS-1085).
 */
export function sentryIssueUrl(host: string, organizationSlug: string, issueId: string): string {
  return `${sentryRestBase(host)}/api/0/organizations/${encodeURIComponent(organizationSlug)}/issues/${encodeURIComponent(issueId)}/`;
}

/**
 * The organization's issue list, under the same org scoping one issue is addressed by.
 *
 * `query` is Sentry's own search syntax and is the SERVER-side half of the confinement — a target
 * declaring a project slug puts `project:<slug>` in it. It is never the whole of the confinement:
 * what Sentry answers is checked against the target again in `issues.ts`, because a filter that is
 * only ever asked for is a filter nobody has verified (ISS-1085 slice 3).
 */
export function sentryOrgIssuesUrl(
  host: string,
  organizationSlug: string,
  params: { query: string; limit: number },
): string {
  const search = new URLSearchParams({ query: params.query, limit: String(params.limit) });
  return `${sentryRestBase(host)}/api/0/organizations/${encodeURIComponent(organizationSlug)}/issues/?${search.toString()}`;
}
