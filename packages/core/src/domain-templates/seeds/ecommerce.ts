import type { BuiltinTemplate } from '../manifest.js';

// ISS-387 — `website` domain template: ecommerce storefront. Wires the shop-*
// pipeline so a website-kind project drives brief → design-spec → customize
// (draft) → verify (draft) → publish (draft→main). Commerce intent lives in
// agentConfig (the manifest schema is strict — no free-form commerce flag).
export const ecommerceTemplate: BuiltinTemplate = {
  key: 'ecommerce',
  name: 'Ecommerce Storefront',
  description: 'Epodsystem ecommerce store — products, collections, theme, draft→live publish.',
  manifest: {
    agentConfig: {
      name: 'Storefront Builder',
      type: 'website',
      description:
        'Builds and publishes an Epodsystem ecommerce storefront: theme sections, product grids, collections, and navigation.',
      enabled: true,
      focusAreas: ['ecommerce', 'theme', 'products', 'collections', 'menus', 'commerce'],
      customInstructions:
        'This is an ecommerce store (commerce enabled). Always build on the DRAFT theme; publishing promotes draft → main. Respect the shop-preflight guardrails (EAV grid images + reindex, handle + featured_image on cards, conditions_serialized for smart collections, never createTheme). Verify on the live/draft URL, never screenshot_preview on theme main.',
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
