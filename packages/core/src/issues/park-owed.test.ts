// @direct-test-of packages/core/src/issues/park-owed.ts
import { describe, expect, it } from 'vitest';
import { issuesNamedBy, parkOwedBy } from './park-owed.js';

const base = { awaitsMerge: false, prefixes: ['ISS', 'EPOD'], ownSeq: 63, shipped: new Set<number>() };

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

  it('a shipped issue named in what would settle it is a reference: a person still owes the act (ISS-1292)', () => {
    const needs = 'Upgrade forge-runner to a build at or after ISS-1259 (89e77c22)';
    const shipped = new Set([1259]);
    for (const waitingKind of ['needs_decision', 'needs_answer'] as const) {
      const owed = parkOwedBy({ ...base, waitingKind, needs, shipped });
      expect(owed.blockerKind).toBe('human');
      expect(owed.because).toContain('a person owes');
      expect(owed.because).toContain('ISS-1259');
    }
    // one shipped and one not: the one not landed is still the master's to follow
    const mixed = parkOwedBy({
      ...base,
      waitingKind: 'needs_decision',
      needs: 'ISS-1259 shipped and EPOD-70 landed',
      shipped,
    });
    expect(mixed).toEqual({
      blockerKind: 'master_or_peer',
      because: "it waits on EPOD-70, another issue's delivery not yet landed, which the master follows",
    });
  });

  it('an open issue named in a decision park is still a wait the master follows', () => {
    const owed = parkOwedBy({ ...base, waitingKind: 'needs_decision', needs: 'ISS-1259 landed' });
    expect(owed.blockerKind).toBe('master_or_peer');
    expect(owed.because).toContain('ISS-1259');
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
      expect(parkOwedBy({ ...base, waitingKind: 'needs_decision', needs })).toEqual({
        blockerKind: 'human',
        because: 'it waits on a decision a person owes',
      });
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
