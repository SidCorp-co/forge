// ISS-1018 (FB-524, sidcorp-mail): where the release weighs at what is served, an issue's verdict the
// live build does not hold is weighed at its issue's landing too (`standing-identity.ts:orAtLanding`),
// and where neither counts, the criterion names both readings and what would count, and its turn
// names that reason instead of asking for the same judgement again (`standing-proof.ts:judgedUncounted`).
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

const M = '2'.repeat(40); // ISS-8's landing, 286764e
const C = 'c'.repeat(40); // mta1's build a2fb071, a landing Forge recorded after M
const P = '9'.repeat(40); // what production serves, f3afc54
const U = 'b'.repeat(40); // a build nothing places

/** The live build serving P, holding neither verdict commit, and ISS-1's landing M as recorded. */
const served = (holders: Record<string, true | { unread: string }>, landings = true) => ({
  sha: P,
  holds: new Map([
    [C, false],
    [U, false],
  ]),
  runtimes: new Map([[C, C]]),
  unanswered: new Map<string, string>(),
  ...(landings
    ? {
        landings: new Map([
          ['i1', { sha: M, why: null, holders: new Map(Object.entries(holders)) }],
        ]),
      }
    : {}),
});

const read = (
  rows: StandingIssueCriterion[],
  live: ReturnType<typeof served>,
  issues = [issue(1, 'closed', false)],
) =>
  deriveStanding({
    ...input(issues),
    criteria: [bc1],
    issueCriteria: rows,
    liveBuild: live,
  });

describe('a verdict the live build does not hold, weighed at its issue landing (ISS-1018)', () => {
  it('counts a pass at a build Forge recorded holding the landing, saying so', () => {
    const s = read([row(1, 'pass', '2026-11-05T00:00:00Z', C)], served({ [C]: true }));
    expect(s.coverage[0]).toMatchObject({ verdict: 'passing', why: null });
    expect(s.coverage[0]?.issues[0]).toMatchObject({
      notCounted: null,
      inLiveBuild: true,
      identity: `judged at commit ${C.slice(0, 12)}, which holds landing ${M.slice(0, 12)}`,
    });
    expect(s.delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 1, judged: 1 });
  });

  it('counts a runtime pass by the commit it served, as a commit there would', () => {
    const s = read(
      [row(1, 'pass', '2026-11-05T00:00:00Z', null, 'c1', { kind: 'runtime', ref: C })],
      served({ [C]: true }),
    );
    expect(s.coverage[0]?.verdict).toBe('passing');
  });

  it('counts a pass at the landing itself, though production does not hold it', () => {
    const s = read([row(1, 'pass', '2026-11-05T00:00:00Z', M)], {
      ...served({}),
      holds: new Map([[M, false]]),
    });
    expect(s.coverage[0]?.issues[0]).toMatchObject({
      notCounted: null,
      identity: `judged at commit ${M.slice(0, 12)}, its issue's landing`,
    });
  });

  it('names both readings and what would count where neither holds, and the turn names that reason', () => {
    const unread = {
      unread: `no merge mark records a landing at ${U.slice(0, 12)}, so nothing on record says it holds ${M.slice(0, 12)}; a landing recorded there would`,
    };
    const s = read([row(1, 'pass', '2026-11-05T00:00:00Z', U)], served({ [U]: unread }));
    const why = s.coverage[0]?.issues[0]?.notCounted ?? '';
    expect(s.coverage[0]?.verdict).toBe('not_live');
    expect(why).toContain(`which the live build (${P.slice(0, 12)}) does not hold`);
    expect(why).toContain(`nor does it count at its issue's landing`);
    expect(why).toContain(unread.unread);
    expect(why).toContain(
      `judge it again on the live build or at ${M.slice(0, 12)}, its issue's landing`,
    );
    expect(s.coverage[0]?.why).toBe(
      `judged only at builds the live one does not hold, nor counted at their issue's landing: ISS-1 criterion 1: ${why}`,
    );
    expect(s.waitingOn.says.act.key).toBe('standing.act.uncounted');
    expect(s.waitingOn.act).toBe(`BC-1 count on no build: ${s.coverage[0]?.why}`);
  });

  it('still asks the judge where a link holds no judgement yet', () => {
    const s = read(
      [row(1, 'pass', '2026-11-05T00:00:00Z', U), { ...row(2, null, null), issueId: 'i2' }],
      served({ [U]: { unread: 'no record' } }),
      [issue(1, 'closed', false), issue(2, 'closed', false)],
    );
    expect(s.waitingOn.says.act.key).toBe('standing.act.judgeOn');
  });

  it('reads the live build alone where no landing was asked, as before', () => {
    const s = read([row(1, 'pass', '2026-11-05T00:00:00Z', C)], served({}, false));
    expect(s.coverage[0]?.verdict).toBe('not_live');
    expect(s.coverage[0]?.issues[0]?.notCounted).toBe(
      `judged at commit ${C.slice(0, 12)}, which the live build (${P.slice(0, 12)}) does not hold`,
    );
  });
});
