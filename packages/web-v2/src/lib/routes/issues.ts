export const issuesHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/issues`;

export const issueHref = (slug: string, key: string) => `${issuesHref(slug)}/${encodeURIComponent(key)}`;

/** A requirement's issue: under the requirement's project by key, or a sibling project's by its own uuid. */
export const linkedIssueHref = (slug: string, i: { issueId: string; displayId: string; otherProject: { slug: string } | null }) =>
  i.otherProject ? issueHref(i.otherProject.slug, i.issueId) : issueHref(slug, i.displayId);

export const ISSUES_LIST = "issues";
