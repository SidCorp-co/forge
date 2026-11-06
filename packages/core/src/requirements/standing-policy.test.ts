/**
 * A requirement's turn reads the project's real policy (ISS-1068): re-pinning a requirement to the
 * approved design is the master's unless the project's gate asks a person (`whoOwes`), and a
 * criterion's verdict on a project whose release asks none is cleanup the audit reads, never a
 * delivery wait that falls overdue and reads the requirement stuck (REQ-79 r6).
 *
 * @direct-test-of packages/core/src/requirements/standing.ts
 * @direct-test-of packages/core/src/lib/standing-times.ts
 */

import { saidDisagreements } from '@forge/contracts/said';
import type { OwedPolicy } from '@forge/contracts/who-owes';
import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingInput, type StandingIssue } from './standing.js';

const at = (iso: string) => new Date(iso);

const gatesOff: OwedPolicy['gates'] = {
  admit: false,
  triage: false,
  agree: false,
  revisions: false,
  breakdown: false,
  accept: false,
  designs: false,
} as OwedPolicy['gates'];
const routine: OwedPolicy = { strict: false, gates: gatesOff, releaseApproval: false };
const revisionsGate: OwedPolicy = { ...routine, gates: { ...gatesOff, revisions: true } };

const base = (over: Partial<StandingInput> = {}): StandingInput => ({
  status: 'agreed',
  owner: { id: 'u1', name: 'orchestrator', kind: 'human' },
  viewer: { userId: 'u2', canWrite: true, canSignOff: true },
  revisions: [
    {
      revision: 1,
      state: 'current',
      authorId: 'u1',
      authorName: 'orchestrator',
      authorKind: 'human',
      authorAgency: 'human',
      createdAt: at('2026-10-01T00:00:00Z'),
      proposedAt: null,
      decidedAt: null,
    },
  ],
  currentRevision: 1,
  criteria: [],
  issues: [],
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [{ flow: 'issue-to-release', title: 'Issue to release', pinned: 24, approved: 25 }],
  staleContractPins: [],
  unapprovedDesigns: [],
  feedback: { open: 0, untriaged: [] },
  judge: 'self',
  agreedAt: at('2026-10-01T00:00:00Z'),
  release: null,
  updatedAt: at('2026-10-20T00:00:00Z'),
  statusSince: at('2026-10-20T00:00:00Z'),
  master: 'serves',
  owed: routine,
  verdictsRequired: false,
  now: at('2026-11-07T00:00:00Z'),
  ...over,
});

const turn = (input: StandingInput) => {
  const s = deriveStanding(input);
  expect(saidDisagreements(s)).toEqual([]);
  return s;
};

describe('a requirement pinned behind an approved design', () => {
  it("is the master's to re-pin where no gate asks a person, and leaves the signer's Needs you", () => {
    const s = turn(base());
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.waitingOn.who).toBe('Master');
    expect(s.waitingOn.who).not.toBe('orchestrator');
  });

  it("stays a person's where the project's revisions gate asks one", () => {
    const s = turn(base({ owed: revisionsGate }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toContain('Update to the approved design');
  });
});

describe('a shipped requirement whose criteria hold no verdict', () => {
  const issue: StandingIssue = {
    id: 'i1',
    displayId: 'ISS-1',
    title: 'Issue 1',
    status: 'closed',
    tone: 'neutral',
    updatedAt: at('2026-10-20T00:00:00Z'),
    closedAt: at('2026-10-21T00:00:00Z'),
    changedSincePlan: false,
    parkedOn: null,
  };
  const shipped = (verdictsRequired: boolean) =>
    turn(
      base({
        stalePins: [],
        criteria: [
          { id: 'c1', code: 'BC-1', body: 'rule', sinceRevision: 1, retiredRevision: null },
        ],
        issues: [issue],
        issueCriteria: [
          {
            issueId: 'i1',
            n: 1,
            requirementCriterionId: 'c1',
            verdict: null,
            verdictAt: null,
            identity: null,
            byBuilder: false,
            authored: true,
            recordedAt: null,
          },
        ],
        verdictsRequired,
      }),
    );

  it('reads a judgement owed as cleanup, never stuck overdue, where the release asks no verdict', () => {
    const s = shipped(false);
    expect(s.waitingOn.act).toMatch(/judge BC-1/);
    expect(s.times.dueAt).toBeNull();
    expect(s.times.stuck).toBeNull();
    expect(s.attentionGroup).not.toBe('stuck');
  });

  it('still falls due where the project requires verdicts before a release', () => {
    const s = shipped(true);
    expect(s.times.stuck?.code).toBe('overdue');
  });
});
