export const requirementsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/requirements`;

export const requirementHref = (slug: string, key: string) =>
  `${requirementsHref(slug)}/${encodeURIComponent(key)}`;

const LIST_ORIGIN_KEY = "web-v2:requirements-list-origin";

export function rememberListOrigin() {
  try {
    sessionStorage.setItem(LIST_ORIGIN_KEY, `${window.location.pathname}${window.location.search}`);
  } catch {}
}

/** Where "← Requirements" goes: the list view this page was opened from, else the plain list. */
export function listOrigin(slug: string): string {
  const plain = requirementsHref(slug);
  try {
    const saved = sessionStorage.getItem(LIST_ORIGIN_KEY);
    return saved?.startsWith(plain) ? saved : plain;
  } catch {
    return plain;
  }
}
