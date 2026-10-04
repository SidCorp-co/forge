import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

const at = (
  criteria: IssueStandingInput['criteria'],
  releaseApproval = true,
): IssueStandingInput => ({
  status: 'awaiting_release',
  waitingKind: null,
  merged: true,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria,
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: new Date('2026-10-04T09:00:00Z'),
  releaseApproval,
  viewer: { userId: 'u1', canWrite: true },
  now: new Date('2026-10-04T10:00:00Z'),
});

describe('awaiting_release with a criterion that no longer passes (FB-56)', () => {
  it('puts it on the master to judge again, never on a person to approve the release', () => {
    const s = deriveIssueStanding(at({ total: 12, passing: 0, failing: 0, skipped: 0 }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'master', who: 'Master', act: 'judge it again' });
    expect(s.waitingOn.rule).toContain('12 of 12 criteria have no verdict that passes now');
  });

  it('holds it on one lapsed criterion among passing ones, on a project that releases unasked too', () => {
    const s = deriveIssueStanding(at({ total: 3, passing: 2, failing: 0, skipped: 0 }, false));
    expect(s.waitingOn.act).toBe('judge it again');
    expect(s.waitingOn.rule).toContain('1 of 3 criteria');
  });

  it('planted control: every criterion passing asks a person to approve the release', () => {
    const s = deriveIssueStanding(at({ total: 3, passing: 3, failing: 0, skipped: 0 }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe('approve the release');
  });

  it('an issue with no criteria is not held by this rule', () => {
    const s = deriveIssueStanding(at({ total: 0, passing: 0, failing: 0, skipped: 0 }, false));
    expect(s.attentionGroup).toBe('queued');
  });
});
