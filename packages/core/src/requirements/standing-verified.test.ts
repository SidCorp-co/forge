// What counts as verified on a requirement's coverage (REQ-35 decision 7b261fca): BC-9 read passing
// on the ISS-463 builder's own verdicts alone, one short and one pass, though the project runs
// independent QA. Only a pass from someone other than the builder counts as verified now; a short
// never does (`standing-coverage.ts:unverifiedWhy`).
import type { PolicyQaMode } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { deliveryAt, type StandingIssueCriterion } from './standing.js';
import { proofTurn } from './standing-proof.js';

const A = 'a'.repeat(40);
const F = 'f'.repeat(40);
const BUILDER_WHY =
  'passed by the run that built it, and this project counts only a pass from its independent judge';

const issue = (n: number) => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status: 'closed',
  tone: 'neutral' as const,
  updatedAt: new Date('2026-09-20T00:00:00Z'),
  closedAt: new Date('2026-09-21T00:00:00Z'),
  changedSincePlan: false,
});

const row = (
  issueN: number,
  verdict: 'pass' | 'short' | 'fail',
  iso: string,
  byBuilder = false,
  commit = F,
): StandingIssueCriterion => ({
  issueId: `i${issueN}`,
  n: 1,
  requirementCriterionId: 'c1',
  verdict,
  verdictAt: new Date(iso),
  identity: { kind: 'commit', sha: commit },
  byBuilder,
});
const builder = (issueN: number, verdict: 'pass' | 'short' | 'fail', iso: string, commit = F) =>
  row(issueN, verdict, iso, true, commit);

const read = (
  issueCriteria: StandingIssueCriterion[],
  judge: PolicyQaMode | null = 'independent',
  holds: [string, boolean][] = [[F, true]],
) =>
  deliveryAt(
    {
      status: 'agreed',
      criteria: [
        { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null },
      ],
      issues: [issue(1), issue(2)],
      issueCriteria,
      judge,
      liveBuild: {
        sha: 'c'.repeat(40),
        holds: new Map(holds),
        runtimes: new Map(),
        unanswered: new Map(),
      },
    },
    1,
  );

describe('a short is not verified', () => {
  it('a short alone reads not judged, says why, and counts for nothing in k/n', () => {
    const { coverage, delivery } = read([row(1, 'short', '2026-10-05T00:00:00Z')], 'self');
    expect(coverage[0]).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(coverage[0]?.why).toBe(
      'no verdict counts yet: ISS-1 criterion 1: judged short: met short of its wording, and only a pass counts as verified',
    );
    expect(delivery).toMatchObject({
      phase: 'in_delivery',
      criteriaCoverage: { criteria: 1, passing: 0, judged: 0 },
    });
  });

  it('a short masks nothing: an older fail still stands', () => {
    const { coverage } = read(
      [row(1, 'fail', '2026-10-01T00:00:00Z'), row(2, 'short', '2026-10-05T00:00:00Z')],
      'self',
    );
    expect(coverage[0]).toMatchObject({ verdict: 'failing', counts: { displayId: 'ISS-1' } });
  });
});

describe("under independent QA the builder's own pass is not verified", () => {
  it('it reads not judged, names why on its line, and the independent judge is owed it', () => {
    const { live, coverage, delivery } = read([builder(1, 'pass', '2026-10-05T00:00:00Z')]);
    expect(coverage[0]).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(coverage[0]?.issues[0]?.notCounted).toBe(BUILDER_WHY);
    expect(delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 0, judged: 0 });
    expect(proofTurn('independent', live, coverage)?.waitingOn).toMatchObject({
      who: 'Independent judge',
      act: 'judge BC-1 on ISS-1',
    });
  });

  it("the BC-9 case: the builder's short and pass together count for nothing", () => {
    const { coverage } = read([
      builder(1, 'short', '2026-10-04T00:00:00Z'),
      builder(2, 'pass', '2026-10-05T00:00:00Z'),
    ]);
    expect(coverage[0]?.verdict).toBe('not_judged');
    expect(coverage[0]?.issues.map((l) => l.notCounted)).toEqual([
      'judged short: met short of its wording, and only a pass counts as verified',
      BUILDER_WHY,
    ]);
  });

  it("an independent pass counts though the builder's own pass is newer", () => {
    const { coverage, delivery } = read([
      row(1, 'pass', '2026-10-01T00:00:00Z'),
      builder(2, 'pass', '2026-10-05T00:00:00Z'),
    ]);
    expect(coverage[0]).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', verdict: 'pass' },
    });
    expect(delivery).toMatchObject({ phase: 'delivered', criteriaCoverage: { passing: 1 } });
  });

  it("the builder's own fail counts: it is evidence the criterion does not hold", () => {
    const { coverage } = read([
      row(1, 'pass', '2026-10-01T00:00:00Z'),
      builder(2, 'fail', '2026-10-05T00:00:00Z'),
    ]);
    expect(coverage[0]).toMatchObject({ verdict: 'failing', counts: { displayId: 'ISS-2' } });
  });

  it('under self QA, or no policy, the builder is the judge the project named and its pass counts', () => {
    const rows = [builder(1, 'pass', '2026-10-05T00:00:00Z')];
    expect(read(rows, 'self').coverage[0]?.verdict).toBe('passing');
    expect(read(rows, null).coverage[0]?.verdict).toBe('passing');
  });

  it("a builder's pass on a build the live one lacks is named for the build first", () => {
    const { coverage } = read([builder(1, 'pass', '2026-10-05T00:00:00Z', A)], 'independent', [
      [A, false],
    ]);
    expect(coverage[0]?.verdict).toBe('not_live');
    expect(coverage[0]?.issues[0]?.notCounted).toContain('does not hold');
  });
});
