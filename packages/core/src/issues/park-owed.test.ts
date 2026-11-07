// @direct-test-of packages/core/src/issues/park-owed.ts
import { describe, expect, it } from 'vitest';
import { issuesNamedBy, parkOwedBy } from './park-owed.js';

const base = { awaitsMerge: false, prefixes: ['ISS', 'EPOD'], ownSeq: 63 };

describe('who owes the question a park mints (ISS-1127)', () => {
  it('a resource is the master’s, whatever its words', () => {
    expect(
      parkOwedBy({ ...base, waitingKind: 'needs_resource', needs: 'forge ISS-1125 deployed' }),
    ).toMatchObject({ blockerKind: 'master_or_peer' });
    expect(
      parkOwedBy({ ...base, waitingKind: 'needs_resource', needs: 'a GitLab token' }).blockerKind,
    ).toBe('master_or_peer');
  });

  it('another issue named in what would settle it is the master’s, naming it', () => {
    const owed = parkOwedBy({ ...base, waitingKind: 'needs_answer', needs: 'EPOD-70 landed' });
    expect(owed.blockerKind).toBe('master_or_peer');
    expect(owed.because).toContain('EPOD-70');
  });

  it('its own merge mark answers it', () => {
    expect(
      parkOwedBy({ ...base, awaitsMerge: true, waitingKind: 'needs_answer' }).blockerKind,
    ).toBe('machine');
  });

  it('an answer or a decision a person owes stays theirs, its own key included', () => {
    for (const needs of [
      undefined,
      '',
      'the group ISS-63 mirrors',
      'which of REQ-12 or FB-30 first',
    ])
      expect(parkOwedBy({ ...base, waitingKind: 'needs_decision', needs }).blockerKind).toBe(
        'human',
      );
  });
});

describe('the issue keys a park’s words name', () => {
  it('reads only its project’s prefixes, never a requirement, a feedback or a criterion', () => {
    expect(
      issuesNamedBy('ISS-1125, EPOD-7, REQ-12, FB-3, BC-1, XISS-4, ISS-063', base.prefixes, 63),
    ).toEqual(['ISS-1125', 'EPOD-7']);
  });

  it('names each once, and nothing with no prefix', () => {
    expect(issuesNamedBy('ISS-9 then ISS-9', base.prefixes, 1)).toEqual(['ISS-9']);
    expect(issuesNamedBy('ISS-9', [], 1)).toEqual([]);
  });
});
