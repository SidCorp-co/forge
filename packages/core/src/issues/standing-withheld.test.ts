import { type IssueStatus, TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueWithheld } from '@forge/contracts/issue-standing';
import { describe, expect, it } from 'vitest';
import { policyGapOf } from '../project-config/dispatch-policy.js';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

const now = new Date('2026-10-05T10:00:00Z');

const input = (status: IssueStatus, withheld: IssueWithheld | null): IssueStandingInput => ({
  status,
  leftStatus: null,
  holdsDependents: false,
  waitingKind: null,
  merged: false,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  runLive: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: now,
  releaseApproval: false,
  releaseNoted: true,
  viewer: null,
  withheld,
  now,
});

const contract: IssueWithheld = {
  code: 'CONTRACT_WAIT_UNSETTLED',
  detail: 'ISS-7 waits on hop/api >= 2.0.0, which no approved version settles yet.',
};

describe('Issues > Stuck names the refusal the admissible list withholds a row by', () => {
  it('an open issue on an unsettled contract wait reads stuck, the code named', () => {
    const s = deriveIssueStanding(input('open', contract));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.withheld).toEqual(contract);
    expect(s.waitingOn.ref).toBe('CONTRACT_WAIT_UNSETTLED');
    expect(s.waitingOn.rule.startsWith('CONTRACT_WAIT_UNSETTLED: ISS-7 waits on')).toBe(true);
  });

  it.each(TAKEABLE_STATUSES)('POLICY_UNDECLARED at %s reads stuck', (st) => {
    const s = deriveIssueStanding(
      input(st, { code: 'POLICY_UNDECLARED', detail: 'project p has no policy.' }),
    );
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn.act).toBe('declare the policy');
    expect(s.waitingOn.rule).toMatch(/^POLICY_UNDECLARED: /);
  });

  it('an open issue nothing withholds stays queued for a master', () => {
    const s = deriveIssueStanding(input('open', null));
    expect(s.attentionGroup).toBe('queued');
    expect(s.withheld).toBeNull();
  });

  // F38: an admitted open row is owed a run by the master, not a free slot nor somebody's triage
  it('an admitted open issue waits on the master to dispatch a run, not on a slot', () => {
    const s = deriveIssueStanding(input('open', null));
    expect(s.waitingOn).toMatchObject({ kind: 'master', who: 'Master', act: 'dispatch a run' });
    expect(s.waitingOn.rule).toMatch(/owes it a run/);
    expect(s.waitingOn.rule).not.toMatch(/slot/);
  });

  it('a withholding gate does not reach a status that is not takeable', () => {
    const s = deriveIssueStanding(input('in_progress', contract));
    expect(s.withheld).toBeNull();
    expect(s.waitingOn.ref).toBeNull();
  });

  it('a held lease reads moving, not withheld', () => {
    const s = deriveIssueStanding({
      ...input('open', contract),
      lease: { holder: 'run', verdict: 'live', expiresAt: null },
    });
    expect(s.attentionGroup).toBe('moving');
  });
});

describe('policyGapOf answers the refusal dispatchStateOf would give', () => {
  const held = (states: Record<string, unknown>) =>
    ({
      revision: 1,
      document: {
        qa: 'self',
        states,
        permissions: { std: { deny: [] } },
      },
    }) as unknown as Parameters<typeof policyGapOf>[1];

  it('no policy → POLICY_UNDECLARED', () => {
    expect(policyGapOf('p', null, 'open')?.code).toBe('POLICY_UNDECLARED');
  });

  it('no entry state → POLICY_STATE_UNDECLARED at open, and at approved, which runs under it', () => {
    const p = held({ in_progress: { model: 'm', permissions: 'std' } });
    for (const status of TAKEABLE_STATUSES) {
      const gap = policyGapOf('p', p, status);
      expect(gap?.code).toBe('POLICY_STATE_UNDECLARED');
      expect(gap?.detail).toContain('states.open');
    }
  });

  it('a declared state → null', () => {
    expect(policyGapOf('p', held({ open: { model: 'm', permissions: 'std' } }), 'open')).toBeNull();
  });
});
