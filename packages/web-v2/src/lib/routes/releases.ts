export const releasesListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/releases`;

export const releaseHref = (slug: string, version: string) =>
  `${releasesListHref(slug)}/${encodeURIComponent(version)}`;

export const RELEASES_LIST = "releases";
