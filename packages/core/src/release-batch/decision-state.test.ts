import { describe, expect, it } from 'vitest';
import { DECISION_KEY, DecisionRefUnreadable, readDecisionRef } from './decision-state.js';

const JOB = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const ref = {
  v: 1,
  sourceJobId: JOB,
  questionIds: [Q],
  issueId: null,
  since: '2026-10-09T00:00:00.000Z',
};

describe('the reference a held job keeps to its decision', () => {
  it('is absent on a job that waits on none', () => {
    expect(readDecisionRef(JOB, {})).toBeNull();
    expect(readDecisionRef(JOB, null)).toBeNull();
  });

  it('reads the version it writes', () => {
    expect(readDecisionRef(JOB, { [DECISION_KEY]: ref })).toEqual(ref);
  });

  it('is refused by name where the key is there and the shape is not', () => {
    for (const bad of [
      { ...ref, v: 2 },
      { ...ref, questionIds: [] },
      { ...ref, sourceJobId: 'x' },
      7,
    ]) {
      expect(() => readDecisionRef(JOB, { [DECISION_KEY]: bad })).toThrow(DecisionRefUnreadable);
    }
    expect(() => readDecisionRef(JOB, { [DECISION_KEY]: { ...ref, v: 2 } })).toThrow(
      /DECISION_REF_UNREADABLE: job 11111111/,
    );
  });
});
