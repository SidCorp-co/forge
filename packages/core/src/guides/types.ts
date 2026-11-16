import type { GuideSlug } from './guide-ref.js';

const CORE_GUIDE_AUDIENCES = ['agent'] as const;
type CoreGuideAudience = (typeof CORE_GUIDE_AUDIENCES)[number];

export interface ForgeGuide {
  slug: string;
  audience: CoreGuideAudience;
  title: string;
  summary: string;
  version: number;
  /** Markdown body, NT1 altitude. */
  body: string;
  /**
   * The doors the guide's method acts through (ISS-1251): their cards are rendered under the body when
   * the guide is served, so the guide keeps the method and the card is the one copy of each door.
   */
  doors?: readonly string[];
}

export type CoreGuide = ForgeGuide & { slug: GuideSlug };
