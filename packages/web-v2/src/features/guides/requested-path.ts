// The middleware, the 404 and the fetcher read this file: docs/modules/guides/public-pages.md.
export const GUIDE_PATH_HEADER = "x-forge-guide-path";

export const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The slug exactly as the page's own route param will see it, so the two never
 *  disagree about what was asked for: no trimming, and a suffix that will not
 *  decode is kept raw for GUIDE_SLUG to refuse rather than thrown over. */
export function slugFromGuidePath(path: string | null | undefined): string {
  if (!path) return "";
  const rest = /^\/guides\/(.*)$/.exec(path.split("?")[0])?.[1] ?? "";
  const bare = rest.replace(/\/+$/, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}
