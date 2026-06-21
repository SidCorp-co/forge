// web-v2 feature module: docs. End-user help content is bundled at build time
// (help-content.generated.ts); the only shared type the viewer needs is the TOC.

/** One entry of the derived table of contents. */
export interface TocEntry {
  /** Heading depth (1–3). */
  level: number;
  text: string;
  /** Stable slug used to scroll-link the heading. */
  slug: string;
}
