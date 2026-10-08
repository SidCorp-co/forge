import { describe, expect, it } from 'vitest';
import { analysePrompt, revisePrompt } from './prompt.js';

// An onboarding job's last act (posting the questionnaire, or marking done) ends the job and closes
// its session, so nothing the prompt leaves "for when you stop" ever runs: a worktree it says to
// remove then outlives the job. The prompt names the removal before that act.

const ctx = {
  projectId: 'p1',
  projectName: 'Shop',
  onboardingId: 'o1',
  conversationId: 'c1',
  sensitiveData: false,
  repository: 'github.com/acme/shop',
  defaultBranch: 'main',
  roundsSent: 0,
};

const BEFORE_LAST_ACT =
  'remove it before your last act (post_questionnaire or mark_done), which ends the job and closes this session';

describe('the onboarding prompt', () => {
  it.each([
    ['analyse', analysePrompt(ctx)],
    ['revise', revisePrompt({ ...ctx, batchId: 'b1' })],
  ])('%s: removes the landed-tree worktree before the act that closes the session', (_, prompt) => {
    expect(prompt).toContain(
      'git worktree add --detach .claude/worktrees/onboarding-o1 origin/main',
    );
    expect(prompt).toContain(BEFORE_LAST_ACT);
    expect(prompt).not.toContain('remove it when you stop');
  });

  it('names no worktree to remove where the project declares no repository', () => {
    const prompt = analysePrompt({ ...ctx, repository: null });
    expect(prompt).not.toContain('git worktree add');
    expect(prompt).not.toContain(BEFORE_LAST_ACT);
  });
});
