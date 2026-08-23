// Absolute URLs against the core origin, for the places `fetch` is not involved:
// `<img src>`, `<video src>`, `<a href>`.
//
// Deliberately NOT in `lib/api/client.ts`. Nothing here fetches, throws
// ApiError or knows a route — it is a string function over one env value, and
// keeping it beside the client is what made the design kit import the API
// client to render a markdown image (arch `web-design-holds-no-api-client`).

// cm:edge contract -> packages/web-v2/src/lib/api/client.ts — `CORE_URL` is that module's origin too; it imports this one rather than re-deriving, so a change to the `/api` suffix rule cannot land on only one of them.
export const CORE_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/api\/?$/, "");

/**
 * Resolve a server-relative path (e.g. `/api/attachments/abc/download`) to an
 * absolute URL anchored at the core API origin. Pass-through for absolute URLs
 * and empty input. With the relative default `CORE_URL` is empty, so the path
 * is returned unchanged (already same-origin).
 */
export function coreFileUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${CORE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
