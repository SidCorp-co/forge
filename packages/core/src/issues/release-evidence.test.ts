import { describe, expect, it } from 'vitest';
import type { CriterionWithVerdict, LatestVerdict } from './criteria/store.js';
import { evaluateCriteria } from './release-evidence.js';

const verdict = (over: Partial<LatestVerdict>): LatestVerdict => ({
  id: 'v',
  verdict: 'pass',
  reason: null,
  identityKind: 'commit',
  commitSha: '3641ba21fec5096e2d1a91a40f2d9e50e9239068',
  runtimeRef: null,
  designWorkflowId: null,
  designFlow: null,
  designRevision: null,
  contractRef: null,
  contractVersion: null,
  evidence: [],
  authorAgency: 'agent',
  backfilled: false,
  createdAt: '2026-10-03T00:00:00.000Z',
  ...over,
});
const criterion = (n: number, latest: LatestVerdict | null): CriterionWithVerdict => ({
  id: `c${n}`,
  n,
  statement: 's',
  position: n,
  requirementCriterionId: null,
  latest,
});

describe('evaluateCriteria (ISS-55: the awaiting_release gate off criterion_verdicts)', () => {
  it('owes criteria where the issue has none', () => {
    expect(evaluateCriteria([])).toEqual({ kind: 'no-criteria' });
  });

  it('passes every criterion whose latest verdict passes with an identity', () => {
    expect(
      evaluateCriteria([criterion(1, verdict({})), criterion(2, verdict({ verdict: 'short' }))]),
    ).toEqual({
      kind: 'criteria',
      unpassed: [],
      unidentified: [],
    });
  });

  it('never counts skipped or fail as a pass, and names a criterion never judged', () => {
    const found = evaluateCriteria([
      criterion(
        1,
        verdict({ verdict: 'skipped', reason: 'no host', identityKind: null, commitSha: null }),
      ),
      criterion(2, verdict({ verdict: 'fail' })),
      criterion(3, null),
    ]);
    expect(found).toEqual({
      kind: 'criteria',
      unpassed: [
        { criterion: 1, verdict: 'skipped' },
        { criterion: 2, verdict: 'fail' },
        { criterion: 3, verdict: null },
      ],
      unidentified: [],
    });
  });

  it('does not accept a backfilled commit_unresolved as an identity: the amnesty ends on reopen', () => {
    const found = evaluateCriteria([
      criterion(
        1,
        verdict({ identityKind: 'commit_unresolved', commitSha: '1810f84', backfilled: true }),
      ),
    ]);
    expect(found).toEqual({ kind: 'criteria', unpassed: [], unidentified: [1] });
  });
});
