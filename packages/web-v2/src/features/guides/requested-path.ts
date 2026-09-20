// The middleware, the 404 and the fetcher read this file: docs/modules/guides/public-pages.md.
export const GUIDE_PATH_HEADER = "x-forge-guide-path";

export const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugFromGuidePath(path: string | null | undefined): string {
  if (!path) return "";
  const rest = /^\/guides\/(.*)$/.exec(path.split("?")[0])?.[1] ?? "";
  return decodeURIComponent(rest.replace(/\/+$/, "")).trim();
}
