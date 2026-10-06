import { startRequestSchema } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { hintOf } from './hint.js';
import { analysePrompt, type OnboardingPromptContext, revisePrompt } from './prompt.js';

const ctx: OnboardingPromptContext = {
  projectId: 'p1',
  projectName: 'Catalog API',
  onboardingId: 'o1',
  conversationId: 'c1',
  sensitiveData: false,
  repository: 'git@example.com:catalog-api.git',
  defaultBranch: 'main',
  roundsSent: 0,
};

describe('the owner asks for designs, and what they ask reaches the job that draws them', () => {
  it('the start link names what it does: it asks for designs', () => {
    expect(hintOf(null, 'none')?.actionLabel).toBe('Ask for designs');
  });

  it('a start carries the request text, and refuses a blank one by name', () => {
    expect(startRequestSchema.parse({ request: '  Draw against REQ-1  ' })).toEqual({
      request: 'Draw against REQ-1',
    });
    expect(startRequestSchema.safeParse({}).success).toBe(true);
    expect(startRequestSchema.safeParse({ request: '   ' }).success).toBe(false);
    expect(startRequestSchema.safeParse({ prompt: 'x' }).success).toBe(false);
  });

  it("the analysis brief carries the request and tells the job to read the thread's requests", () => {
    const brief = analysePrompt({
      ...ctx,
      request: 'Draw against REQ-1; leave every design proposed.',
    });
    expect(brief).toContain('Draw against REQ-1; leave every design proposed.');
    expect(brief).toContain('`requests`');
    expect(brief).toMatch(/again before you post the questionnaire/);
  });

  it('a revise job reads the thread too, so a message posted after the start is not lost', () => {
    expect(revisePrompt({ ...ctx, batchId: 'b1' })).toContain('`requests`');
  });
});
