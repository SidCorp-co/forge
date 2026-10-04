import type { GuideSlug } from './guide-ref.js';

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

export type CoreGuide = ForgeGuide & { slug: GuideSlug };
