// The move into delivery is never asked while its own gate would refuse it (ISS-1084, FB-561):
// agenfold REQ-18 read as waiting on the master to start delivery while its check was owed.
// @direct-test-of packages/core/src/requirements/standing-held.ts
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding as deriveStanding_, type StandingIssue } from './standing.js';

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

describe('an agreed requirement whose issues shipped and whose criteria all pass', () => {
  const bc = (n: number) => ({
    id: `c${n}`,
    code: `BC-${n}`,
    body: `rule ${n}`,
    sinceRevision: 1,
    retiredRevision: null,
  });
  const traced = (issue: number, bcN: number, verdict: 'pass' | 'fail' | null) => ({
    issueId: `i${issue}`,
    n: bcN,
    requirementCriterionId: `c${bcN}`,
    verdict,
    verdictAt: verdict ? at('2026-09-22T00:00:00Z') : null,
    identity: verdict ? ({ kind: 'commit', sha: 'f'.repeat(40) } as const) : null,
    byBuilder: false,
    authored: true,
    recordedAt: verdict ? at('2026-09-22T00:00:00Z') : null,
  });
  /** The live build, read to hold the commit every verdict here names: only a checked one counts. */
  const liveBuild = {
    sha: 'f'.repeat(40),
    holds: new Map([['f'.repeat(40), true]]),
    runtimes: new Map(),
    unanswered: new Map(),
  };
  // ISS-1084 (FB-561, agenfold REQ-18): the move into delivery is never asked while its gate
  // would refuse it; the standing names the act that clears the gate instead, at its door
  const held = (deliveryHold: { questions: number; person: boolean; unchecked: boolean }) =>
    deriveStanding({
      ...input([issue(1, 'closed', false), issue(2, 'closed', false)]),
      criteria: [bc(1), bc(3), bc(5)],
      issueCriteria: [traced(1, 1, 'pass'), traced(1, 3, 'pass'), traced(2, 5, 'pass')],
      judge: 'independent',
      liveBuild,
      deliveryHold,
    });

  it('never asks the move into delivery while a question about it stands open: the master answers it', () => {
    const s = held({ questions: 2, person: false, unchecked: true });
    expect(s.waitingOn.act).not.toBe('move it into delivery');
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: 'answer 2 questions' });
    expect(s.waitingOn.rule).toContain('POST /api/questions/:id/answer');
  });

  it("a question a person owes is that person's to answer", () => {
    const s = held({ questions: 1, person: true, unchecked: false });
    expect(s.waitingOn.act).toBe('answer its question');
    expect(s.waitingOn.who).not.toBe('Master');
  });

  it("never asks the move while the steward's check is owed: it waits on the steward, naming its runs", () => {
    const s = held({ questions: 0, person: false, unchecked: true });
    expect(s.waitingOn).toMatchObject({ who: 'Steward', act: 'finish its check' });
    expect(s.waitingOn.rule).toContain('steward-runs?subject=');
  });

  it('asks the move once nothing of the check holds it', () => {
    expect(held({ questions: 0, person: false, unchecked: false }).waitingOn.act).toBe(
      'move it into delivery',
    );
  });
});
