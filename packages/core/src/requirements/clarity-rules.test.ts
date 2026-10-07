// The agree waits for the business questions its head marks blocking, and only while they are open
// (REQUIREMENT_OPEN_QUESTIONS, JU-6): a question nobody marked blocking, or one already answered,
// holds nothing back, and the refusal names each question that does with who answers it.

import type { RequirementSpec } from '@forge/contracts/requirements';
import { describe, expect, it } from 'vitest';
import { openQuestionsRefusalOf } from './rules.js';

const spec: RequirementSpec = {
  goal: 'Referral managers see their own referrals',
  openQuestions: [
    {
      question: 'May a referral manager download the aggregate report?',
      whoAnswers: 'the clinic owner',
      blocking: true,
      questionId: 'q-blocking',
    },
    {
      question: 'Is the referrer feedback consent a new purpose?',
      whoAnswers: 'the DPO',
      blocking: false,
      questionId: 'q-soft',
    },
  ],
};

describe('what the agree waits for', () => {
  it('refuses while a blocking question is open, naming it and who answers it', () => {
    const refusal = openQuestionsRefusalOf(spec, new Set(['q-blocking', 'q-soft']), 3);
    expect(refusal).toMatchObject({
      code: 'REQUIREMENT_OPEN_QUESTIONS',
      path: '/spec/openQuestions',
    });
    expect(refusal?.detail).toContain('revision 3 leaves 1 blocking question open');
    expect(refusal?.detail).toContain('the aggregate report?" (answered by the clinic owner)');
    expect(refusal?.detail).not.toContain('referrer feedback');
  });

  it('lets the agree through once the blocking question is answered, though another stays open', () => {
    expect(openQuestionsRefusalOf(spec, new Set(['q-soft']), 3)).toBeNull();
  });

  it('holds nothing back for a spec with no open questions, or one asked as none yet', () => {
    expect(openQuestionsRefusalOf({ goal: 'x' }, new Set(), 1)).toBeNull();
    expect(openQuestionsRefusalOf(null, new Set(['q-blocking']), 1)).toBeNull();
    const unasked = {
      openQuestions: [{ question: 'Who pays?', whoAnswers: 'finance', blocking: true }],
    };
    expect(openQuestionsRefusalOf(unasked, new Set(['q-blocking']), 1)).toBeNull();
  });

  it('counts every blocking question still open', () => {
    const both: RequirementSpec = {
      openQuestions: (spec.openQuestions ?? []).map((q) => ({ ...q, blocking: true })),
    };
    expect(openQuestionsRefusalOf(both, new Set(['q-blocking', 'q-soft']), 2)?.detail).toContain(
      'leaves 2 blocking questions open',
    );
  });
});
