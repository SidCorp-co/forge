// The shape every capability guide has, in a module that imports nothing.
//
// It lives apart from registry.ts because the tiers registry.ts aggregates need
// this type too, and importing it back from the aggregator made each tier a
// cycle in the resolved graph.

export interface ForgeGuide {
  /** Stable, URL-safe id: kebab-case, `/^[a-z0-9][a-z0-9-]*$/`. */
  slug: string;
  title: string;
  /** ONE line — this is all the always-on index shows. */
  summary: string;
  version: number;
  /** Markdown body, NT1 altitude. */
  body: string;
}
