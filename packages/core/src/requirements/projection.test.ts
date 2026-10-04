import { describe, expect, it } from 'vitest';
import { requirementActAnswerOf } from './projection.js';
import type { RequirementDetail } from './read.js';

const detail = {
  id: 'r-1',
  key: 'REQ-1',
  title: 'Discharge',
  status: 'agreed',
  currentRevision: 2,
  latestRevision: { revision: 2, state: 'current' },
  updatedAt: '2026-10-04T00:00:00.000Z',
  revisions: [],
  baselines: [
    { revision: 2, seq: 2, act: 'repin', agreedAt: '2026-10-04T01:00:00.000Z', pins: [{}, {}] },
    { revision: 2, seq: 1, act: 'agree', agreedAt: '2026-10-03T01:00:00.000Z', pins: [{}] },
  ],
  issues: [],
  workflows: [],
} as unknown as RequirementDetail;

describe('requirementActAnswerOf: the acts ISS-85 and ISS-86 added', () => {
  it('a re-pin answers the latest baseline with its seq and pin count, and no revision', () => {
    const answer = requirementActAnswerOf(detail, 'repin');
    expect(answer.baseline).toEqual({
      revision: 2,
      seq: 2,
      agreedAt: '2026-10-04T01:00:00.000Z',
      pins: 2,
    });
    expect(answer.revision).toBeUndefined();
    expect(answer.requirement.key).toBe('REQ-1');
  });

  it('a defer and an undefer answer the requirement alone', () => {
    for (const act of ['defer', 'undefer'] as const) {
      const answer = requirementActAnswerOf(detail, act);
      expect(Object.keys(answer).sort()).toEqual(['act', 'requirement']);
    }
  });
});
