// ISS-804: the question a standing's basis puts reads a dependent's live blocker alike whichever
// step it is on, and keeps every other field: another blocker, a settled one, another wait.
//
// @direct-test-of packages/core/src/steward/standing-question.ts

import { type StandingBasisFields, standingBasisOf } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { questionOfBasis } from './standing-question.js';

const waitingOn = (who: string, actKey: string, over: Partial<StandingBasisFields> = {}) =>
  standingBasisOf({
    group: 'stuck',
    waitingKind: 'issue',
    who,
    actKey,
    ref: who,
    stuckCode: 'blocked',
    dueAt: null,
    carriedBy: null,
    ...over,
  });

const act = (name: string) => `issues.standing.act.${name}`;

describe('the question a standing puts (ISS-804)', () => {
  it('reads its live blocker alike whichever step it is on (the business rule)', () => {
    const open = questionOfBasis(waitingOn('ISS-4', act('notStarted')));
    for (const name of ['running', 'paused', 'needsPerson', 'cameBack']) {
      expect(questionOfBasis(waitingOn('ISS-4', act(name)))).toBe(open);
    }
    // a landed change waiting on its judge carries a due of its own class: still the same question
    const landed = waitingOn('ISS-4', act('landedWaitsJudge'), { dueAt: '2026-11-03T00:00:00Z' });
    expect(questionOfBasis(landed)).toBe(open);
  });

  it('is another question for another blocker, a design hold, or another wait (negative)', () => {
    const open = questionOfBasis(waitingOn('ISS-4', act('running')));
    expect(questionOfBasis(waitingOn('ISS-5', act('running')))).not.toBe(open);
    expect(questionOfBasis(waitingOn('ISS-4', act('designApproval')))).not.toBe(open);
    const master = standingBasisOf({
      group: 'queued',
      waitingKind: 'master',
      who: 'Master',
      actKey: 'standing.act.take',
      ref: null,
      stuckCode: null,
      dueAt: '2026-11-03T00:00:00Z',
      carriedBy: null,
    });
    expect(questionOfBasis(master)).toBe(master);
    expect(questionOfBasis(master)).not.toBe(open);
  });

  it('reads a basis that does not split into its fields strictly, and no basis as itself (edge)', () => {
    const odd = waitingOn('A|B', act('running'));
    expect(questionOfBasis(odd)).toBe(odd);
    expect(questionOfBasis(odd)).not.toBe(questionOfBasis(waitingOn('A|B', act('notStarted'))));
    expect(questionOfBasis('c1-1')).toBe('c1-1');
    expect(questionOfBasis('')).toBe('');
  });
});
