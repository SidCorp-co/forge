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
    viewer: { userId: 'u1', canSignOff: true, canAdmit: true },
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
  const signer = { userId: 'u1', canSignOff: true, canAdmit: true };
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

// FB-93: the "promote N draft issues" line counts what the promote act moves (`draftIssuesToPromote`).
// It asks only a person who can act on it, a signer who also holds issues.admit (question 3b8292dc,
// B), while its only live issues are drafts (requirement-to-delivery step `turn`, as approved).
describe('an agreed requirement whose live issues are drafts', () => {
  const admitter = { userId: 'u1', canSignOff: true, canAdmit: true };

  it('asks a signer who can admit to promote every draft, a dropped one not counted', () => {
    const s = deriveStanding({
      ...input([issue(1, 'draft', false), issue(2, 'draft', false), issue(3, 'dropped', false)]),
      viewer: admitter,
    });
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'promote 2 draft issues' });
  });

  it.each([
    ['a viewer who cannot sign', null],
    ['a signer without issues.admit', { userId: 'u2', canSignOff: true, canAdmit: false }],
    ['an admitter who cannot sign', { userId: 'u3', canSignOff: false, canAdmit: true }],
  ])('names a BA or owner who can admit issues to %s, and does not ask them', (_, viewer) => {
    const s = deriveStanding({ ...input([issue(1, 'draft', false)]), viewer });
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'a BA or owner who can admit issues',
      act: 'promote 1 draft issue',
    });
  });

  it('asks nothing once one of them is promoted, as the approved design draws it', () => {
    const s = deriveStanding({
      ...input([issue(1, 'open', false), issue(2, 'draft', false)]),
      viewer: admitter,
    });
    expect(s.waitingOn.act).not.toContain('promote');
    expect(s.attentionGroup).toBe('moving');
  });
});

// JU-9: every issue shipped and a BC unproven used to wait on 'Master · prove BC-…' whatever the BC
// lacked; the turn now names who owes the proof and the act, by what each BC lacks
describe('a requirement whose every issue shipped and whose criteria are unproven', () => {
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
  });
  const shipped = (
    issueCriteria: ReturnType<typeof traced>[],
    judge: 'self' | 'independent' | null,
  ) =>
    deriveStanding({
      ...input([issue(1, 'closed', false), issue(2, 'closed', false)]),
      criteria: [bc(1), bc(3), bc(5)],
      issueCriteria,
      judge,
    });

  it('waits on the independent judge to judge both unjudged BCs on the issues that carry them', () => {
    const s = shipped(
      [traced(1, 1, 'pass'), traced(1, 3, null), traced(2, 5, null)],
      'independent',
    );
    expect(s.state).toBe('in_delivery');
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Independent judge',
      act: 'judge BC-3, BC-5 on ISS-1, ISS-2',
    });
    expect(s.waitingOn.rule).toBe(
      'every linked issue has shipped, but BC-3, BC-5 hold no passing verdict yet, so it is not delivered',
    );
  });

  it("waits on the master where the project's runs judge their own work", () => {
    const s = shipped([traced(1, 1, 'pass'), traced(1, 3, null), traced(2, 5, null)], 'self');
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: 'judge BC-3, BC-5 on ISS-1, ISS-2' });
  });

  it('says the master judges where no policy names a judge', () => {
    const s = shipped([traced(1, 1, 'pass'), traced(1, 3, null), traced(2, 5, 'pass')], null);
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: 'judge BC-3 on ISS-1' });
    expect(s.waitingOn.rule).toMatch(/no policy names a judge, so the master judges$/);
  });

  it('asks the master to fix a failing BC, naming the issue it fails on', () => {
    const s = shipped(
      [traced(1, 1, 'pass'), traced(2, 3, 'fail'), traced(2, 5, 'pass')],
      'independent',
    );
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: 'fix BC-3, failing on ISS-2' });
  });

  it('a gap carries the reason the accepted breakdown gave for leaving it uncovered, and only a gap does (R-6)', () => {
    const s = deriveStanding({
      ...input([issue(1, 'closed', false), issue(2, 'closed', false)]),
      criteria: [bc(1), bc(3), bc(5)],
      issueCriteria: [traced(1, 1, 'pass'), traced(2, 3, 'pass')],
      judge: 'independent',
      uncovered: new Map([
        ['BC-5', 'covered by the vendor contract, not by an issue here'],
        ['BC-1', 'an earlier reason the trace now outranks'],
      ]),
    });
    expect(s.coverage.map((c) => [c.code, c.verdict, c.uncoveredReason])).toEqual([
      ['BC-1', 'passing', null],
      ['BC-3', 'passing', null],
      ['BC-5', 'gap', 'covered by the vendor contract, not by an issue here'],
    ]);
  });

  it('a gap no accepted breakdown speaks for carries no reason', () => {
    const s = shipped([traced(1, 1, 'pass'), traced(2, 3, 'pass')], 'independent');
    expect(s.coverage.find((c) => c.code === 'BC-5')?.uncoveredReason).toBeNull();
  });

  it('asks the master to trace a BC no issue criterion traces to, and the rule names every gap', () => {
    const s = shipped([traced(1, 1, 'pass'), traced(2, 3, 'fail')], 'independent');
    expect(s.waitingOn).toMatchObject({ who: 'Master', act: 'fix BC-3, failing on ISS-2' });
    expect(s.waitingOn.rule).toContain('no issue criterion traces to BC-5');
    const gapOnly = shipped([traced(1, 1, 'pass'), traced(2, 3, 'pass')], 'independent');
    expect(gapOnly.waitingOn).toMatchObject({
      who: 'Master',
      act: 'trace BC-5 to an issue criterion',
    });
  });

  it('reads delivered, waiting on the BA check, once every BC passes', () => {
    const s = shipped(
      [traced(1, 1, 'pass'), traced(1, 3, 'pass'), traced(2, 5, 'pass')],
      'independent',
    );
    expect(s.state).toBe('delivered');
    expect(s.waitingOn.act).toMatch(/^check BC-1, BC-3, BC-5 against the traceability matrix/);
  });
});
