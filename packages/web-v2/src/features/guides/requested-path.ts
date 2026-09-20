/** The header the middleware puts the requested `/guides/...` path on.
 *
 *  Next hands a `not-found.tsx` no params and no way to read the URL: `headers()`
 *  there carries only what the client sent, and a client `not-found` using
 *  `usePathname` is not server-rendered at all — measured on the standalone
 *  server (ISS-1124), it emitted an empty error document. So the 404 that names
 *  the slug a reader actually asked for gets that name from the one place that
 *  still sees the request. */
export const GUIDE_PATH_HEADER = "x-forge-guide-path";

/** The slug from a requested guide path, or `""` when the header is absent. */
export function slugFromGuidePath(path: string | null | undefined): string {
  if (!path) return "";
  const rest = /^\/guides\/(.*)$/.exec(path.split("?")[0])?.[1] ?? "";
  return decodeURIComponent(rest.replace(/\/+$/, "")).trim();
}

/** Slugs are registry keys, not paths and not filenames. This is the ONE test of
 *  that: the middleware and the page fetcher both read it, because two tests
 *  that disagree is a slug one of them refuses and the other passes — measured
 *  on `/guides/what-is-an-issue.md`, which core answers 200 for (it strips the
 *  suffix) while the page rejects it, so the refusal fell back to the blank
 *  body the middleware exists to prevent. */
export function isGuideSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
