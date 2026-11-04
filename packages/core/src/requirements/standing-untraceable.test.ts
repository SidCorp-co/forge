// @direct-test-of packages/core/src/requirements/standing-proof.ts
// @direct-test-of packages/core/src/lib/standing-act-class.ts
// FB-209: every issue linked to a requirement had shipped, and a BC its later revision added was
// traced by none of them. The standing asked the master to "trace" it, but no route can: a criterion
// proves a BC of its own issue's requirement, and no linked issue was built for that BC. Where no
// linked issue can carry the BC, the act named is the one that can be done.
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { actClassOf } from '../lib/standing-act-class.js';
import { deriveStanding, type StandingInput, type StandingIssue } from './standing.js';

const at = (iso: string) => new Date(iso);

/** A revision of the requirement, accepted on `decided`. */
const revision = (n: number, state: 'current' | 'superseded', decided: string) => ({
  revision: n,
  state,
  authorId: 'u1',
  authorName: 'Ba',
  authorKind: 'human' as const,
  authorAgency: 'human' as const,
  createdAt: at(decided),
  proposedAt: at(decided),
  decidedAt: at(decided),
});

/** ISS-<n>, closed on 09-21, planned against `planned` (null: it records none). */
const shipped = (n: number, planned: number | null): StandingIssue => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status: 'closed',
  tone: 'neutral',
  updatedAt: at('2026-09-21T00:00:00Z'),
  closedAt: at('2026-09-21T00:00:00Z'),
  changedSincePlan: false,
  plannedRevision: planned,
  parkedOn: null,
});

/** BC-<n>, live from revision `since`. */
const bc = (n: number, since = 1) => ({
  id: `c${n}`,
  code: `BC-${n}`,
  body: `rule ${n}`,
  sinceRevision: since,
  retiredRevision: null,
});

/** ISS-<issue>'s criterion tracing BC-<n>, passing on the commit the live build holds. */
const passing = (issue: number, n: number) => ({
  issueId: `i${issue}`,
  n,
  requirementCriterionId: `c${n}`,
  verdict: 'pass' as const,
  verdictAt: at('2026-09-22T00:00:00Z'),
  identity: { kind: 'commit', sha: 'f'.repeat(40) } as const,
  byBuilder: false,
  authored: true,
  recordedAt: at('2026-09-22T00:00:00Z'),
});

const SHA = 'f'.repeat(40);

/** ISS-1 and ISS-2 shipped and passing BC-1 and BC-3; r3, current since 09-26, holds `criteria`. */
function standing(
  issues: StandingIssue[],
  criteria: ReturnType<typeof bc>[],
  revisions: StandingInput['revisions'] = [revision(3, 'current', '2026-09-26T00:00:00Z')],
) {
  const s = deriveStanding({
    status: 'agreed',
    owner: { id: 'u1', name: 'Ba', kind: 'human' },
    viewer: null,
    revisions,
    currentRevision: 3,
    criteria,
    issues,
    issueCriteria: [passing(1, 1), passing(2, 3)],
    openSuggestionKinds: [],
    stalePins: [],
    staleContractPins: [],
    unapprovedDesigns: [],
    feedback: { open: 0, untriaged: [] },
    judge: 'independent',
    liveBuild: {
      sha: SHA,
      holds: new Map([[SHA, true]]),
      runtimes: new Map(),
      unanswered: new Map(),
    },
    agreedAt: at('2026-09-01T00:00:00Z'),
    release: null,
    updatedAt: at('2026-09-26T00:00:00Z'),
    statusSince: at('2026-09-26T00:00:00Z'),
    master: 'serves',
    now: at('2026-09-28T00:00:00Z'),
  });
  expect(saidDisagreements(s)).toEqual([]);
  return s;
}

const FILE_OR_REVISE = 'file an issue for BC-5, or revise the requirement';

describe('a BC no linked issue was built for', () => {
  it('asks the master to file an issue for it or revise the requirement, never to trace it', () => {
    const s = standing([shipped(1, 2), shipped(2, 2)], [bc(1), bc(3), bc(5, 3)]);
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: FILE_OR_REVISE });
    expect(s.waitingOn.act).not.toContain('trace');
    expect(s.waitingOn.rule).toContain('no issue criterion traces to BC-5');
    // the master plans it, as it planned the trace
    expect(actClassOf(s.waitingOn)).toBe('master_plan');
  });

  it('reads an issue that records no planned revision at the head when it closed', () => {
    const unplanned = [shipped(1, null), shipped(2, null)];
    const criteria = [bc(1), bc(3), bc(5, 3)];
    // both closed on 09-21, when r2 was the head: r3 added BC-5 on 09-26, after them
    const r2then3 = [
      revision(2, 'superseded', '2026-09-10T00:00:00Z'),
      revision(3, 'current', '2026-09-26T00:00:00Z'),
    ];
    expect(standing(unplanned, criteria, r2then3).waitingOn.act).toBe(FILE_OR_REVISE);
    // with nothing accepted by then, it reads at the current revision, which holds BC-5
    expect(standing(unplanned, criteria).waitingOn.act).toBe('trace BC-5 to an issue criterion');
  });
});

describe('a BC a linked issue was built for', () => {
  it('keeps the trace ask where a linked issue was planned at a revision holding it', () => {
    const s = standing([shipped(1, 2), shipped(2, 3)], [bc(1), bc(3), bc(5, 3)]);
    expect(s.waitingOn.act).toBe('trace BC-5 to an issue criterion');
  });

  it('asks the trace first where some gaps can be traced, naming only those', () => {
    const s = standing([shipped(1, 2), shipped(2, 2)], [bc(1), bc(3), bc(4, 2), bc(5, 3)]);
    expect(s.waitingOn.act).toBe('trace BC-4 to an issue criterion');
    expect(s.waitingOn.rule).toContain('no issue criterion traces to BC-4, BC-5');
  });
});
