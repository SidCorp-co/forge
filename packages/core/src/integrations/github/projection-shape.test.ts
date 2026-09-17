/**
 * The ordering rules, under the delivery order that breaks them.
 *
 * Every case here plants the arrival order that would produce the wrong answer
 * if the rule were arrival order — a completed run followed by its own queued
 * delivery, a dismissal followed by the submission it dismissed, a stale head's
 * check arriving after a fresh one. A test that only replays deliveries in the
 * order GitHub emitted them proves nothing about a projection built from
 * webhooks, because that is the one order webhooks do not guarantee.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectedCheckRun, ProjectedReview } from '../../db/schema-repo-projection.js';
import {
  checkRunIsNewer,
  currentHeadRuns,
  foldCheckRun,
  foldReviewDismissed,
  foldReviewSubmitted,
  payloadIsNotOlder,
  pruneChecks,
  rollupOf,
} from './projection-shape.js';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function run(over: Partial<ProjectedCheckRun> & { id: string }): ProjectedCheckRun {
  return {
    name: 'ci-passed',
    app: 'github-actions',
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    detailsUrl: null,
    startedAt: '2026-09-17T01:00:00Z',
    completedAt: '2026-09-17T01:05:00Z',
    ...over,
  };
}

function review(over: Partial<ProjectedReview> & { id: string }): ProjectedReview {
  return {
    reviewer: 'codex',
    state: 'changes_requested',
    submittedAt: '2026-09-17T01:00:00Z',
    dismissed: false,
    url: null,
    ...over,
  };
}

describe('a check run is ordered by GitHub`s own progression, never by arrival', () => {
  it('takes a completed delivery over the queued one already stored', () => {
    const queued = run({ id: '1', status: 'queued', conclusion: null, completedAt: null });
    expect(checkRunIsNewer(run({ id: '1' }), queued)).toBe(true);
  });

  it('refuses a queued delivery that arrives after the run already completed', () => {
    const done = run({ id: '1' });
    const late = run({ id: '1', status: 'queued', conclusion: null, completedAt: null });
    expect(checkRunIsNewer(late, done)).toBe(false);
    const folded = foldCheckRun({ '1': done }, late, HEAD);
    expect(folded['1']?.status).toBe('completed');
    expect(folded['1']?.conclusion).toBe('success');
  });

  it('takes the later of two completions for one run id', () => {
    const first = run({ id: '1', conclusion: 'failure', completedAt: '2026-09-17T01:05:00Z' });
    const second = run({ id: '1', conclusion: 'success', completedAt: '2026-09-17T01:09:00Z' });
    expect(foldCheckRun({ '1': first }, second, HEAD)['1']?.conclusion).toBe('success');
    expect(foldCheckRun({ '1': second }, first, HEAD)['1']?.conclusion).toBe('success');
  });

  it('stores a run for a head the row has left, and counts it in nothing', () => {
    const stale = run({ id: '9', headSha: OLD_HEAD, conclusion: 'failure' });
    const folded = foldCheckRun({ '1': run({ id: '1' }) }, stale, HEAD);
    expect(folded['9']).toBeDefined();
    expect(rollupOf(folded, HEAD)).toEqual({ total: 1, success: 1, failure: 0, pending: 0 });
  });
});

describe('the rollup reads the current head, grouped by app and name', () => {
  it('counts two apps publishing one name as two checks', () => {
    const checks = {
      '1': run({ id: '1', app: 'github-actions', name: 'build' }),
      '2': run({ id: '2', app: 'buildkite', name: 'build', conclusion: 'failure' }),
    };
    expect(rollupOf(checks, HEAD)).toEqual({ total: 2, success: 1, failure: 1, pending: 0 });
  });

  it('counts only the latest started run where one app re-ran one check', () => {
    const checks = {
      '1': run({ id: '1', conclusion: 'failure', startedAt: '2026-09-17T01:00:00Z' }),
      '2': run({ id: '2', conclusion: 'success', startedAt: '2026-09-17T02:00:00Z' }),
      '3': run({ id: '3', conclusion: 'success', startedAt: '2026-09-17T01:30:00Z' }),
    };
    expect(currentHeadRuns(checks, HEAD).map((r) => r.id)).toEqual(['2']);
    expect(rollupOf(checks, HEAD)).toEqual({ total: 1, success: 1, failure: 0, pending: 0 });
  });

  it('breaks a tie on the run id, so two runs started in one second do not depend on map order', () => {
    const at = '2026-09-17T01:00:00Z';
    const older = run({ id: '100', conclusion: 'failure', startedAt: at });
    const newer = run({ id: '200', conclusion: 'success', startedAt: at });
    expect(currentHeadRuns({ '100': older, '200': newer }, HEAD)[0]?.id).toBe('200');
    expect(currentHeadRuns({ '200': newer, '100': older }, HEAD)[0]?.id).toBe('200');
  });

  it('counts an unfinished run as pending rather than as a pass', () => {
    const checks = { '1': run({ id: '1', status: 'in_progress', conclusion: null }) };
    expect(rollupOf(checks, HEAD)).toEqual({ total: 1, success: 0, failure: 0, pending: 1 });
  });

  it('counts neutral and skipped as GitHub does, and cancelled as a failure', () => {
    const checks = {
      '1': run({ id: '1', name: 'a', conclusion: 'neutral' }),
      '2': run({ id: '2', name: 'b', conclusion: 'skipped' }),
      '3': run({ id: '3', name: 'c', conclusion: 'cancelled' }),
    };
    expect(rollupOf(checks, HEAD)).toEqual({ total: 3, success: 2, failure: 1, pending: 0 });
  });

  it('is empty on a head no stored run ran against', () => {
    expect(rollupOf({ '1': run({ id: '1' }) }, 'c'.repeat(40))).toEqual({
      total: 0,
      success: 0,
      failure: 0,
      pending: 0,
    });
  });
});

describe('pruning keeps the current head whole', () => {
  it('drops the oldest foreign runs and never one on the current head', () => {
    const checks: Record<string, ProjectedCheckRun> = {};
    for (let i = 0; i < 60; i += 1) {
      checks[`f${i}`] = run({
        id: `f${i}`,
        name: `n${i}`,
        headSha: OLD_HEAD,
        startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
    }
    checks.live = run({ id: 'live', name: 'live' });
    const pruned = pruneChecks(checks, HEAD);
    expect(pruned.live).toBeDefined();
    expect(Object.keys(pruned)).toHaveLength(51);
    expect(pruned.f0).toBeUndefined();
    expect(pruned.f59).toBeDefined();
  });
});

describe('a review is ordered by what a dismissal means, not by a timestamp', () => {
  it('keeps a dismissal when the submission it dismissed is redelivered after it', () => {
    const dismissed = foldReviewDismissed({}, review({ id: '7' }));
    const resubmitted = foldReviewSubmitted(dismissed, review({ id: '7' }));
    expect(resubmitted['7']?.dismissed).toBe(true);
  });

  it('records a dismissal for a review it never saw submitted', () => {
    const only = foldReviewDismissed({}, review({ id: '8', reviewer: 'someone' }));
    expect(only['8']).toMatchObject({ dismissed: true, reviewer: 'someone' });
  });

  it('replaces a reviewer`s state rather than adding a second entry for the same review', () => {
    const first = foldReviewSubmitted({}, review({ id: '9', state: 'changes_requested' }));
    const second = foldReviewSubmitted(first, review({ id: '9', state: 'approved' }));
    expect(Object.keys(second)).toEqual(['9']);
    expect(second['9']?.state).toBe('approved');
  });

  it('keeps two different reviews by one person apart', () => {
    const a = foldReviewSubmitted({}, review({ id: '1' }));
    const b = foldReviewSubmitted(a, review({ id: '2', state: 'approved' }));
    expect(Object.keys(b).sort()).toEqual(['1', '2']);
  });
});

describe('a pull request`s scalars are ordered by the payload`s own timestamp', () => {
  it('takes a payload newer than the stored one', () => {
    expect(payloadIsNotOlder('2026-09-17T02:00:00Z', new Date('2026-09-17T01:00:00Z'))).toBe(true);
  });

  it('refuses one older than the stored one', () => {
    expect(payloadIsNotOlder('2026-09-17T01:00:00Z', new Date('2026-09-17T02:00:00Z'))).toBe(false);
  });

  it('takes an equal one, because GitHub redelivers the same payload on a retry', () => {
    expect(payloadIsNotOlder('2026-09-17T01:00:00Z', new Date('2026-09-17T01:00:00Z'))).toBe(true);
  });

  it('takes anything where nothing is stored yet', () => {
    expect(payloadIsNotOlder('2026-09-17T01:00:00Z', null)).toBe(true);
  });

  it('takes a payload whose timestamp is unreadable rather than dropping the delivery', () => {
    expect(payloadIsNotOlder('not a date', new Date('2026-09-17T02:00:00Z'))).toBe(true);
  });
});
