/** The readers a guide core serves may be written for. Both of core's homes, the registry and the
 *  per-org integration guides, admit agents alone: docs/modules/guides/where-a-page-lives.md. */
export const CORE_GUIDE_AUDIENCES = ['agent'] as const;
export type CoreGuideAudience = (typeof CORE_GUIDE_AUDIENCES)[number];

export interface ForgeGuide {
  slug: string;
  audience: CoreGuideAudience;
  title: string;
  summary: string;
  version: number;
  /** Markdown body, NT1 altitude. */
  body: string;
}
