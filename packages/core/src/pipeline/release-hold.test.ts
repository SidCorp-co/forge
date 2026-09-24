import { describe, expect, it } from 'vitest';
import { runnerHoldClause } from '../release-batch/blocker-sentences.js';
import type { RunnerHold } from '../runners/ineligible.js';
import {
  criteriaHold,
  cutFailedHold,
  readReleaseHold,
  refusalHold,
  releaseHoldComment,
  sameReleaseHold,
  withoutAges,
} from './release-hold.js';

const REPORT = {
  issueId: 'iss-1',
  broken: [],
  unearned: [
    {
      criterion: 1,
      verdict: 'pass',
      standing: 'unwitnessed' as const,
      why: 'no runtime witnessed it',
    },
    { criterion: 3, verdict: null, standing: null, why: 'no verdict was recorded for it' },
  ],
};

describe('the hold a row carries (ISS-1215)', () => {
  it('names every held criterion by number and why', () => {
    const hold = criteriaHold(REPORT);
    expect(hold.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold.reason).toContain('criterion 1: no runtime witnessed it');
    expect(hold.reason).toContain('criterion 3: no verdict was recorded for it');
  });

  it('reads back what was stored, and refuses a shape it cannot read', () => {
    const hold = criteriaHold(REPORT);
    expect(
      readReleaseHold({ ...hold, at: '2026-09-24T00:00:00Z', status: 'awaiting_release' }),
    ).toEqual(hold);
    expect(readReleaseHold(null)).toBeNull();
    expect(readReleaseHold({ code: 'X', reason: 'r', waitingFor: 'w', owes: 'nobody' })).toBeNull();
    expect(readReleaseHold(['not', 'a', 'hold'])).toBeNull();
  });

  it('treats a hold written at another moment as the same hold, and a new reason as a new one', () => {
    const hold = criteriaHold(REPORT);
    expect(sameReleaseHold(readReleaseHold({ ...hold, at: 'earlier' }), hold)).toBe(true);
    const moved = criteriaHold({ ...REPORT, unearned: REPORT.unearned.slice(1) });
    expect(sameReleaseHold(hold, moved)).toBe(false);
    expect(sameReleaseHold(null, hold)).toBe(false);
  });

  it('owes a self-clearing refusal to the release path and every other to a person', () => {
    expect(refusalHold('BATCH_IN_FLIGHT', ['in flight']).owes).toBe('agent');
    expect(refusalHold('CLAIM_CONFLICT', ['claimed']).owes).toBe('agent');
    expect(refusalHold('NO_RUNNER_ONLINE', ['none online']).owes).toBe('human');
  });

  it('says a failed cut left the row untouched', () => {
    expect(cutFailedHold(['lock timeout']).reason).toContain('not claimed, not moved');
  });

  it('writes a comment carrying the reason, who owes it and the code', () => {
    const body = releaseHoldComment(criteriaHold(REPORT));
    expect(body).toContain('criterion 3: no verdict was recorded for it');
    expect(body).toContain('which an agent run owes');
    expect(body).toContain('`release-hold: RELEASE_CRITERIA_UNEARNED`');
  });
});

describe('a standing refusal is one reason however long it stands (ISS-1215)', () => {
  const box = (over: Partial<RunnerHold>): RunnerHold => ({
    deviceName: 'dev1',
    reason: 'stale',
    lastSeenSeconds: 60,
    reporting: false,
    ...over,
  });
  const refusal = (hold: RunnerHold) => refusalHold('NO_RUNNER_ONLINE', [runnerHoldClause(hold)]);

  it.each([
    ['stale', false],
    ['disconnected', false],
    ['auth', true],
    ['auth', false],
  ] as const)('drops the heartbeat age from a %s box (reporting: %s)', (reason, reporting) => {
    const first = refusal(box({ reason, reporting, lastSeenSeconds: 60 }));
    const later = refusal(box({ reason, reporting, lastSeenSeconds: 120 }));
    expect(first.reason).not.toMatch(/\d+s ago/);
    expect(sameReleaseHold(first, later)).toBe(true);
  });

  it('still reads a different box or a different reading as a new reason', () => {
    const first = refusal(box({}));
    expect(sameReleaseHold(first, refusal(box({ deviceName: 'dev2' })))).toBe(false);
    expect(sameReleaseHold(first, refusal(box({ reason: 'disconnected' })))).toBe(false);
  });

  it('keeps text that carries no age exactly as it was', () => {
    expect(withoutAges('No runner is online. Pair a box.')).toBe(
      'No runner is online. Pair a box.',
    );
  });
});
