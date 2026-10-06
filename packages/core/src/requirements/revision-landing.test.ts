import { describe, expect, it } from 'vitest';
import { newRevisionRow } from './revision-write.js';

const at = new Date('2026-10-06T12:00:00Z');
const base = {
  requirementId: 'r1',
  revision: 2,
  head: 1,
  authorId: 'agent-1',
  write: { reason: 'FB-1', criteria: [] },
  at,
};

describe('a new revision lands where its writer says', () => {
  it('is written proposed, by the accepting person, from a revision_diff accept', () => {
    const row = newRevisionRow({ ...base, landing: { state: 'proposed', proposedBy: 'ba-1' } });
    expect(row).toMatchObject({
      state: 'proposed',
      proposedBy: 'ba-1',
      proposedAt: at,
      authorId: 'agent-1',
    });
  });

  it('is a draft with no propose from a direct write', () => {
    const row = newRevisionRow({ ...base, landing: { state: 'draft' } });
    expect(row).toMatchObject({ state: 'draft', proposedBy: null, proposedAt: null });
  });
});
