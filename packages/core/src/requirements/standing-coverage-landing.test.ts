// The coverage rules of `standing-coverage.ts` on a landing, with no production environment: a
// pass at the head of the request that merged as the landing, and a pass the issue's reopen voided.
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  deriveStanding as deriveStanding_,
  type StandingIssue,
  type StandingIssueCriterion,
} from './standing.js';
import type { CoverageIdentity } from './standing-coverage.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const deriveStanding = ((...a: Parameters<typeof deriveStanding_>) =>
  checked(deriveStanding_(...a))) as typeof deriveStanding_;

const at = (iso: string) => new Date(iso);

const issue = (n: number, status: string, changedSincePlan: boolean): StandingIssue => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status,
  tone: 'neutral',
  updatedAt: at('2026-09-20T00:00:00Z'),
  closedAt: status === 'closed' ? at('2026-09-21T00:00:00Z') : null,
  changedSincePlan,
  parkedOn: null,
});

const input = (issues: StandingIssue[]) => ({
  status: 'agreed' as const,
  owner: { id: 'u1', name: 'Ba', kind: 'human' as const },
  viewer: null,
  revisions: [
    {
      revision: 3,
      state: 'current' as const,
      authorId: 'u1',
      authorName: 'Ba',
      authorKind: 'human' as const,
      authorAgency: 'human' as const,
      createdAt: at('2026-09-25T00:00:00Z'),
      proposedAt: at('2026-09-25T01:00:00Z'),
      decidedAt: at('2026-09-26T00:00:00Z'),
    },
  ],
  currentRevision: 3,
  criteria: [],
  issues,
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [],
  staleContractPins: [],
  unapprovedDesigns: [] as { flow: string; title: string; designStatus: string | null }[],
  feedback: { open: 0, untriaged: [] },
  judge: 'self' as 'self' | 'independent' | null,
  agreedAt: at('2026-09-01T00:00:00Z'),
  release: null,
  updatedAt: at('2026-09-26T00:00:00Z'),
  statusSince: at('2026-09-26T00:00:00Z'),
  master: 'serves' as const,
  now: at('2026-09-28T00:00:00Z'),
});

const bc1 = { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null };
const A = 'a'.repeat(40);
const F = 'f'.repeat(40);
const row = (
  issueN: number,
  verdict: 'pass' | 'short' | 'fail' | 'skipped' | null,
  iso: string | null,
  commit: string | null = null,
  wording = 'c1',
  identity: CoverageIdentity | null = verdict === null
    ? null
    : { kind: 'commit', sha: commit ?? F },
): StandingIssueCriterion => ({
  issueId: `i${issueN}`,
  n: 1,
  requirementCriterionId: wording,
  verdict,
  verdictAt: iso ? at(iso) : null,
  identity,
  byBuilder: false,
  authored: true,
  recordedAt: iso ? at(iso) : null,
});

// adminhub-api 2026-10-26: with no production environment a verdict counts on its issue's landing.
// A pass at the head of the request that merged as the landing counts there only where Forge read
// the two trees identical at the merge, and says so; a pass the issue's reopen voided reads as the
// pass it is, with why it does not count, never as no verdict (ISS-10 c1,3,4,6).
describe('coverage on a landing: the merged head and a voided pass', () => {
  const M = 'e'.repeat(40);
  const H = 'd'.repeat(40);
  const readAt = '2026-10-26T03:45:20.000Z';
  const onLanding = (
    rows: StandingIssueCriterion[],
    head: { treeIdentical: boolean | null; why: string | null } | null,
  ) =>
    deriveStanding({
      ...input([issue(1, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: rows,
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([
          ['i1', { sha: M, why: null, ...(head ? { head: { sha: H, readAt, ...head } } : {}) }],
        ]),
      },
    }).coverage[0];

  it('counts a pass at the merged head where the host showed its tree is the landing’s, saying so', () => {
    const c = onLanding([row(1, 'pass', '2026-10-26T04:00:00Z', H)], {
      treeIdentical: true,
      why: null,
    });
    expect(c?.verdict).toBe('passing');
    expect(c?.issues[0]?.notCounted).toBeNull();
    expect(c?.issues[0]?.identity).toBe(
      `judged at commit ${H.slice(0, 12)}, tree-identical to landing ${M.slice(0, 12)}`,
    );
  });

  it('does not count it where the host showed the trees differ, naming why', () => {
    const c = onLanding([row(1, 'pass', '2026-10-26T04:00:00Z', H)], {
      treeIdentical: false,
      why: null,
    });
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.notCounted).toContain('its tree differs from the landing');
  });

  it('does not count it where the trees were not read, naming why', () => {
    const c = onLanding([row(1, 'pass', '2026-10-26T04:00:00Z', H)], {
      treeIdentical: null,
      why: 'GitLab answered 503',
    });
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.notCounted).toContain('was not read (GitLab answered 503)');
  });

  it('does not count a pass at another commit with no merged head on record', () => {
    const c = onLanding([row(1, 'pass', '2026-10-26T04:00:00Z', H)], null);
    expect(c?.issues[0]?.notCounted).toContain(`not at its issue's landing ${M.slice(0, 12)}`);
  });

  it('shows a pass the reopen voided as that pass, not counted at another commit, never as no verdict', () => {
    const voided: StandingIssueCriterion = {
      ...row(1, null, null),
      beforeReopen: {
        verdict: 'pass',
        verdictAt: at('2026-10-25T00:00:00Z'),
        identity: { kind: 'commit', sha: A },
        byBuilder: false,
        authored: true,
        recordedAt: at('2026-10-25T00:00:00Z'),
      },
    };
    const c = onLanding([voided], null);
    expect(c?.issues[0]?.verdict).toBe('pass');
    expect(c?.issues[0]?.notCounted).toContain(`not at its issue's landing ${M.slice(0, 12)}`);
    expect(c?.verdict).not.toBe('passing');
  });
});

// adminhub-fe ISS-36, 2026-10-26: a judge passed every criterion at the landing d2dd9863; at 10:07 the
// steward's follow-through recorded a runtime pass on each, on a project with no production
// environment, and REQ-3 read 2 criteria covered, 0 passing. A runtime verdict nothing places on a
// build never hides an older verdict that counts; a fail is everyone's and is never set aside.
describe('a runtime verdict nothing places on a build', () => {
  const M = 'e'.repeat(40);
  const later = (
    verdict: 'pass' | 'fail',
    older: StandingIssueCriterion,
  ): StandingIssueCriterion => ({
    ...older,
    verdict,
    verdictAt: at('2026-10-26T10:07:16Z'),
    recordedAt: at('2026-10-26T10:07:16Z'),
    identity: { kind: 'runtime', ref: M },
    earlier: [older],
  });
  const landedAt = (rows: StandingIssueCriterion[]) =>
    deriveStanding({
      ...input([issue(1, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: rows,
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([['i1', { sha: M, why: null }]]),
      },
    }).coverage[0];

  it("keeps the judge's pass at the landing counting under a later runtime pass", () => {
    const c = landedAt([later('pass', row(1, 'pass', '2026-10-26T09:54:57Z', M))]);
    expect(c?.verdict).toBe('passing');
    expect(c?.counts).toMatchObject({ verdict: 'pass', at: '2026-10-26T09:54:57.000Z' });
  });

  it('reads the runtime pass, not counted and saying why, where nothing else was recorded', () => {
    const only = {
      ...row(1, 'pass', '2026-10-26T10:07:16Z'),
      identity: { kind: 'runtime', ref: M },
    } as const;
    const c = landedAt([only]);
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.notCounted).toContain('not a commit');
  });

  it('never sets a runtime fail aside: the pass before it does not count again', () => {
    const c = landedAt([later('fail', row(1, 'pass', '2026-10-26T09:54:57Z', M))]);
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.verdict).toBe('fail');
  });

  it('sets aside a runtime no release Forge verified served, and never one whose read failed', () => {
    const R = 'b'.repeat(40);
    const withLive = (served: string | null | undefined) =>
      deriveStanding({
        ...input([issue(1, 'closed', false)]),
        criteria: [bc1],
        issueCriteria: [
          {
            ...later('pass', row(1, 'pass', '2026-10-26T09:54:57Z', M)),
            identity: { kind: 'runtime', ref: R },
          },
        ],
        liveBuild: {
          sha: M,
          holds: new Map([[M, true]]),
          runtimes: new Map(served === undefined ? [] : [[R, served]]),
          unanswered: new Map(),
        },
      }).coverage[0];
    expect(withLive(null)?.verdict).toBe('passing');
    // an outage reads as unchecked, never as passing (`VISION: state-never-lies`)
    expect(withLive(undefined)?.verdict).not.toBe('passing');
  });
});

// catalog-api ISS-12, 2026-10-27: delivery.judgedOn = "dev" and no production environment. A judge
// passed all six criteria on dev at the landing 307f35d8 (runtime identity, the whole commit), and
// the record door recorded 0.3.0 on them ("every live criterion (6) stands on a pass judged at
// 307f35d8"), yet REQ-3 read judged 0 / passing 0: coverage set every runtime verdict aside on a
// landed project, so it stood on the builder's older commit pass at 5bb85413. One rule
// (contracts `landedCommitOf`) says what commit a verdict names on a landing, for both.
describe('a runtime pass on the testing environment the project is judged on (delivery.judgedOn)', () => {
  const L = '307f35d820bb5cb74a0f53954aaed97df036431a';
  const B = '5bb85413ef'.padEnd(40, '0');
  const onDev = (rows: StandingIssueCriterion[], judgedOn: string | null) =>
    deriveStanding({
      ...input([issue(12, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: rows,
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([['i12', { sha: L, why: null }]]),
        judgedOn,
      },
    }).coverage[0];
  const judged = (ref: string): StandingIssueCriterion => ({
    ...row(12, 'pass', '2026-10-27T08:34:08Z'),
    identity: { kind: 'runtime', ref },
    earlier: [{ ...row(12, 'pass', '2026-10-27T08:05:17Z', B), byBuilder: true }],
  });

  it('counts the pass judged on dev at the landing commit, as the record door does', () => {
    const c = onDev([judged(L)], 'dev');
    expect(c?.verdict).toBe('passing');
    expect(c?.counts).toMatchObject({ verdict: 'pass', at: '2026-10-27T08:34:08.000Z' });
  });

  it('does not count one judged on dev at another commit, naming the landing', () => {
    const c = onDev([judged(B)], 'dev');
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.notCounted).toContain(`not at its issue's landing ${L.slice(0, 12)}`);
  });

  it('still sets it aside where the project names no testing environment', () => {
    const c = onDev([judged(L)], null);
    expect(c?.verdict).not.toBe('passing');
    expect(c?.issues[0]?.notCounted).toContain(`not at its issue's landing ${L.slice(0, 12)}`);
  });
});

// adminhub-fe ISS-4, dev.344 (REQ-36 BC-18): landed at 5841cc20 on release/stg and recorded 0.1.0;
// every criterion's latest verdict a runtime pass judged on stg, the testing environment, serving
// f9ed575a, which holds the landing. REQ-1 read "judge BC-1 on ISS-4": coverage counted a verdict
// only at the landing itself. A pass on a later build that holds the landing is a pass on the
// delivered work; one at a build that does not hold it never counts, and an unread hold is unchecked.
describe('a pass on a later build that holds the landing', () => {
  const L = '5841cc20'.padEnd(40, '1');
  const S = 'f9ed575a'.padEnd(40, '2');
  const onStg = (holders: ReadonlyMap<string, boolean | { unread: string }> | undefined) =>
    deriveStanding({
      ...input([issue(4, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: [
        { ...row(4, 'pass', '2026-10-27T09:00:00Z'), identity: { kind: 'runtime', ref: S } },
      ],
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([['i4', { sha: L, why: null, ...(holders ? { holders } : {}) }]]),
        judgedOn: 'stg',
      },
    }).coverage[0];

  it('counts the runtime pass on stg at a commit holding the landing, saying it holds it', () => {
    const c = onStg(new Map([[S, true]]));
    expect(c?.verdict).toBe('passing');
    expect(c?.issues[0]?.notCounted).toBeNull();
    expect(c?.issues[0]?.identity).toBe(
      `judged at commit ${S.slice(0, 12)}, which holds landing ${L.slice(0, 12)}`,
    );
  });

  it('counts a commit pass at a later build holding the landing the same way', () => {
    const c = deriveStanding({
      ...input([issue(4, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: [row(4, 'pass', '2026-10-27T09:00:00Z', S)],
      liveBuild: {
        sha: null,
        holds: new Map(),
        runtimes: new Map(),
        unanswered: new Map(),
        landed: new Map([['i4', { sha: L, why: null, holders: new Map([[S, true]]) }]]),
      },
    }).coverage[0];
    expect(c?.verdict).toBe('passing');
  });

  it('never counts a pass at a commit that does not hold the landing, naming it', () => {
    const c = onStg(new Map([[S, false]]));
    expect(c?.verdict).toBe('not_live');
    expect(c?.issues[0]?.notCounted).toBe(
      `judged at commit ${S.slice(0, 12)}, not at its issue's landing ${L.slice(0, 12)} nor at a build that holds it: judge it again at ${L.slice(0, 12)} or at a later build that holds it`,
    );
  });

  it('reads an unread hold as unchecked, never as passing nor as another build', () => {
    const c = onStg(new Map([[S, { unread: 'GitLab answered 503' }]]));
    expect(c?.verdict).toBe('not_judged');
    expect(c?.issues[0]?.inLiveBuild).toBeNull();
    expect(c?.issues[0]?.notCounted).toContain(
      `whether it holds that landing could not be read: GitLab answered 503`,
    );
  });
});
