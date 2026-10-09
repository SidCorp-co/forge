import type { Approvals } from '@forge/contracts/person-gates';
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingInput } from './standing.js';
import { nextStepOf } from './standing-gates.js';

// REQ-34 r2 BC-19 and BC-22, on Requirement lifecycle r15: each requirement says its step, whom it
// waits on and the step after it, and a person's Needs you lists only what that person must do.
const at = (iso: string) => new Date(iso);

/** Two members of one project: the owner holds only project.write, the other holds requirements.approve. */
const OWNER = { userId: 'u1', canSignOff: false, canAdmit: false, canApproveBreakdown: false };
const SIGNER = { userId: 'u2', canSignOff: true, canAdmit: true, canApproveBreakdown: true };

const R1 = {
  revision: 1,
  state: 'current' as const,
  authorId: 'u1',
  authorName: 'Lan',
  authorKind: 'human' as const,
  authorAgency: 'human' as const,
  createdAt: at('2026-10-01T00:00:00Z'),
  proposedAt: null,
  decidedAt: null,
};

const base = (over: Partial<StandingInput> = {}): StandingInput => ({
  status: 'draft',
  owner: { id: 'u1', name: 'Lan', kind: 'human' },
  viewer: null,
  revisions: [R1],
  currentRevision: 1,
  criteria: [],
  issues: [],
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [],
  staleContractPins: [],
  unapprovedDesigns: [],
  feedback: { open: 0, untriaged: [] },
  judge: 'self',
  agreedAt: null,
  release: null,
  updatedAt: at('2026-10-02T00:00:00Z'),
  now: at('2026-10-03T00:00:00Z'),
  ...over,
});

const turn = (input: StandingInput) => {
  const s = deriveStanding(input);
  expect(saidDisagreements(s)).toEqual([]);
  return s;
};

/** The same requirement as each of the two members reads it. */
const asEach = (input: StandingInput) => ({
  owner: turn({ ...input, viewer: OWNER }),
  signer: turn({ ...input, viewer: SIGNER }),
});

describe('a person’s Needs you lists only the acts that person must do (BC-22)', () => {
  it('a complete draft with approvals.agree off is its owner’s to agree, never the other signer’s', () => {
    const { owner, signer } = asEach(base());
    expect(owner.attentionGroup).toBe('needs_you');
    expect(owner.waitingOn).toMatchObject({ kind: 'you', act: 'agree r1' });
    expect(signer.attentionGroup).toBe('waiting');
    expect(signer.waitingOn).toMatchObject({ kind: 'person', who: 'Lan', act: 'agree r1' });
  });

  it('with approvals.agree on it is the approver’s, and the owner without the permission is not asked', () => {
    const { owner, signer } = asEach(base({ approvals: { agree: true } }));
    expect(signer.attentionGroup).toBe('needs_you');
    expect(signer.waitingOn).toMatchObject({ kind: 'you', act: 'agree r1' });
    expect(owner.attentionGroup).toBe('waiting');
    expect(owner.waitingOn).toMatchObject({ kind: 'person', who: 'BA or owner' });
  });

  it('a switch for another step leaves this one with its owner', () => {
    const { owner, signer } = asEach(base({ approvals: { accept: true, designs: true } }));
    expect(owner.attentionGroup).toBe('needs_you');
    expect(signer.attentionGroup).toBe('waiting');
  });

  it('an agent owner’s step is its master’s, and nobody’s Needs you lists it', () => {
    const { owner, signer } = asEach(base({ owner: { id: 'a1', name: 'agent', kind: 'agent' } }));
    for (const s of [owner, signer]) {
      expect(s.attentionGroup).toBe('waiting');
      expect(s.waitingOn).toMatchObject({ kind: 'agent', who: 'Master' });
    }
  });

  it.each<[string, 'owner' | 'signer', Approvals | null]>([
    ['off', 'owner', null],
    ['on', 'signer', { revisions: true }],
  ])(
    'a proposed revision with approvals.revisions %s is asked of the %s alone',
    (_, who, approvals) => {
      const proposed = base({
        status: 'agreed',
        agreedAt: at('2026-10-01T00:00:00Z'),
        approvals,
        revisions: [
          R1,
          { ...R1, revision: 2, state: 'proposed', proposedAt: at('2026-10-02T00:00:00Z') },
        ],
      });
      const each = asEach(proposed);
      const other = who === 'owner' ? 'signer' : 'owner';
      expect(each[who].attentionGroup).toBe('needs_you');
      expect(each[who].waitingOn.act).toBe('accept r2');
      expect(each[other].attentionGroup).toBe('waiting');
    },
  );

  it('an open breakdown with approvals.breakdown on is asked of a holder of suggestions.approve alone', () => {
    const agreed = base({
      status: 'agreed',
      agreedAt: at('2026-10-01T00:00:00Z'),
      openSuggestionKinds: ['breakdown'],
    });
    const off = asEach(agreed);
    expect(off.owner.attentionGroup).toBe('needs_you');
    expect(off.signer.attentionGroup).toBe('waiting');
    const on = asEach({ ...agreed, approvals: { breakdown: true } });
    expect(on.signer.attentionGroup).toBe('needs_you');
    expect(on.owner.attentionGroup).toBe('waiting');
    expect(on.owner.waitingOn.who).toBe('A holder of suggestions.approve');
  });
});

describe('each requirement says its step, whom it waits on and the step after it (BC-19)', () => {
  it('a draft names Agreed as its next step, beside whom it waits on', () => {
    const s = turn({ ...base(), viewer: OWNER });
    expect(s.state).toBe('draft');
    expect(s.next).toBe('agreed');
    expect(s.waitingOn.who).toBe('You');
  });

  it.each([
    ['draft', null, 'agreed'],
    ['agreed', null, 'in_delivery'],
    ['in_delivery', null, 'delivered'],
    ['delivered', null, 'accepted'],
    ['accepted', null, null],
    ['dropped', null, null],
    ['deferred', null, 'draft'],
    ['deferred', at('2026-10-01T00:00:00Z'), 'agreed'],
  ] as const)('%s (agreed at %s) goes on to %s', (state, agreedAt, next) => {
    expect(nextStepOf(state, agreedAt)).toBe(next);
  });

  it('an agreed one deferred says it goes back to Agreed', () => {
    const s = turn(base({ status: 'deferred', agreedAt: at('2026-10-01T00:00:00Z') }));
    expect(s.state).toBe('deferred');
    expect(s.next).toBe('agreed');
  });
});
