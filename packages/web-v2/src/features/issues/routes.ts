export const issuesHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/issues`;

export const issueHref = (slug: string, key: string) => `${issuesHref(slug)}/${encodeURIComponent(key)}`;

export const ISSUES_LIST = "issues";
