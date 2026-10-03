export const requirementsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/requirements`;

export const requirementHref = (slug: string, key: string) =>
  `${requirementsHref(slug)}/${encodeURIComponent(key)}`;

/** The list's name for the shared list-origin memory (design `detail-header.tsx`). */
export const REQUIREMENTS_LIST = "requirements";
