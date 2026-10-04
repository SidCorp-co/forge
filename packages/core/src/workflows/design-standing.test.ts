import { describe, expect, it } from 'vitest';
import {
  buildGateOf,
  type DesignStandingInput,
  designWaitingOn,
  revisionStateOf,
} from './design-standing.js';

const input = (over: Partial<DesignStandingInput>): DesignStandingInput => ({
  status: 'approved',
  proposedRevision: null,
  approvedRevision: 6,
  latest: { revision: 6, author: 'hop master' },
  approver: 'owner',
  canDecide: false,
  ...over,
});

const proposed = (over: Partial<DesignStandingInput> = {}) =>
  input({
    status: 'proposed',
    proposedRevision: 7,
    latest: { revision: 7, author: 'hop master' },
    ...over,
  });

describe('designWaitingOn: whose turn a design is', () => {
  it('a proposed revision waits on you when you may decide it', () => {
    const w = designWaitingOn(proposed({ canDecide: true }));
    expect(w).toMatchObject({ kind: 'you', who: 'You', act: 'approve or return revision 7' });
    expect(w.rule).toContain('you may decide');
  });

  it('a proposed revision waits on an org owner or admin when the policy is owner and you may not decide', () => {
    expect(designWaitingOn(proposed())).toMatchObject({
      kind: 'person',
      who: 'An org owner or admin',
      act: 'approve or return revision 7',
    });
  });

  it('a proposed revision waits on the master when the policy hands decisions to it', () => {
    const w = designWaitingOn(proposed({ approver: 'master' }));
    expect(w).toMatchObject({ kind: 'agent', who: 'Master' });
    expect(w.rule).toContain('"master"');
  });

  it('you beat the policy: an approver viewing reads its own turn under either policy', () => {
    expect(designWaitingOn(proposed({ approver: 'master', canDecide: true })).kind).toBe('you');
  });

  it('a returned design waits on the agent that wrote its latest revision, to revise it', () => {
    expect(
      designWaitingOn(input({ status: 'returned', latest: { revision: 9, author: 'hop master' } })),
    ).toMatchObject({ kind: 'agent', who: 'hop master', act: 'revise revision 9' });
  });

  it('a returned design with no revision row names the master and no number', () => {
    expect(designWaitingOn(input({ status: 'returned', latest: null }))).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'revise it',
    });
  });

  it('a draft design waits on its master to finish and propose it', () => {
    expect(designWaitingOn(input({ status: 'draft', approvedRevision: null })).act).toBe(
      'finish and propose it',
    );
  });

  it('an approved design waits on nobody and says which revision stands', () => {
    const w = designWaitingOn(input({}));
    expect(w).toMatchObject({ kind: 'none', who: 'Nobody', act: '' });
    expect(w.rule).toContain('revision 6 is approved');
  });

  it('a workflow outside design approval waits on nobody', () => {
    expect(designWaitingOn(input({ status: null, approvedRevision: null })).kind).toBe('none');
  });

  it('a proposed head with no proposed revision recorded falls back to the latest revision', () => {
    expect(designWaitingOn(proposed({ proposedRevision: null, canDecide: true })).act).toBe(
      'approve or return revision 7',
    );
  });
});

describe('buildGateOf: whether issues that build the design may be dispatched', () => {
  it('opens only while the design is approved', () => {
    expect(
      buildGateOf({ status: 'approved', proposedRevision: null, approvedRevision: 6 }),
    ).toEqual({
      open: true,
      rule: 'issues that build it may be dispatched: revision 6 is approved',
    });
  });

  it('a newer proposal over an approved revision holds builds again, as dispatch does', () => {
    const g = buildGateOf({ status: 'proposed', proposedRevision: 7, approvedRevision: 6 });
    expect(g.open).toBe(false);
    expect(g.rule).toContain('revision 7 waits on its approver');
  });

  it('a returned, draft or unapproved design holds its builds', () => {
    for (const status of ['returned', 'draft', null] as const) {
      expect(buildGateOf({ status, proposedRevision: null, approvedRevision: null }).open).toBe(
        false,
      );
    }
  });
});

describe('revisionStateOf: one revision read against the head', () => {
  const head = { status: 'proposed' as const, proposedRevision: 7, approvedRevision: 5 };

  it('the approved revision is current', () => {
    expect(revisionStateOf({ revision: 5, decision: 'approve' }, head)).toBe('current');
  });

  it('the revision awaiting its approver is proposed', () => {
    expect(revisionStateOf({ revision: 7, decision: null }, head)).toBe('proposed');
  });

  it('a returned revision stays returned after a later one is proposed', () => {
    expect(revisionStateOf({ revision: 6, decision: 'return' }, head)).toBe('returned');
  });

  it('an earlier approved revision is superseded', () => {
    expect(revisionStateOf({ revision: 4, decision: 'approve' }, head)).toBe('superseded');
  });

  it('an undecided revision a later proposal replaced is superseded, not proposed', () => {
    expect(revisionStateOf({ revision: 3, decision: null }, head)).toBe('superseded');
  });

  it('the approved revision reads current even when its row records no decision', () => {
    expect(
      revisionStateOf(
        { revision: 2, decision: null },
        { status: 'approved', proposedRevision: null, approvedRevision: 2 },
      ),
    ).toBe('current');
  });

  it('nothing reads proposed once the head is no longer proposed', () => {
    expect(
      revisionStateOf(
        { revision: 7, decision: null },
        { status: 'returned', proposedRevision: 7, approvedRevision: 5 },
      ),
    ).toBe('superseded');
  });
});
