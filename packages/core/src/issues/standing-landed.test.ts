/**
 * A landed row waits on a judge only where the project's policy declares an independent one
 * (ISS-1068): under `self` or the builder's own pass, nobody judges between the landing and the
 * release, so a merged reopen is the master's to run again and a merged open row the master's to
 * move on, never "Next run · claim it and judge what landed".
 *
 * @direct-test-of packages/core/src/issues/strand-rules.ts
 * @direct-test-of packages/core/src/issues/standing.ts
 * @direct-test-of packages/core/src/issues/standing-held.ts
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput, type StandingEdge } from './standing.js';
import { landedWait, STRAND_RULES, strandReason } from './strand-rules.js';

const now = new Date('2026-11-07T10:00:00Z');
const weekAgo = new Date('2026-10-26T10:00:00Z');

const input = (
  status: IssueStatus,
  judge: VerifiedJudge,
  over: Partial<IssueStandingInput> = {},
): IssueStandingInput => ({
  status,
  leftStatus: null,
  designOnly: false,
  holdsDependents: false,
  waitingKind: null,
  merged: true,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  runLive: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria: { total: 2, met: 0, failing: 1, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: weekAgo,
  releaseApproval: false,
  releaseNoted: true,
  releaseHold: null,
  writers: [],
  admins: [],
  withheld: null,
  statusSince: weekAgo,
  master: 'serves',
  judge,
  now,
  ...over,
});

const JUDGE_WORDS = /judge/i;

describe('a merged, reopened issue on a project with no independent judge', () => {
  for (const judge of ['self', 'builder'] as const) {
    it(`waits on the master to run it again, never on a judge (${judge})`, () => {
      const s = deriveIssueStanding(input('reopen', judge));
      expect(s.waitingOn.kind).toBe('master');
      expect(s.waitingOn.who).not.toBe('Next run');
      expect(s.waitingOn.act).not.toMatch(JUDGE_WORDS);
      expect(s.waitingOn.rule).not.toMatch(JUDGE_WORDS);
      expect(s.times.stuck?.reason ?? '').not.toMatch(JUDGE_WORDS);
    });
  }

  it('reads no judge in the sweep either', () => {
    const rule = STRAND_RULES.reopen;
    const evidence = {
      merged: true,
      everRan: true,
      poolHasRunner: true,
      lease: { verdict: 'none' as const, holder: null, expiresAt: null, fanout: 0 },
      judge: 'self' as const,
    };
    expect(landedWait('reopen', evidence)).toBeNull();
    const { reason, owes } = strandReason({
      status: 'reopen',
      rule,
      evidence: evidence as Parameters<typeof strandReason>[0]['evidence'],
    });
    expect(reason).not.toMatch(JUDGE_WORDS);
    expect(owes).toBe('agent');
  });
});

describe('a merged open issue on a project with no independent judge', () => {
  it('waits on the master to move it on to awaiting_release', () => {
    const s = deriveIssueStanding(input('open', 'self'));
    expect(s.waitingOn.kind).toBe('master');
    expect(s.waitingOn.act).toBe('move it on');
    expect(s.waitingOn.rule).toContain('awaiting_release');
    expect(s.waitingOn.rule).not.toMatch(JUDGE_WORDS);
  });
});

describe('a landed blocker on a project with no independent judge', () => {
  it('holds its dependent without naming a judge', () => {
    const blocker: StandingEdge = {
      id: 'b',
      key: 'ISS-1',
      title: 'blocker',
      status: 'open',
      merged: true,
      step: null,
      holds: true,
    };
    const s = deriveIssueStanding(input('open', 'self', { merged: false, blockedBy: [blocker] }));
    expect(s.waitingOn.act).not.toMatch(JUDGE_WORDS);
    expect(s.waitingOn.rule).not.toMatch(JUDGE_WORDS);
    expect(s.blockedBy[0]?.landed).toBe(false);
  });
});

describe('a merged, reopened issue where the policy declares an independent judge', () => {
  it('still waits on the run that judges what landed', () => {
    const s = deriveIssueStanding(input('reopen', 'independent'));
    expect(s.waitingOn.kind).toBe('judge');
    expect(s.waitingOn.act).toMatch(JUDGE_WORDS);
  });
});
