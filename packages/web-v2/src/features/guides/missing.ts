/** The words a reader gets when `/guides/<slug>` names no guide, in one place.
 *
 *  Two renderers use them, because no single one reaches every reader. The React
 *  `not-found.tsx` is what the router shows after a client-side navigation. The
 *  middleware renders the same words as an HTML document for a plain request,
 *  because `notFound()` raised in a dynamic route makes Next emit its bare error
 *  document and stream the not-found body as flight data — measured on the
 *  standalone server (ISS-1124), a reader without JavaScript got the 404 status
 *  and an empty <body>, which is the blank page this issue exists to refuse. */
export const INDEX_HREF = "/guides";

export function missingGuideHeading(slug: string): string {
  return slug
    ? `Forge publishes no guide called “${slug}”`
    : "Forge publishes no guide at that address";
}

export const MISSING_GUIDE_BODY =
  "The index lists every guide there is, and each one is also readable as markdown at /api/guides/<slug>.md with no credential.";

export const MISSING_GUIDE_LINK_TEXT = "All Forge guides";
