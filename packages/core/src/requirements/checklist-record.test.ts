// The ready and acceptance checklists as a requirement's record answers them (REQ-34 r2 BC-1,
// BC-18, BC-24; Requirement lifecycle r15 ready_check, acceptance_check): only a blocking gap stops
// the move, named on its question in plain words; a non-blocking one takes its recommended answer.

import {
  REQUIREMENT_ACCEPTANCE_CHECKLIST,
  REQUIREMENT_READY_CHECKLIST,
} from '@forge/contracts/checklist-registry';
import { checklistRefusals, evaluateChecklist } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import {
  acceptanceAnswersOf,
  goalAnswers,
  type ReadyFacts,
  readyAnswersOf,
} from './checklist-record.js';

const ready: ReadyFacts = {
  key: 'REQ-7',
  head: 2,
  spec: {
    goal: 'Problem: referrals are lost.\nValue: every referral reaches a clinician.\nMeasured by: lost referrals per month.\nRoadmap: now.',
    personas: ['Referral manager'],
    scopeOut: ['Billing'],
    openQuestions: [],
  },
  kind: 'process',
  criteria: ['BC-1', 'BC-2'],
  openBlocking: [],
  designs: [{ flow: 'referral-intake', approvedRevision: 3 }],
};

const judge = (facts: ReadyFacts) =>
  evaluateChecklist(REQUIREMENT_READY_CHECKLIST, { given: {}, record: readyAnswersOf(facts) });

describe('the ready checklist, read from the head revision', () => {
  it('is complete for a head that answers every required question', () => {
    const e = judge(ready);
    expect(e.complete).toBe(true);
    expect(e.answers.find((a) => a.question === 'roadmap')).toMatchObject({
      value: 'now.',
      provenance: 'given',
    });
  });

  it('stops on each blocking gap, naming its question on its path in plain words', () => {
    const e = judge({
      ...ready,
      spec: { goal: 'Problem: referrals are lost.', personas: [] },
      criteria: [],
      designs: [],
      openBlocking: [{ question: 'Who signs the referral?', whoAnswers: 'the clinic owner' }],
    });
    const refusals = checklistRefusals(e);
    expect(refusals.map((r) => r.path)).toEqual([
      '/answers/who',
      '/answers/value',
      '/answers/measured',
      '/answers/criteria',
      '/answers/questions',
      '/answers/workflows',
    ]);
    expect(refusals.every((r) => r.code === 'CHECKLIST_INCOMPLETE')).toBe(true);
    expect(refusals.find((r) => r.question === 'questions')?.detail).toContain(
      '"Who signs the referral?" (answered by the clinic owner)',
    );
    expect(refusals.find((r) => r.question === 'value')?.detail).toContain('after "Value:"');
  });

  it('takes the recommended answer for kind, out of scope and roadmap, recorded as assumed', () => {
    const e = judge({
      ...ready,
      kind: null,
      spec: { ...ready.spec, goal: 'Problem: a.\nValue: b.\nMeasured by: c.', scopeOut: [] },
    });
    expect(e.complete).toBe(true);
    const assumed = e.answers.filter((a) => a.provenance === 'assumed').map((a) => a.question);
    expect(assumed).toEqual(['kind', 'outOfScope', 'roadmap']);
  });

  it('reads a goal that labels nothing as its problem alone', () => {
    expect(goalAnswers('Referral managers see their own referrals')).toEqual({
      problem: 'Referral managers see their own referrals',
    });
    expect(goalAnswers('Value: x\nsomething else')).toEqual({ value: 'x' });
    expect(goalAnswers('   ')).toEqual({});
  });

  it('names every question a requirement with no current revision leaves open', () => {
    const e = judge({ ...ready, head: null });
    expect(e.complete).toBe(false);
    expect(e.gaps.every((g) => g.detail.includes('REQ-7 has no current revision yet.'))).toBe(true);
  });
});

describe('the acceptance checklist, read from the delivery', () => {
  const accept = (...args: Parameters<typeof acceptanceAnswersOf>) =>
    evaluateChecklist(REQUIREMENT_ACCEPTANCE_CHECKLIST, {
      given: {},
      record: acceptanceAnswersOf(...args),
    });

  it('is complete when every issue shipped, every BC passes and each verdict cites evidence', () => {
    expect(accept({ liveIssues: 2, unshipped: [], unproven: [] }, []).complete).toBe(true);
  });

  it('names an unshipped issue, an unproven BC with its reason, and an uncited verdict', () => {
    const e = accept(
      {
        liveIssues: 2,
        unshipped: ['ISS-9'],
        unproven: [
          { code: 'BC-2', verdict: 'not_judged', why: 'the live build could not be read' },
          { code: 'BC-4', verdict: 'gap', why: null },
        ],
      },
      [{ issue: 'ISS-3', criterion: 1 }],
    );
    const by = Object.fromEntries(checklistRefusals(e).map((r) => [r.question, r.detail]));
    expect(by.shipped).toContain('ISS-9 has not shipped.');
    expect(by.verdicts).toContain(
      'BC-2 (not judged: the live build could not be read); BC-4 (gap)',
    );
    expect(by.evidence).toContain('ISS-3 criterion 1');
  });

  it('refuses a requirement no live issue delivers', () => {
    const e = accept({ liveIssues: 0, unshipped: [], unproven: [] }, []);
    expect(checklistRefusals(e).map((r) => r.question)).toEqual(['shipped']);
  });
});
