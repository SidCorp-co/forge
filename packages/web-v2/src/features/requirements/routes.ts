export const requirementsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/requirements`;

export const requirementHref = (slug: string, key: string) =>
  `${requirementsHref(slug)}/${encodeURIComponent(key)}`;
