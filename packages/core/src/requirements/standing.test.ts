import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingIssue } from './standing.js';

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
  agreedAt: at('2026-09-01T00:00:00Z'),
  updatedAt: at('2026-09-26T00:00:00Z'),
  now: at('2026-09-28T00:00:00Z'),
});

// requirement-to-delivery `impact` opens `delivery`: one re-plan task per flagged issue and revision
describe('the re-plan task an impact flag opens', () => {
  it('holds one re-plan task per flagged live issue, at the current revision, owned by the master', () => {
    const s = deriveStanding(
      input([issue(1, 'in_progress', true), issue(2, 'open', false), issue(3, 'open', true)]),
    );
    expect(s.tasks.filter((t) => t.kind === 're-plan')).toEqual([
      {
        kind: 're-plan',
        owner: 'Project master',
        revision: 3,
        openedAt: '2026-09-26T00:00:00.000Z',
        dueAt: null,
        overdue: false,
        issueId: 'i1',
        displayId: 'ISS-1',
      },
      {
        kind: 're-plan',
        owner: 'Project master',
        revision: 3,
        openedAt: '2026-09-26T00:00:00.000Z',
        dueAt: null,
        overdue: false,
        issueId: 'i3',
        displayId: 'ISS-3',
      },
    ]);
    expect(s.waitingOn.act).toBe('re-plan ISS-1, ISS-3');
  });

  it('opens none for an issue that shipped or was dropped, and none while nothing is flagged', () => {
    const shipped = deriveStanding(
      input([issue(1, 'closed', true), issue(2, 'dropped', true), issue(3, 'open', false)]),
    );
    expect(shipped.tasks.some((t) => t.kind === 're-plan')).toBe(false);
    expect(shipped.waitingOn.act).not.toContain('re-plan');
  });

  it('opens none on a requirement that is not agreed', () => {
    const s = deriveStanding({ ...input([issue(1, 'open', true)]), status: 'accepted' });
    expect(s.tasks).toEqual([]);
  });
});

// F8: a draft an agent wrote under the viewer's account is the master's to propose, not the viewer's
describe('whose turn an open draft revision is', () => {
  const draftBy = (authorAgency: 'human' | 'agent') => ({
    ...input([]),
    status: 'draft' as const,
    viewer: { userId: 'u1', canSignOff: true },
    currentRevision: null,
    revisions: [
      {
        revision: 1,
        state: 'draft' as const,
        authorId: 'u1',
        authorName: 'Ba',
        authorKind: 'human' as const,
        authorAgency,
        createdAt: at('2026-09-25T00:00:00Z'),
        proposedAt: null,
        decidedAt: null,
      },
    ],
  });

  it('waits on the viewer when the viewer wrote it themselves', () => {
    const s = deriveStanding(draftBy('human'));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'propose r1' });
  });

  it('waits on the master, never on the viewer, when an agent wrote it under their account', () => {
    const s = deriveStanding(draftBy('agent'));
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({ kind: 'agent', who: 'Master', act: 'propose or drop r1' });
  });

  // F32: a returned revision says it was returned, and its master is the one woken to revise it
  it('names a returned agent revision as the master revising it, carried to its passes', () => {
    const base = draftBy('agent');
    const s = deriveStanding({
      ...base,
      revisions: base.revisions.map((r) => ({ ...r, returned: true })),
    });
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'revise returned r1, then propose or drop it',
    });
    expect(s.waitingOn.rule).toMatch(/core wakes it on the return/);
  });
});

// FB-73: an agree is refused REQUIREMENT_DESIGN_UNAPPROVED while a linked design is unapproved, so
// the requirement cannot read as waiting on the signer to agree it
describe('a draft requirement whose linked designs are not all approved', () => {
  const signer = { userId: 'u1', canSignOff: true };
  const draftHead = (
    unapprovedDesigns: { flow: string; title: string; designStatus: string | null }[],
  ) => ({
    ...input([]),
    status: 'draft' as const,
    viewer: signer,
    agreedAt: null,
    unapprovedDesigns,
  });

  it('waits on you to agree it once every linked design is approved', () => {
    const s = deriveStanding(draftHead([]));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'agree r3' });
  });

  it('waits on the design approver, not on you, while a linked design is only proposed', () => {
    const s = deriveStanding(
      draftHead([{ flow: 'checkout', title: 'Checkout', designStatus: 'proposed' }]),
    );
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'A holder of workflow-designs.approve',
      act: 'approve design Checkout',
    });
    expect(s.waitingOn.rule).toContain('REQUIREMENT_DESIGN_UNAPPROVED');
    expect(s.facts.unapprovedDesigns).toEqual([
      { flow: 'checkout', title: 'Checkout', designStatus: 'proposed' },
    ]);
  });

  it('waits on the master while a linked design is not yet proposed', () => {
    const s = deriveStanding(
      draftHead([
        { flow: 'checkout', title: 'Checkout', designStatus: 'proposed' },
        { flow: 'refund', title: 'Refund', designStatus: 'draft' },
      ]),
    );
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'propose design Refund',
    });
  });
});

// FB-93: the "promote N draft issues" line counts what the promote act moves (`draftIssuesToPromote`)
describe('an agreed requirement whose live issues are drafts', () => {
  it('asks the signer to promote every draft, a dropped one not counted', () => {
    const s = deriveStanding({
      ...input([issue(1, 'draft', false), issue(2, 'draft', false), issue(3, 'dropped', false)]),
      viewer: { userId: 'u1', canSignOff: true },
    });
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'promote 2 draft issues' });
  });

  it('names the signer to a viewer who cannot sign', () => {
    const s = deriveStanding(input([issue(1, 'draft', false)]));
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'BA or owner',
      act: 'promote 1 draft issue',
    });
  });

  it('asks nothing once one of them is promoted', () => {
    const s = deriveStanding({
      ...input([issue(1, 'open', false), issue(2, 'draft', false)]),
      viewer: { userId: 'u1', canSignOff: true },
    });
    expect(s.waitingOn.act).not.toContain('promote');
    expect(s.attentionGroup).toBe('moving');
  });
});
