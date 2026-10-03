export const feedbackListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/feedback`;

export const feedbackHref = (slug: string, key: string) =>
  `${feedbackListHref(slug)}/${encodeURIComponent(key)}`;

/** An issue's page by its key (ISS-12), where a route or a target points. */
export const issueHref = (slug: string, key: string) =>
  `/projects/${encodeURIComponent(slug)}/issues/${encodeURIComponent(key)}`;
