import type { ReleaseState } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import {
  type CompletionFacts,
  canDecide,
  completionOf,
  headlineOf,
  proofOf,
  sumTotals,
  totalsOf,
  type TurnFacts,
  turnOf,
  type ViewerFacts,
} from './release-view.js';

const asker = { id: 'u-asker', name: 'Lan', kind: 'human' as const };
const minh = { id: 'u-minh', name: 'Minh', kind: 'human' as const };
const admin: ViewerFacts = { userId: 'u-minh', agency: 'human', isAdmin: true };
const member: ViewerFacts = { userId: 'u-member', agency: 'human', isAdmin: false };

const pending = { decision: null, requestedBy: asker, reason: null };

function facts(over: Partial<TurnFacts> & { state: ReleaseState }): TurnFacts {
  return {
    version: '0.4.0',
    approval: null,
    approvers: [minh],
    viewer: admin,
    gates: [],
    inFlight: null,
    crossedBounds: [],
    ...over,
  };
}

describe('whom a draft waits on', () => {
  it('waits on an admin viewer to cut it', () => {
    const t = turnOf(facts({ state: 'draft' }));
    expect(t.attention).toBe('you');
    expect(t.waiting).toMatchObject({ kind: 'you', act: 'cut 0.4.0' });
  });

  it('waits on a project admin when the viewer is not one', () => {
    const t = turnOf(facts({ state: 'draft', viewer: member }));
    expect(t.attention).toBe('others');
    expect(t.waiting).toMatchObject({ kind: 'person', who: 'A project admin' });
  });

  it('is stuck on the gate, naming the first reason and how many more stand', () => {
    const t = turnOf(
      facts({
        state: 'draft',
        gates: [{ title: 'Release note missing' }, { title: 'Provider not live yet' }],
      }),
    );
    expect(t.attention).toBe('stuck');
    expect(t.waiting).toMatchObject({
      kind: 'system',
      who: 'Release gate',
      act: 'release note missing and 1 more',
    });
  });

  it('is stuck for a viewer who cannot cut it as well: a gate outranks who may act', () => {
    const t = turnOf(facts({ state: 'draft', viewer: member, gates: [{ title: 'No runner paired' }] }));
    expect(t.attention).toBe('stuck');
  });
});

describe('whom a release awaiting approval waits on', () => {
  it('waits on the master to ask when the project requires approval and nobody has', () => {
    const t = turnOf(facts({ state: 'awaiting_approval' }));
    expect(t.attention).toBe('others');
    expect(t.waiting).toMatchObject({ kind: 'agent', who: 'Master', act: 'ask for approval' });
  });

  it('waits on an admin viewer other than the asker to approve or return', () => {
    const t = turnOf(facts({ state: 'awaiting_approval', approval: pending }));
    expect(t.attention).toBe('you');
    expect(t.waiting).toMatchObject({ kind: 'you', act: 'approve or return 0.4.0' });
  });

  it('names the one eligible approver for a viewer who cannot decide', () => {
    const t = turnOf(facts({ state: 'awaiting_approval', approval: pending, viewer: member }));
    expect(t.attention).toBe('others');
    expect(t.waiting).toMatchObject({ kind: 'person', who: 'Minh', act: 'approve' });
  });

  it('names no person when several admins can decide', () => {
    const t = turnOf(
      facts({
        state: 'awaiting_approval',
        approval: pending,
        viewer: member,
        approvers: [minh, { id: 'u-3', name: 'Hoa', kind: 'human' }],
      }),
    );
    expect(t.waiting).toMatchObject({ kind: 'person', who: 'A project admin' });
  });

  it('is stuck when the only admin is the asker, so nobody can decide', () => {
    const t = turnOf(facts({ state: 'awaiting_approval', approval: pending, approvers: [], viewer: member }));
    expect(t.attention).toBe('stuck');
    expect(t.waiting).toMatchObject({ kind: 'none', who: 'No approver' });
  });

  it('does not offer the asker their own request', () => {
    const t = turnOf(
      facts({
        state: 'awaiting_approval',
        approval: pending,
        viewer: { userId: 'u-asker', agency: 'human', isAdmin: true },
        approvers: [minh],
      }),
    );
    expect(t.attention).toBe('others');
  });

  it('never offers an agent the decision', () => {
    const t = turnOf(
      facts({
        state: 'awaiting_approval',
        approval: pending,
        viewer: { userId: 'u-agent', agency: 'agent', isAdmin: true },
      }),
    );
    expect(t.attention).toBe('others');
  });
});

describe('whom the other states wait on', () => {
  it('waits on the master to answer a return, with the reason in the rule', () => {
    const t = turnOf(
      facts({
        state: 'returned',
        approval: { decision: 'returned', requestedBy: asker, reason: 'Read beta again' },
      }),
    );
    expect(t.attention).toBe('others');
    expect(t.waiting.rule).toContain('Read beta again');
  });

  it('reads an open run as moving, by the act in flight', () => {
    expect(turnOf(facts({ state: 'in_progress', inFlight: 'deploy' })).waiting.act).toBe('deploying');
    expect(turnOf(facts({ state: 'in_progress' })).waiting.act).toBe('starting');
    expect(turnOf(facts({ state: 'in_progress' })).attention).toBe('moving');
  });

  it('reads an open run that crossed a bound as stuck, never as moving', () => {
    const t = turnOf(facts({ state: 'in_progress', inFlight: 'verify', crossedBounds: ['stall', 'regression'] }));
    expect(t.attention).toBe('stuck');
    expect(t.waiting.act).toBe('crossed its stall and regression bound');
  });

  it('waits on nobody once shipped, and stops at a run that ended without shipping', () => {
    expect(turnOf(facts({ state: 'shipped' }))).toMatchObject({ attention: 'done', waiting: { kind: 'none' } });
    for (const state of ['failed', 'rolled_back', 'aborted'] as const) {
      expect(turnOf(facts({ state })).attention).toBe('stopped');
    }
  });
});

describe('who may decide', () => {
  it('needs a human admin who did not ask, on a request still pending', () => {
    expect(canDecide(admin, pending)).toBe(true);
    expect(canDecide(member, pending)).toBe(false);
    expect(canDecide({ ...admin, agency: 'agent' }, pending)).toBe(false);
    expect(canDecide({ ...admin, userId: 'u-asker' }, pending)).toBe(false);
    expect(canDecide(admin, { ...pending, decision: 'approved' })).toBe(false);
    expect(canDecide(admin, null)).toBe(false);
    expect(canDecide(null, pending)).toBe(false);
  });
});

describe('criteria proof', () => {
  it('counts a pass as proven, a fail as failing, and every other standing as open', () => {
    expect(totalsOf(['pass', 'pass', 'fail', 'skipped', 'unresolved', 'unjudged'])).toEqual({
      proven: 2,
      failing: 1,
      open: 3,
      total: 6,
    });
  });

  it('reads an issue with no criteria as unrecorded, never as proven', () => {
    expect(proofOf(totalsOf([]))).toBe('unrecorded');
  });

  it('lets a failing criterion outrank an open one, and an open one outrank proof', () => {
    expect(proofOf(totalsOf(['pass', 'unjudged', 'fail']))).toBe('failing');
    expect(proofOf(totalsOf(['pass', 'skipped']))).toBe('open');
    expect(proofOf(totalsOf(['pass', 'pass']))).toBe('proven');
  });

  it('sums issues without losing the open ones', () => {
    expect(sumTotals([totalsOf(['pass']), totalsOf(['fail', 'unjudged']), totalsOf([])])).toEqual({
      proven: 1,
      failing: 1,
      open: 1,
      total: 3,
    });
  });
});

describe('a release headline', () => {
  it('leads with what was added, then changed, then fixed, and counts the rest', () => {
    expect(
      headlineOf([
        { section: 'Fixed', text: 'A create form posts once' },
        { section: 'Added', text: 'Ecosystem links have a strict schema' },
        { section: 'Changed', text: 'Reminders read the ward timezone' },
      ]),
    ).toBe('Ecosystem links have a strict schema; Reminders read the ward timezone; +1 more');
  });

  it('puts an issue with no note after the noted ones, keeping the order given', () => {
    expect(
      headlineOf([
        { section: null, text: 'Untitled work' },
        { section: 'Fixed', text: 'Fix one' },
      ]),
    ).toBe('Fix one; Untitled work');
  });

  it('clips a long line and drops an empty one', () => {
    const long = 'x'.repeat(200);
    const h = headlineOf([
      { section: 'Added', text: long },
      { section: 'Added', text: '   ' },
    ]);
    expect(h.length).toBeLessThan(80);
    expect(h.endsWith('…')).toBe(true);
    expect(headlineOf([])).toBe('');
  });
});

function requirement(over: Partial<CompletionFacts> = {}): CompletionFacts {
  return {
    key: 'REQ-12',
    title: 'Post-discharge care',
    status: 'agreed',
    state: 'in_delivery',
    coverage: [
      { code: 'BC-1', verdict: 'passing', issues: [{ issueId: 'a', criterion: 1, stale: false }] },
      { code: 'BC-2', verdict: 'passing', issues: [{ issueId: 'b', criterion: 1, stale: false }] },
    ],
    live: [
      { id: 'a', key: 'ISS-1', status: 'awaiting_release' },
      { id: 'b', key: 'ISS-2', status: 'closed' },
    ],
    ...over,
  };
}

describe('the requirements a release completes', () => {
  it('completes a requirement when its other issues are closed and every criterion passes', () => {
    const r = completionOf(requirement(), new Set(['a']));
    expect(r.completes).toBe(true);
    expect(r.advances).toEqual([{ code: 'BC-1', verdict: 'passing' }]);
    expect(r.remaining).toEqual({ issues: [], criteria: [] });
  });

  it('is partial while another live issue is still open, naming it', () => {
    const r = completionOf(
      requirement({ live: [...requirement().live, { id: 'c', key: 'ISS-3', status: 'in_progress' }] }),
      new Set(['a']),
    );
    expect(r.completes).toBe(false);
    expect(r.remaining.issues).toEqual(['ISS-3']);
  });

  it('is partial while a criterion this release advanced is not passing, naming it', () => {
    const r = completionOf(
      requirement({
        coverage: [
          { code: 'BC-1', verdict: 'failing', issues: [{ issueId: 'a', criterion: 1, stale: false }] },
          { code: 'BC-2', verdict: 'passing', issues: [] },
        ],
      }),
      new Set(['a']),
    );
    expect(r.completes).toBe(false);
    expect(r.advances).toEqual([{ code: 'BC-1', verdict: 'failing' }]);
    expect(r.remaining.criteria).toEqual(['BC-1']);
  });

  it('does not complete a requirement nobody agreed, nor one with no criteria', () => {
    expect(completionOf(requirement({ status: 'draft' }), new Set(['a'])).completes).toBe(false);
    expect(completionOf(requirement({ status: 'dropped' }), new Set(['a'])).completes).toBe(false);
    expect(completionOf(requirement({ coverage: [] }), new Set(['a'])).completes).toBe(false);
  });

  it('counts a link to an earlier wording as no advance', () => {
    const r = completionOf(
      requirement({
        coverage: [{ code: 'BC-1', verdict: 'stale', issues: [{ issueId: 'a', criterion: 1, stale: true }] }],
      }),
      new Set(['a']),
    );
    expect(r.advances).toEqual([]);
    expect(r.completes).toBe(false);
  });
});
