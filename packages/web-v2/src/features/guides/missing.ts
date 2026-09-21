// The words for an unknown guide, said by two renderers: docs/modules/guides/public-pages.md.
export const INDEX_HREF = "/guides";

export function missingGuideHeading(slug: string): string {
  return slug
    ? `Forge publishes no guide called “${slug}”`
    : "Forge publishes no guide at that address";
}

export const MISSING_GUIDE_BODY =
  "The index lists every guide there is, and each one is also readable as markdown at /api/guides/<slug>.md with no credential.";

export const MISSING_GUIDE_LINK_TEXT = "All Forge guides";
