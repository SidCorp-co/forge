import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingInput } from './standing.js';
import type { TracedChange } from './standing-follow.js';

// REQ-41 BC-10 and BC-12, as the requirement's own turn reads them: a design approval a traced step
// did not survive waits on the assistant, and a stuck draft with the steward's question open waits
// on a signer answering it (REQ-48 BC-5).

const at = (iso: string) => new Date(iso);

const revision = (state: 'current' | 'draft', n: number) => ({
  revision: n,
  state,
  authorId: 'u1',
  authorName: 'Ba',
  authorKind: 'human' as const,
  authorAgency: 'human' as const,
  createdAt: at('2026-09-25T00:00:00Z'),
  proposedAt: null,
  decidedAt: null,
});

const base = (over: Partial<StandingInput> = {}): StandingInput => ({
  status: 'agreed',
  owner: { id: 'u1', name: 'Ba', kind: 'human' },
  viewer: { userId: 'u2', canSignOff: true, canAdmit: true },
  revisions: [revision('current', 1)],
  currentRevision: 1,
  criteria: [],
  issues: [],
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [{ flow: 'checkout', title: 'Checkout', pinned: 1, approved: 2 }],
  staleContractPins: [],
  unapprovedDesigns: [],
  feedback: { open: 0, untriaged: [] },
  judge: 'self',
  agreedAt: at('2026-09-01T00:00:00Z'),
  release: null,
  updatedAt: at('2026-09-26T00:00:00Z'),
  statusSince: at('2026-09-26T00:00:00Z'),
  master: 'serves' as const,
  now: at('2026-09-28T00:00:00Z'),
  ...over,
});

const removed: TracedChange = {
  code: 'BC-1',
  flow: 'checkout',
  title: 'Checkout',
  approved: 2,
  node: 'pay',
  change: 'removed',
};

const turn = (input: StandingInput) => {
  const s = deriveStanding(input);
  expect(saidDisagreements(s)).toEqual([]);
  return s;
};

describe('a design approved past the pin', () => {
  it('waits on a signer to update it while no traced step changed, until the kernel follows it', () => {
    const s = turn(base());
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe('Update to the approved design: Checkout (revision 2)');
  });

  it('waits on the master, not a person, to revise the criteria a removed or renamed step held', () => {
    const s = turn(
      base({
        tracedChanges: [removed, { ...removed, code: 'BC-2', node: 'ship', change: 'renamed' }],
      }),
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'revise BC-1, BC-2 for Checkout (revision 2): pay removed, ship renamed',
    });
  });

  it('waits on a signer to review the revision once one is suggested', () => {
    const s = turn(base({ tracedChanges: [removed], openSuggestionKinds: ['revision_diff'] }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe('review the suggested revision');
  });
});

describe('a stuck draft the steward asked about (REQ-48 BC-5)', () => {
  const draft = { status: 'draft' as const, currentRevision: null, stalePins: [] };

  it("waits on a signer answering the steward's question, not on its author proposing it", () => {
    const s = turn(base({ ...draft, revisions: [revision('draft', 1)], stewardAsked: true }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe("answer the steward's question");
    expect(s.waitingOn.rule).toBe('the steward asked what to do with this stuck draft');
  });

  it('is its author’s draft to propose while nothing was asked', () => {
    const s = turn(
      base({
        ...draft,
        revisions: [revision('draft', 1)],
        viewer: { userId: 'u1', canSignOff: true, canAdmit: true },
      }),
    );
    expect(s.waitingOn.act).toBe('propose r1');
  });
});
