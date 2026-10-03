export const issuesHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/issues`;

/** An issue's full page by its key (ISS-12): where a list row, a rail chip or a route points. */
export const issueHref = (slug: string, key: string) => `${issuesHref(slug)}/${encodeURIComponent(key)}`;

/** The list's name for the shared list-origin memory (design `detail-header.tsx`). */
export const ISSUES_LIST = "issues";
