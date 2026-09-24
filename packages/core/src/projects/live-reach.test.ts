import { describe, expect, it } from 'vitest';
import { issueRefPattern, type LiveReading, liveReachOf, namedIssueSeqs } from './live-reach.js';

const STARTED = new Date('2026-09-23T14:00:00Z');
const BEFORE = '2026-09-23T04:22:00Z';
const AFTER = '2026-09-23T14:05:00Z';
const OWN = 'd'.repeat(40);

const pattern = issueRefPattern(['SD']);

function measured(over: Partial<Extract<LiveReading, { kind: 'measured' }>> = {}): LiveReading {
  return {
    kind: 'measured',
    baseBranch: 'staging',
    liveBranch: 'master',
    baseSha: 'b'.repeat(40),
    liveSha: '52c66950'.padEnd(40, '0'),
    aheadBy: 2,
    commits: [
      { sha: OWN, message: 'Merge pull request #88 from sid/feature-x' },
      { sha: 'e'.repeat(40), message: 'fix(desk): the queue shows the owner (SD-442)\n\nbody' },
    ],
    complete: true,
    startedAt: STARTED,
    ...over,
  };
}

const issue = (
  over: Partial<{ issSeq: number; mergedAt: string | null; mergedCommitSha: string | null }> = {},
) => ({
  issSeq: 419,
  mergedAt: BEFORE,
  mergedCommitSha: null,
  ...over,
});

describe('namedIssueSeqs', () => {
  it('reads every held prefix and the shared legacy one, case-blind, on whole references only', () => {
    const msg = 'SD-1 iss-2 Merge from sid/ISS-3-slug; XSD-4 SD-55x SD-6789';
    expect([...namedIssueSeqs(msg, pattern)].sort((a, b) => a - b)).toEqual([1, 2, 3, 55, 6789]);
  });

  it('does not read a reference whose number runs on into more digits as a shorter one', () => {
    expect(namedIssueSeqs('SD-4420', pattern).has(442)).toBe(false);
  });
});

describe('liveReachOf', () => {
  it('places an issue off live when its observed merge commit is waiting', () => {
    const r = liveReachOf(issue({ mergedCommitSha: OWN.toUpperCase() }), measured(), pattern);
    expect(r).toMatchObject({
      state: 'not_on_live',
      baseBranch: 'staging',
      liveBranch: 'master',
      evidence: [
        { sha: OWN, subject: 'Merge pull request #88 from sid/feature-x', via: 'merged_commit' },
      ],
    });
  });

  it('places an issue with only a claimed mark off live when a waiting commit names its key', () => {
    const r = liveReachOf(issue({ issSeq: 442 }), measured(), pattern);
    expect(r).toMatchObject({
      state: 'not_on_live',
      evidence: [{ subject: 'fix(desk): the queue shows the owner (SD-442)', via: 'names_issue' }],
    });
  });

  it('answers none_waiting, with what was compared and when, for a merge before a complete reading', () => {
    expect(liveReachOf(issue(), measured(), pattern)).toEqual({
      state: 'none_waiting',
      baseBranch: 'staging',
      liveBranch: 'master',
      measuredAt: STARTED.toISOString(),
      baseSha: 'b'.repeat(40),
      liveSha: '52c66950'.padEnd(40, '0'),
    });
  });

  it('carries a refusal reason rather than a verdict', () => {
    const refused: LiveReading = {
      kind: 'refused',
      baseBranch: 'staging',
      liveBranch: 'master',
      reason: 'this project has no active GitHub binding',
      startedAt: STARTED,
    };
    expect(liveReachOf(issue(), refused, pattern)).toEqual({
      state: 'unmeasured',
      baseBranch: 'staging',
      liveBranch: 'master',
      measuredAt: STARTED.toISOString(),
      reason: 'this project has no active GitHub binding',
    });
  });

  it('does not call an unnamed issue clear when the list was cut short', () => {
    const r = liveReachOf(issue(), measured({ aheadBy: 400, complete: false }), pattern);
    expect(r).toMatchObject({ state: 'unmeasured' });
    expect(r?.state === 'unmeasured' && r.reason).toMatch(/400 commits ahead .* listed only 2/);
  });

  it('still places a named issue from a cut-short list', () => {
    const r = liveReachOf(
      issue({ issSeq: 442 }),
      measured({ aheadBy: 400, complete: false }),
      pattern,
    );
    expect(r?.state).toBe('not_on_live');
  });

  it('does not call an issue clear when it merged after the reading started', () => {
    const r = liveReachOf(issue({ mergedAt: AFTER }), measured(), pattern);
    expect(r?.state === 'unmeasured' && r.reason).toMatch(/merged after the last reading/);
  });

  it('answers a pending reading as unmeasured with no time', () => {
    const pending: LiveReading = {
      kind: 'pending',
      baseBranch: 'staging',
      liveBranch: 'master',
      reason: 'still being taken',
    };
    expect(liveReachOf(issue(), pending, pattern)).toMatchObject({
      state: 'unmeasured',
      measuredAt: null,
      reason: 'still being taken',
    });
  });

  it('gives nothing for a project with no reading or an issue with no merged mark', () => {
    expect(liveReachOf(issue(), null, pattern)).toBeNull();
    expect(liveReachOf(issue({ mergedAt: null }), measured(), pattern)).toBeNull();
  });
});
