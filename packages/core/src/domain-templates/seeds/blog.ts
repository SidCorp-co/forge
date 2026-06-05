import type { BuiltinTemplate } from '../manifest.js';

// ISS-387 — `website` domain template: blog. Same shop-* pipeline as ecommerce
// but content/theme-focused (no product catalog). Commerce is OFF.
export const blogTemplate: BuiltinTemplate = {
  key: 'blog',
  name: 'Blog Site',
  description: 'Epodsystem blog/content site — theme, pages, navigation, draft→live publish.',
  manifest: {
    agentConfig: {
      name: 'Storefront Builder',
      type: 'website',
      description:
        'Builds and publishes an Epodsystem blog/content site: theme sections, pages, and navigation. No product catalog.',
      enabled: true,
      focusAreas: ['blog', 'content', 'theme', 'menus'],
      customInstructions:
        'This is a content/blog site (commerce disabled — skip product/collection steps). Always build on the DRAFT theme; publishing promotes draft → main. Respect the shop-preflight guardrails: section settings not block settings, never createTheme, re-query menus after edits, verify on the live/draft URL.',
    },
    skillRegistrations: [
      { skillName: 'shop-brief', stage: 'open' },
      { skillName: 'shop-design-spec', stage: 'confirmed' },
      { skillName: 'shop-customize-draft', stage: 'approved' },
      { skillName: 'shop-verify-draft', stage: 'testing' },
      { skillName: 'shop-publish', stage: 'released' },
      { skillName: 'shop-customize-draft', stage: 'reopen' },
    ],
  },
};
