import { describe, expect, it } from 'vitest';
import { analysePrompt, type OnboardingPromptContext, revisePrompt } from './prompt.js';

const ctx: OnboardingPromptContext = {
  projectId: 'p1',
  projectName: 'HOP',
  onboardingId: 'o1',
  conversationId: 'c1',
  sensitiveData: true,
  hasRepository: false,
  roundsSent: 0,
};

const PRODUCT_ONLY =
  'Never draw Forge, its agents, its LLM, or the development pipeline as part of the product.';
const POLICY_IS_A_SETTING =
  'If it is also a product rule, write it as a requirement or a design note, never as a node.';
const SUMMARY_SHOWS = 'A summary states what the design shows, not how it was drawn';

describe('onboarding prompt: draws the product, not the tooling that builds it', () => {
  for (const [name, text] of [
    ['analyse', analysePrompt(ctx)],
    ['revise', revisePrompt({ ...ctx, batchId: 'b1' })],
  ] as const) {
    it(`${name} keeps Forge, its agents and its LLM out of the product's designs`, () => {
      expect(text).toContain(PRODUCT_ONLY);
      expect(text).toContain(POLICY_IS_A_SETTING);
    });

    it(`${name} says a summary states what the design shows, not its provenance`, () => {
      expect(text).toContain(SUMMARY_SHOWS);
    });
  }

  it("a sensitive project's data flow draws the product's own trust boundaries", () => {
    expect(analysePrompt(ctx)).toContain("draw the product's own trust boundaries");
    expect(analysePrompt({ ...ctx, sensitiveData: false })).toContain(
      "with the product's own trust boundaries",
    );
  });
});
