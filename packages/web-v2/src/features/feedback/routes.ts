export const feedbackListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/feedback`;

export const feedbackHref = (slug: string, key: string) =>
  `${feedbackListHref(slug)}/${encodeURIComponent(key)}`;

/** The list's name for the shared list-origin memory (design `detail-header.tsx`). */
export const FEEDBACK_LIST = "feedback";
