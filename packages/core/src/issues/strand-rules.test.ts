/**
 * A takeable row the admissible list withholds waits on what withholds it, never on a dispatch:
 * a row a live run's scope holds waits on that run (REQ-36 BC-5, ISS-468).
 *
 * @direct-test-of packages/core/src/issues/strand-rules.ts
 */

import { describe, expect, it } from 'vitest';
import { landedWait, STRAND_RULES, strandReason, withheldWait } from './strand-rules.js';

const none = { blockers: [], design: false, contract: false, pattern: false, scope: false };

describe('withheldWait', () => {
  it('names the holding run, owed by the blocker, for a row a live run scope holds', () => {
    const wait = withheldWait('open', { ...none, scope: true });
    expect(wait?.owes).toBe('blocker');
    expect(wait?.waitingFor).toContain('live run');
    expect(wait?.reason).toContain('not on a dispatch');
  });

  it('says nothing for a row nothing withholds, or one no longer takeable', () => {
    expect(withheldWait('open', none)).toBeNull();
    expect(withheldWait('in_progress', { ...none, scope: true })).toBeNull();
  });
});

describe('landedWait on a reopen whose merge is recorded since that reopen', () => {
  const lease = { verdict: 'none' as const, holder: null, expiresAt: null, fanout: 0 };

  for (const judge of ['self', 'builder'] as const) {
    it(`reads a fix round that landed: the master's to move on (${judge})`, () => {
      const evidence = { merged: true, mergedSinceReopen: true, judge };
      const wait = landedWait('reopen', evidence);
      expect(wait?.waitingFor).toBe('the master to move it on to awaiting_release');
      expect(wait?.on).toBe('master');
      const { reason } = strandReason({
        status: 'reopen',
        rule: STRAND_RULES.reopen,
        evidence: { ...evidence, everRan: true, poolHasRunner: true, lease } as Parameters<
          typeof strandReason
        >[0]['evidence'],
      });
      expect(reason).toContain('awaiting_release');
    });
  }

  it('reads a mark from before the reopen as a fix round still owed', () => {
    expect(landedWait('reopen', { merged: true, mergedSinceReopen: false, judge: 'self' })).toBeNull();
    expect(landedWait('reopen', { merged: true, judge: 'self' })).toBeNull();
  });
});
