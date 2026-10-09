// The coverage rules of `standing-coverage.ts`, read through the standing that carries them: which
// verdict a business criterion counts, and what each verdict identity counts for.
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  deriveStanding as deriveStanding_,
  type LiveBuildHolds,
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
  now: at('2026-09-28T00:00:00Z'),
});

// coverage-truth: a BC used to pass only where EVERY row tracing it passed, so one unjudged row or
// one old fail anywhere held it for good; the newest judgement on a build the live one is not read
// to lack now decides, and the BC names it
describe('the verdict a business criterion counts', () => {
  const bc1 = { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null };
  const old1 = { id: 'c0', code: 'BC-1', body: 'rule 1 r1', sinceRevision: 1, retiredRevision: 2 };
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
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
  });
  const read = (
    rows: StandingIssueCriterion[],
    liveBuild: Map<string, boolean> | null = null,
    runtimes: Map<string, string | null> = new Map(),
  ) =>
    deriveStanding({
      ...input([issue(1, 'closed', false), issue(2, 'closed', false), issue(3, 'closed', false)]),
      criteria: [old1, bc1],
      issueCriteria: rows,
      liveBuild: liveBuild ? { sha: 'c'.repeat(40), holds: liveBuild, runtimes } : null,
    }).coverage[0];

  it('an older fail and an unjudged row do not outvote a newer pass, and the pass is named', () => {
    const c = read([
      row(1, 'fail', '2026-10-01T00:00:00Z', A),
      row(2, 'pass', '2026-10-05T00:00:00Z', B),
      row(3, null, null),
    ]);
    expect(c?.verdict).toBe('passing');
    expect(c?.counts).toEqual({
      issueId: 'i2',
      displayId: 'ISS-2',
      criterion: 1,
      verdict: 'pass',
      at: '2026-10-05T00:00:00.000Z',
      identity: `commit ${B.slice(0, 12)}`,
      commit: B,
      inLiveBuild: null,
    });
  });

  it('a fail stands while it is the newest; could-not-judge masks nothing', () => {
    const c = read([
      row(1, 'pass', '2026-10-01T00:00:00Z'),
      row(2, 'fail', '2026-10-05T00:00:00Z'),
      row(3, 'skipped', '2026-10-07T00:00:00Z'),
    ]);
    expect(c?.verdict).toBe('failing');
    expect(c?.counts?.displayId).toBe('ISS-2');
  });

  it('a verdict at a commit the live build lacks never counts: the newest one it holds does', () => {
    const c = read(
      [row(1, 'pass', '2026-10-01T00:00:00Z', A), row(2, 'fail', '2026-10-05T00:00:00Z', B)],
      new Map([
        [A, true],
        [B, false],
      ]),
    );
    expect(c?.verdict).toBe('passing');
    expect(c?.counts).toMatchObject({ displayId: 'ISS-1', inLiveBuild: true });
    expect(c?.issues.map((l) => [l.displayId, l.inLiveBuild])).toEqual([
      ['ISS-1', true],
      ['ISS-2', false],
    ]);
  });

  // ISS-489 r2: "Stale" meant both an earlier wording and a build the live one lacks, its reason
  // only inside the evidence; each now has its own word and its reason on the criterion
  it('judged only at commits the live build lacks reads not live, naming why on the criterion', () => {
    const c = read([row(1, 'pass', '2026-10-01T00:00:00Z', A)], new Map([[A, false]]));
    expect(c).toMatchObject({ verdict: 'not_live', counts: null });
    expect(c?.why).toBe(
      `judged only at builds the live one does not hold (ISS-1 criterion 1: commit ${A.slice(0, 12)}): judge it again on the live build`,
    );
    expect(c?.issues[0]?.notCounted).toBe(
      `judged at commit ${A.slice(0, 12)}, which the live build (cccccccccccc) does not hold`,
    );
  });

  it('a commit nobody answered is judged neither way and still counts', () => {
    const c = read([row(1, 'pass', '2026-10-01T00:00:00Z', A)], new Map());
    expect(c).toMatchObject({ verdict: 'passing', counts: { inLiveBuild: null } });
  });

  it('traced only at an earlier wording reads stale, naming the re-tie on the criterion', () => {
    const c = read([row(1, 'pass', '2026-10-05T00:00:00Z', A, 'c0')]);
    expect(c).toMatchObject({ verdict: 'stale', counts: null });
    expect(c?.why).toBe(
      "ISS-1 trace only an earlier wording of this criterion, so no verdict on them counts: tie it again from the issue's Criteria tab, then judge it",
    );
  });

  it('a pass on the earlier wording counts for nothing on the current one', () => {
    const c = read([row(1, 'pass', '2026-10-05T00:00:00Z', A, 'c0'), row(2, null, null)]);
    expect(c).toMatchObject({ verdict: 'not_judged', counts: null });
  });

  it('a BC traced only on an earlier wording waits on the judge to tie those issues again, not to judge them', () => {
    const s = deriveStanding({
      ...input([issue(1, 'closed', false), issue(2, 'closed', false)]),
      criteria: [old1, bc1],
      issueCriteria: [row(1, 'pass', '2026-10-05T00:00:00Z', A, 'c0')],
      judge: 'independent',
    });
    expect(s.coverage[0]?.verdict).toBe('stale');
    expect(s.waitingOn).toMatchObject({
      who: 'Independent judge',
      act: 'tie ISS-1 to the current wording of BC-1, then judge it',
    });
  });

  it('a BC judged only on another build waits on the judge to judge the issue on the live one', () => {
    const s = deriveStanding({
      ...input([issue(1, 'closed', false)]),
      criteria: [old1, bc1],
      issueCriteria: [row(1, 'pass', '2026-10-05T00:00:00Z', A)],
      liveBuild: { sha: 'c'.repeat(40), holds: new Map([[A, false]]), runtimes: new Map() },
      judge: 'independent',
    });
    expect(s.coverage[0]?.verdict).toBe('not_live');
    expect(s.waitingOn).toMatchObject({ who: 'Independent judge' });
    expect(s.waitingOn.act).toContain('ISS-1');
  });
});

// ISS-489 r2: a verdict whose identity was not a commit reached coverage with commit null, so it was
// never checked against anything and a pass counted. Every identity kind now resolves to what a rule
// checks or is named as not counting.
describe('what a verdict identity counts for on coverage', () => {
  const bc1 = { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null };
  const R = '8'.repeat(40);
  const one = (identity: CoverageIdentity | null, liveBuild: LiveBuildHolds | null = null) =>
    deriveStanding({
      ...input([issue(1, 'closed', false)]),
      criteria: [bc1],
      issueCriteria: [
        {
          issueId: 'i1',
          n: 2,
          requirementCriterionId: 'c1',
          verdict: 'pass',
          verdictAt: at('2026-10-05T00:00:00Z'),
          identity,
        },
      ],
      liveBuild,
    }).coverage[0];
  const live = (holds: [string, boolean][], runtimes: [string, string | null][]) => ({
    sha: 'c'.repeat(40),
    holds: new Map(holds),
    runtimes: new Map(runtimes),
  });

  it('a runtime counts at the commit it served, where the live build holds it', () => {
    const c = one({ kind: 'runtime', ref: R }, live([[R, true]], [[R, R]]));
    expect(c).toMatchObject({ verdict: 'passing', why: null });
    expect(c?.counts).toMatchObject({
      identity: `runtime ${R.slice(0, 12)}`,
      commit: R,
      inLiveBuild: true,
    });
  });

  it('a runtime at a build the live one lacks does not count, and says so', () => {
    const c = one({ kind: 'runtime', ref: R }, live([[R, false]], [[R, R]]));
    expect(c).toMatchObject({ verdict: 'not_live', counts: null });
    expect(c?.issues[0]?.notCounted).toBe(
      `judged at runtime ${R.slice(0, 12)}, which served commit ${R.slice(0, 12)}, which the live build (cccccccccccc) does not hold`,
    );
  });

  it('a runtime nothing resolves to a commit does not count, and says so', () => {
    const digest = 'd'.repeat(64);
    const c = one({ kind: 'runtime', ref: digest }, live([], [[digest, null]]));
    expect(c).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(c?.issues[0]).toMatchObject({ commit: null, inLiveBuild: null });
    expect(c?.issues[0]?.notCounted).toMatch(
      /is not a commit and no release Forge verified served it/,
    );
    expect(c?.why).toMatch(
      /^no verdict counts yet: ISS-1 criterion 2: runtime d{12} is not a commit/,
    );
    expect(one({ kind: 'runtime', ref: R }, null)?.issues[0]?.notCounted).toMatch(
      /could not be resolved to the build it served/,
    );
  });

  it('a design counts only at the revision the baseline pins', () => {
    const at14 = one({ kind: 'design', workflow: 'issue-lifecycle', revision: 14, pinned: 14 });
    expect(at14).toMatchObject({
      verdict: 'passing',
      counts: { identity: 'design issue-lifecycle rev 14', commit: null },
    });
    const at13 = one({ kind: 'design', workflow: 'issue-lifecycle', revision: 13, pinned: 14 });
    expect(at13).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(at13?.issues[0]?.notCounted).toBe(
      "judged against design issue-lifecycle rev 13, and the requirement's latest baseline pins rev 14",
    );
    const unpinned = one({ kind: 'design', workflow: 'other', revision: 2, pinned: null });
    expect(unpinned?.issues[0]?.notCounted).toMatch(
      /which the requirement's latest baseline does not pin$/,
    );
  });

  it('a contract counts only at the version the baseline pins', () => {
    const pinned = one({ kind: 'contract', ref: 'forge/api', version: '1.2.0', pinned: '1.2.0' });
    expect(pinned).toMatchObject({
      verdict: 'passing',
      counts: { identity: 'contract forge/api@1.2.0' },
    });
    const other = one({ kind: 'contract', ref: 'forge/api', version: '1.1.0', pinned: '1.2.0' });
    expect(other).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(other?.issues[0]?.notCounted).toBe(
      "judged against contract forge/api@1.1.0, and the requirement's latest baseline pins 1.2.0",
    );
  });

  it('a storefront draft, a backfilled abbreviation and no identity at all never count', () => {
    for (const identity of [
      {
        kind: 'storefront_draft',
        workflowId: 'wf1',
        draftVersion: 'v9',
        environment: 'preview',
      } as const,
      { kind: 'commit_unresolved', sha: 'abc1234' } as const,
      null,
    ]) {
      const c = one(identity);
      expect(c).toMatchObject({ verdict: 'not_judged', counts: null });
      expect(c?.issues[0]?.notCounted).not.toBeNull();
    }
  });
});
