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
