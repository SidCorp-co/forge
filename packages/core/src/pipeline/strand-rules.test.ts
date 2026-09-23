import { describe, expect, it } from 'vitest';
import { type IssueStatus, issueStatuses } from '../db/schema.js';
import type { LeaseReading } from './session-claim.js';
import { isTerminalPlacement } from './status-assertions.js';
import {
  AT_REST_STATUSES,
  SHORTEST_GRACE_MS,
  STRAND_RULES,
  type StrandEvidence,
  strandReason,
  strandRuleFor,
  WATCHED_STATUSES,
} from './strand-rules.js';

function reading(over: Partial<LeaseReading> = {}): LeaseReading {
  return {
    verdict: 'none',
    holder: null,
    expiresAt: null,
    fanout: 0,
    stopped: false,
    silentMs: null,
    detail: '',
    ...over,
  };
}

function evidence(over: Partial<StrandEvidence> = {}): StrandEvidence {
  return { merged: false, everRan: true, poolHasRunner: true, lease: reading(), ...over };
}

const WATCHED = { watch: true, graceMs: 1, owes: 'agent', waitingFor: 'a run' } as const;

describe('STRAND_RULES covers every status (ISS-1122)', () => {
  /**
   * The hole this issue was filed about: `stranded-issues.ts` enumerates `waiting` and
   * `issue-run-invariant.ts` enumerates three statuses, so a status neither named was read by
   * nothing at all. A `Record<IssueStatus, …>` makes the same omission a typecheck failure; this
   * proves the table has not been widened with an index signature that would let one back in.
   */
  it('holds an entry for every member of IssueStatus', () => {
    for (const status of issueStatuses) {
      expect(STRAND_RULES[status], `no rule for ${status}`).toBeDefined();
    }
    expect(Object.keys(STRAND_RULES).sort()).toEqual([...issueStatuses].sort());
  });

  it('names a reason on every status it declares at rest', () => {
    for (const status of AT_REST_STATUSES) {
      const rule = STRAND_RULES[status];
      expect(rule.watch).toBe(false);
      if (!rule.watch) expect(rule.atRest.length).toBeGreaterThan(10);
    }
  });

  it('declares both terminal statuses at rest and watches neither', () => {
    for (const status of issueStatuses.filter(isTerminalPlacement)) {
      expect(STRAND_RULES[status].watch).toBe(false);
    }
    expect(WATCHED_STATUSES.some(isTerminalPlacement)).toBe(false);
  });

  it('leaves `waiting` to the pass that already owns it', () => {
    const rule = STRAND_RULES.waiting;
    expect(rule.watch).toBe(false);
    if (!rule.watch) expect(rule.atRest).toContain('stranded-issues');
  });

  it('gives each watched status its own clock rather than one global one', () => {
    const graces = new Set(
      WATCHED_STATUSES.map((s) => {
        const rule = STRAND_RULES[s];
        return rule.watch ? rule.graceMs : 0;
      }),
    );
    expect(graces.size).toBeGreaterThan(1);
    expect(SHORTEST_GRACE_MS).toBe(Math.min(...graces));
  });

  it('answers null for a status this build does not hold, rather than guessing one', () => {
    expect(strandRuleFor('in_progress')).not.toBeNull();
    expect(strandRuleFor('quantum_superposition')).toBeNull();
    expect(strandRuleFor('')).toBeNull();
    expect(strandRuleFor('constructor')).toBeNull();
    expect(strandRuleFor('toString')).toBeNull();
  });
});

describe('strandReason draws on evidence, never on the status alone (ISS-1122)', () => {
  /** ISS-1122, instance 1 — ISS-1126 was filed `open` on a project whose only runners were
   *  draining and disabled. The wake published, was delivered, and nothing could act on it. */
  it('names the missing runner for an `open` row whose project has none in the pool', () => {
    const { reason, owes } = strandReason({
      status: 'open',
      rule: WATCHED,
      evidence: evidence({ poolHasRunner: false, everRan: false }),
    });
    expect(reason).toContain('job pool');
    expect(owes).toBe('human');
  });

  it('names the missing dispatch for an `open` row whose project does have a runner', () => {
    const { reason, owes } = strandReason({
      status: 'open',
      rule: WATCHED,
      evidence: evidence({ poolHasRunner: true, everRan: false }),
    });
    expect(reason).toContain('dispatch did not happen');
    expect(owes).toBe('agent');
  });

  /**
   * ISS-1122, instance 2 — the holder could not release, so the lease outlived the run. What the
   * pass can see is the lease's own state; the consult's F2 is that expiry proves the claim
   * lapsed and says nothing about what the holder did, so neither may the sentence.
   */
  it('names the lapsed claim without asserting what its holder did', () => {
    const { reason } = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: reading({ verdict: 'expired' }) }),
    });
    expect(reason).toContain('ran past its own expiry');
    expect(reason).not.toContain('run that claimed');
    expect(reason).not.toContain('stopped');
  });

  it('separates a claim already released from one that merely ran out', () => {
    const released = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: reading({ verdict: 'expired', stopped: true }) }),
    }).reason;
    const lapsed = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: reading({ verdict: 'expired', stopped: false }) }),
    }).reason;
    expect(released).toContain('was released and nothing has taken it since');
    expect(lapsed).toContain('ran past its own expiry');
    expect(released).not.toBe(lapsed);
  });

  it('says how many issues a shared holder is on, and claims nothing about the run', () => {
    const { reason } = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: reading({ verdict: 'shared', fanout: 3 }) }),
    });
    expect(reason).toContain('3 issues at once');
    expect(reason).toContain('not evidence');
    expect(reason).not.toContain('dead');
  });

  it('names the unreadable field of a malformed lease and says it was left standing', () => {
    const { reason, owes } = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({
        lease: reading({ verdict: 'malformed', detail: 'minutes is not a positive finite number' }),
      }),
    });
    expect(reason).toContain('minutes is not a positive finite number');
    expect(reason).toContain('left standing');
    expect(owes).toBe('human');
  });

  /**
   * The consult's F5: two rows at one status can be stuck for different causes, so the sentence
   * must come from what was observed. These two differ only in the merge mark.
   */
  it('separates a `developed` row with no merge mark from one that has one', () => {
    const unmerged = strandReason({
      status: 'developed',
      rule: WATCHED,
      evidence: evidence({ merged: false }),
    }).reason;
    const merged = strandReason({
      status: 'developed',
      rule: WATCHED,
      evidence: evidence({ merged: true }),
    }).reason;
    expect(unmerged).toContain('no merge mark');
    expect(merged).toContain('merge mark and nothing has moved the row');
    expect(unmerged).not.toBe(merged);
  });

  /** The refusal by name, turned on the pass's own uncertainty rather than only on the row's. */
  it('says the cause is not decidable where nothing observed decides it', () => {
    const { reason } = strandReason({
      status: 'testing',
      rule: WATCHED,
      evidence: evidence({ everRan: false, merged: false }),
    });
    expect(reason).toBe('no live work observed; what it waits for is not decidable from here');
  });

  it('falls back to the rule owner where no evidence overrides it', () => {
    const rule = { watch: true, graceMs: 1, owes: 'human', waitingFor: 'a person' } as const;
    expect(strandReason({ status: 'awaiting_release', rule, evidence: evidence() }).owes).toBe(
      'human',
    );
  });
});

/** A rule table that hands every status the same grace would nag the fast path or miss the slow one. */
describe('the clocks are per status (ISS-1122)', () => {
  it('gives `open` a shorter clock than `awaiting_release`', () => {
    const open = STRAND_RULES.open;
    const release = STRAND_RULES.awaiting_release;
    if (!open.watch || !release.watch) throw new Error('both are watched statuses');
    expect(open.graceMs).toBeLessThan(release.graceMs);
  });

  it('keeps every watched grace above a minute, so a live dispatch race is not a strand', () => {
    for (const status of WATCHED_STATUSES) {
      const rule = STRAND_RULES[status as IssueStatus];
      if (rule.watch) expect(rule.graceMs).toBeGreaterThan(60_000);
    }
  });
});

/**
 * ISS-1195 — the one reading that is a direct measurement of the holder, and the only one the pass
 * acts on outside the status's own clock. Its sentence goes first for that reason: a row released
 * because its holder stopped reporting, and then explained by the project's runner admission, would
 * be the record contradicting the act taken on it.
 */
describe('strandReason answers an abandoned lease before it answers the status (ISS-1195)', () => {
  const abandoned = (silentMs: number) => reading({ verdict: 'abandoned', silentMs });

  it('says the holder stopped reporting, and how long ago', () => {
    const { reason, owes } = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: abandoned(20 * 60_000) }),
    });
    expect(reason).toContain('stopped reporting 20 minute(s) ago');
    expect(reason).toContain('has not run out');
    expect(owes).toBe('agent');
  });

  it.each([
    [30_000, 'less than a minute ago'],
    [20 * 60_000, '20 minute(s) ago'],
    [5 * 60 * 60_000, '5 hour(s) ago'],
  ])('reads %d ms of silence as `%s`', (silentMs, said) => {
    const { reason } = strandReason({
      status: 'in_progress',
      rule: WATCHED,
      evidence: evidence({ lease: abandoned(silentMs) }),
    });
    expect(reason).toContain(said);
  });

  it('does not collapse into either expiry sentence', () => {
    const said = (lease: LeaseReading) =>
      strandReason({ status: 'in_progress', rule: WATCHED, evidence: evidence({ lease }) }).reason;
    const gone = said(abandoned(20 * 60_000));
    expect(gone).not.toBe(said(reading({ verdict: 'expired' })));
    expect(gone).not.toBe(said(reading({ verdict: 'expired', stopped: true })));
    expect(gone).not.toContain('expiry');
  });

  /**
   * The position, held by a test rather than by line order: both `open` branches answer before any
   * lease is read, so an abandoned holder on a project with no admitted runner would otherwise be
   * explained by the pool.
   */
  it.each([
    ['whose project has no admitted runner', { poolHasRunner: false, everRan: true }],
    ['that never ran', { poolHasRunner: true, everRan: false }],
  ])('still names the silent holder for an `open` row %s', (_name, over) => {
    const { reason } = strandReason({
      status: 'open',
      rule: WATCHED,
      evidence: evidence({ ...over, lease: abandoned(90 * 60_000) }),
    });
    expect(reason).toContain('stopped reporting');
    expect(reason).not.toContain('job pool');
    expect(reason).not.toContain('dispatch did not happen');
  });
});
