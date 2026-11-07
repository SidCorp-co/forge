/**
 * ISS-1104: every pane on a box leases as one holder id (`forge-master-sid-xeon-1`), so a holder on
 * N issues read `shared` whichever pane held which. A lease may name its holder's session; where it
 * does, `shared` is judged per holder and session, and the readings name the session. A lease
 * without one reads as before, and one whose `session` is not a string of 1 to 100 characters is
 * malformed by name.
 *
 * @direct-test-of packages/core/src/issues/session-claim.ts
 * @direct-test-of packages/core/src/issues/lease-fanout.ts
 * @direct-test-of packages/core/src/issues/issue-worker.ts
 */

import { describe, expect, it } from 'vitest';
import { classifyIssueWorker } from './issue-worker.js';
import { readClaim } from './lease-fanout.js';
import { classifyLease } from './session-claim.js';
import { STRAND_RULES, strandReason } from './strand-rules.js';

const now = new Date('2026-11-07T10:00:00Z');
const HOLDER = 'forge-master-sid-xeon-1';

const lease = (over: Record<string, unknown> = {}) => ({
  holder: HOLDER,
  renewedAt: '2026-11-07T09:50:00Z',
  minutes: 60,
  ...over,
});

describe('a lease naming its session', () => {
  it('carries the session on its reading', () => {
    const read = classifyLease({ lease: lease({ session: 'pane-a' }), now, fanout: 1 });
    expect(read.verdict).toBe('live');
    expect(read.session).toBe('pane-a');
  });

  it('reads a lease without one as before, with no session', () => {
    const read = classifyLease({ lease: lease(), now, fanout: 1 });
    expect(read.verdict).toBe('live');
    expect(read.session).toBeNull();
  });

  for (const bad of [42, '', 'x'.repeat(101), null, { name: 'pane-a' }]) {
    it(`reads a session of ${JSON.stringify(bad)?.slice(0, 20)} as malformed, naming the field`, () => {
      const read = classifyLease({ lease: lease({ session: bad }), now, fanout: 1 });
      expect(read.verdict).toBe('malformed');
      expect(read.detail).toBe('session is not a string of 1 to 100 characters');
    });
  }

  it('takes a session of exactly 100 characters', () => {
    expect(
      classifyLease({ lease: lease({ session: 'x'.repeat(100) }), now, fanout: 1 }).verdict,
    ).toBe('live');
  });
});

describe('shared, judged per holder and session', () => {
  it('reads one pane of a box holder live where another pane of it holds a second issue', () => {
    // what `holderFanout` counts for two issues, one per pane, under one holder id
    const counted = new Map([
      [JSON.stringify([HOLDER, 'pane-a']), 1],
      [JSON.stringify([HOLDER, 'pane-b']), 1],
    ]);
    expect(readClaim(lease({ session: 'pane-a' }), now, counted).verdict).toBe('live');
  });

  it('reads one session holding several issues as shared, and names it', () => {
    const counted = new Map([[JSON.stringify([HOLDER, 'pane-a']), 3]]);
    const read = readClaim(lease({ session: 'pane-a' }), now, counted);
    expect(read.verdict).toBe('shared');
    const { reason } = strandReason({
      status: 'in_progress',
      rule: STRAND_RULES.in_progress,
      evidence: { merged: false, everRan: true, poolHasRunner: true, lease: read, judge: 'self' },
    });
    expect(reason).toContain('session `pane-a`');
    expect(reason).toContain('3 issues');
  });

  it('counts a lease without a session under its holder alone, as before', () => {
    const counted = new Map([[JSON.stringify([HOLDER, null]), 2]]);
    expect(readClaim(lease(), now, counted).verdict).toBe('shared');
  });
});

describe('pipelineHealth.worker names the session', () => {
  it('on a live claim', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: classifyLease({ lease: lease({ session: 'pane-a' }), now, fanout: 1 }),
    });
    expect(worker).toMatchObject({ lane: 'claim', holder: HOLDER, session: 'pane-a' });
  });

  it('in the detail of a claim that holds nothing', () => {
    const worker = classifyIssueWorker({
      sessions: [],
      claim: classifyLease({
        lease: lease({ session: 'pane-b', renewedAt: '2026-11-07T07:00:00Z' }),
        now,
        fanout: 1,
      }),
    });
    expect(worker.lane).toBe('none');
    expect(worker.lane === 'none' && worker.detail).toContain(`${HOLDER} session pane-b`);
  });
});
