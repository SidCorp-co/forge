// Coverage counts proof the way the project's delivery counted it (contracts
// `verified-rule.ts:voidedUnder`). Planted from catalog-api (release mode change-requests), whose
// coverage kept a pass from before ISS-33's reopen at its request's head while the release roster
// voided it, and catalog-fe REQ-3 (release mode none), whose landing records counted such passes.
import { describe, expect, it } from 'vitest';
import { deliveryAt, type StandingIssueCriterion } from './standing.js';

const F = 'f'.repeat(40);
const OTHER = 'd'.repeat(40);
const JUDGED = '2026-10-23T07:07:16Z';
const REOPENED = new Date('2026-10-23T07:13:00Z');

/** Criterion 1 of ISS-1, its newest verdict a pass at `commit` the reopen voided. */
const voided = (commit = F): StandingIssueCriterion => ({
  issueId: 'i1',
  n: 1,
  requirementCriterionId: 'c1',
  verdict: null,
  verdictAt: null,
  identity: null,
  byBuilder: false,
  authored: false,
  recordedAt: null,
  beforeReopen: {
    verdict: 'pass',
    verdictAt: new Date(JUDGED),
    identity: { kind: 'commit', sha: commit },
    byBuilder: false,
    authored: true,
    recordedAt: new Date(JUDGED),
  },
  reopenedAt: REOPENED,
});

const read = (traced: StandingIssueCriterion, landsAsDelivery: boolean) =>
  deliveryAt(
    {
      status: 'agreed',
      criteria: [
        { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null },
      ],
      issues: [
        {
          id: 'i1',
          displayId: 'ISS-1',
          title: 'Issue 1',
          status: 'awaiting_release',
          tone: 'neutral' as const,
          updatedAt: new Date('2026-10-23T08:35:00Z'),
          closedAt: null,
          changedSincePlan: false,
        },
      ],
      issueCriteria: [traced],
      judge: 'self',
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([['i1', { sha: F, why: null }]]),
        landsAsDelivery,
      },
    },
    1,
  );

describe('a pass from before the reopen, by how the project delivers', () => {
  it('stays void on a project that releases, even judged at the build it ships', () => {
    const { coverage, delivery } = read(voided(), false);
    expect(coverage[0]?.verdict).toBe('not_judged');
    expect(delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 0, judged: 0 });
  });

  it('counts under release mode none where it was judged at the landed commit', () => {
    const { coverage, delivery } = read(voided(), true);
    expect(coverage[0]?.verdict).toBe('passing');
    expect(delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('stays void under release mode none where it was judged at another commit', () => {
    expect(read(voided(OTHER), true).coverage[0]?.verdict).toBe('not_judged');
  });
});
