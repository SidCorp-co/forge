// v1 feature module: docs. Mirrors the web-v2 docs feature; types verified
// against `packages/core/src/docs/routes.ts` (ISS-305).

export interface DocNode {
  /** Repo-relative POSIX path, e.g. `docs/guide/setup.md`. */
  path: string;
  name: string;
  type: 'file' | 'dir';
  children?: DocNode[];
}

export interface DocsTree {
  items: DocNode[];
  truncated: boolean;
}

export interface DocContent {
  path: string;
  content: string;
}

/** One entry of the derived table of contents. */
export interface TocEntry {
  /** Heading depth (1–3). */
  level: number;
  text: string;
  /** Stable slug used to scroll-link the heading. */
  slug: string;
}
