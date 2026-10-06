export const feedbackListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/feedback`;

export const feedbackHref = (slug: string, key: string) =>
  `${feedbackListHref(slug)}/${encodeURIComponent(key)}`;

export const FEEDBACK_LIST = "feedback";
