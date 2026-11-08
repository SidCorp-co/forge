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
  // D3 (owner 2026-11-08): no traced step changed, so Forge re-pins by rule; nobody is asked to
  it('is re-pinned by rule where no gate asks a person, off every Needs you', () => {
    const s = turn(base());
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.waitingOn.who).toBe('Forge');
    expect(s.waitingOn.act).toMatch(/^Update to the approved design.* by rule on its next sweep$/);
    expect(s.waitingOn.says.rule.key).toBe('requirements.rule.byRule');
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

// REQ-90 sat at "You: agree r1" for its owner on a project whose agree gate is off, though the owner
// ruled agreeing is the master's there (ISS-1108; REQ-89 BC-8 traced it to `ownerWait`). A step no
// gate asks a person is the master's by `whoOwes`, so it never reaches a person's Needs you.
describe('a step whose gate asks no person (ISS-1108)', () => {
  const owner = { userId: 'u1', canWrite: true, canSignOff: true, canApproveBreakdown: true };
  const draft = (owed: OwedPolicy) =>
    turn(base({ status: 'draft', agreedAt: null, stalePins: [], viewer: owner, owed }));

  it("is the master's to agree, never its person owner's Needs you", () => {
    const s = draft(routine);
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'agent', who: 'Master', act: 'agree r1' });
  });

  it("stays a person's where the project's agree gate asks one", () => {
    const s = draft({ ...routine, gates: { ...gatesOff, agree: true } });
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'agree r1' });
  });

  it("leaves a proposed revision's accept to the master where the revisions gate is off", () => {
    const proposed = {
      revision: 2,
      state: 'proposed' as const,
      authorId: 'u1',
      authorName: 'orchestrator',
      authorKind: 'human' as const,
      authorAgency: 'human' as const,
      createdAt: at('2026-10-02T00:00:00Z'),
      proposedAt: at('2026-10-02T00:00:00Z'),
      decidedAt: null,
    };
    const s = turn(
      base({ stalePins: [], viewer: owner, revisions: [...base().revisions, proposed] }),
    );
    expect(s.waitingOn).toMatchObject({ kind: 'agent', who: 'Master', act: 'accept r2' });
  });
});

// ISS-1078 (FB-534, sidpeak REQ-1): a decision dated in the future, written since the wait began,
// holds the wait: it reads waiting, never stuck or overdue, until that date, and names the decision.
describe('a requirement whose wait a dated decision holds', () => {
  const owed = (decision: StandingInput['decision']) =>
    turn(base({ owed: revisionsGate, viewer: null, decision }));

  it('reads overdue with no decision, as the wait fell due', () => {
    expect(owed(null).attentionGroup).toBe('overdue');
  });

  it('reads waiting until the date the decision names, naming it', () => {
    const s = owed({
      at: at('2026-10-25T00:00:00Z'),
      why: 'held for the owner until the vendor answers',
      until: at('2026-11-12T00:00:00Z'),
      condition: null,
    });
    expect(s.attentionGroup).toBe('waiting');
    expect(s.times.stuck).toBeNull();
    expect(s.waitingOn.rule).toContain('a decision holds it until 2026-11-12');
  });

  it('holds no longer once its date passed, nor when it was written before the wait began', () => {
    const passed = {
      at: at('2026-10-25T00:00:00Z'),
      why: 'x',
      until: at('2026-11-01T00:00:00Z'),
      condition: null,
    };
    expect(owed(passed).attentionGroup).toBe('overdue');
    const before = {
      at: at('2026-10-01T00:00:00Z'),
      why: 'x',
      until: at('2026-11-12T00:00:00Z'),
      condition: null,
    };
    expect(owed(before).attentionGroup).toBe('overdue');
  });
});
