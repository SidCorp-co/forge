// An automatic cut acts for the project's owner, who pressed nothing: neither its cut nor the
// approval it asks may read as that person's act (ISS-1153). A person's own cut still names them.

import { describe, expect, it } from 'vitest';
import type { ApprovalView } from './approvals.js';
import type { ReleaseCutter } from './release-facts.js';
import { releaseOwnerOf } from './release-owner.js';

const ada = { id: 'u-ada', name: 'Ada', kind: 'human' as const };
const asked: ApprovalView = {
  id: 'a1',
  runId: 'r1',
  requestedBy: ada,
  requestedAt: '2026-11-08T00:00:00.000Z',
  evidence: { environment: null, commit: 'abc', reading: 'abc' },
  note: null,
  decision: null,
  decidedBy: null,
  decidedAt: null,
  reason: null,
  carried: [],
};
const cutBy = (as: 'automatic' | 'person') =>
  new Map<string, ReleaseCutter>([['r1', as === 'automatic' ? { as } : { as, person: ada }]]);

describe('who a release reads as owed to (ISS-1153)', () => {
  it('names no person for a cut Forge made, nor for the approval it asked', () => {
    expect(releaseOwnerOf([], 'r1', cutBy('automatic'))).toEqual({
      owner: null,
      act: 'Cut automatically',
    });
    expect(releaseOwnerOf([asked], 'r1', cutBy('automatic'))).toEqual({
      owner: null,
      act: 'Asked for approval automatically',
    });
  });

  it('names the person who cut, and who asked, when a person did', () => {
    expect(releaseOwnerOf([], 'r1', cutBy('person'))).toEqual({ owner: ada, act: 'Cut' });
    expect(releaseOwnerOf([asked], 'r1', cutBy('person'))).toEqual({
      owner: ada,
      act: 'Asked for approval',
    });
  });

  it('names whoever decided the approval, whoever cut', () => {
    const decided = { ...asked, decision: 'approved' as const, decidedBy: ada };
    expect(releaseOwnerOf([decided], 'r1', cutBy('automatic'))).toEqual({
      owner: ada,
      act: 'Approved',
    });
  });

  it('reads an uncut draft as owed to nobody yet', () => {
    expect(releaseOwnerOf([], null, new Map())).toEqual({ owner: null, act: null });
  });
});
