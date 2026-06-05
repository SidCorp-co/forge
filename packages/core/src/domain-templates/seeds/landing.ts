import type { BuiltinTemplate } from '../manifest.js';

// ISS-387 — `website` domain template: landing page. Single-page-focused shop-*
// pipeline; commerce OFF (a CTA may link to an external store).
export const landingTemplate: BuiltinTemplate = {
  key: 'landing',
  name: 'Landing Page',
  description: 'Epodsystem landing page — single-page theme, sections, CTA, draft→live publish.',
  manifest: {
    agentConfig: {
      name: 'Storefront Builder',
      type: 'website',
      description:
        'Builds and publishes an Epodsystem landing page: a focused single-page theme with hero, sections, and CTA.',
      enabled: true,
      focusAreas: ['landing', 'theme', 'sections', 'cta'],
      customInstructions:
        'This is a landing page (commerce disabled). Always build on the DRAFT theme; publishing promotes draft → main. Respect the shop-preflight guardrails: configurable values go in section settings (block settings do not reach Liquid), never createTheme, verify on the live/draft URL.',
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
