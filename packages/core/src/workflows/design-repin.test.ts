import { describe, expect, it } from 'vitest';
import { canonicalDiff, pinOnlyChange, planRepins, type RepinDesign } from './design-repin.js';
import type { WorkflowWrite } from './schema.js';

const doc = (flow: string, basedOn?: { workflow: string; revision: number }[]): WorkflowWrite =>
  ({
    $schema: 'https://forge.sidcorp.co/schemas/workflow-v2.json',
    version: 2,
    project: '5e1d7c3a-2b4f-4a6e-9c8d-0f1e2a3b4c5d',
    flow,
    kind: 'flow',
    title: flow,
    summary: `${flow} summary`,
    template: { id: 'operational-flow', version: 1 },
    writtenBy: {},
    steps: [{ id: 'a', does: 'does a', after: [] }],
    ...(basedOn ? { basedOn } : {}),
  }) as WorkflowWrite;

const approvedDesign = (
  flow: string,
  approvedRevision: number,
  basedOn?: { workflow: string; revision: number }[],
  over: Partial<RepinDesign> = {},
): RepinDesign => ({
  id: `id-${flow}`,
  flow,
  revision: approvedRevision,
  designStatus: 'approved',
  approvedRevision,
  current: doc(flow, basedOn),
  approved: doc(flow, basedOn),
  pending: null,
  template: null,
  ...over,
});

describe('a pin-only change', () => {
  it('is a change only in the revisions the bases are pinned at, with the paths that prove it', () => {
    const change = pinOnlyChange(
      doc('ux', [
        { workflow: 'access', revision: 12 },
        { workflow: 'case', revision: 3 },
      ]),
      doc('ux', [
        { workflow: 'access', revision: 13 },
        { workflow: 'case', revision: 3 },
      ]),
      null,
    );
    expect(change).toMatchObject({
      pins: [{ workflow: 'access', from: 12, to: 13 }],
      changed: ['/basedOn/0/revision'],
    });
    expect(change?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not one where anything else moved, a base was added, or nothing changed', () => {
    const was = doc('ux', [{ workflow: 'access', revision: 12 }]);
    const relabelled = { ...doc('ux', [{ workflow: 'access', revision: 13 }]), title: 'renamed' };
    expect(pinOnlyChange(was, relabelled, null)).toBe(null);
    expect(
      pinOnlyChange(
        was,
        doc('ux', [
          { workflow: 'access', revision: 13 },
          { workflow: 'case', revision: 1 },
        ]),
        null,
      ),
    ).toBe(null);
    expect(pinOnlyChange(was, doc('ux', [{ workflow: 'case', revision: 12 }]), null)).toBe(null);
    expect(pinOnlyChange(was, was, null)).toBe(null);
  });

  it('reads key order as no change', () => {
    expect(canonicalDiff({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([]);
    expect(canonicalDiff({ a: [1, 2] }, { a: [1, 3] })).toEqual(['/a/1']);
  });
});

describe('the re-pin act for a moved base', () => {
  const onAccess = [{ workflow: 'access', revision: 12 }];

  it('takes every stale dependent, bases first, each re-pinned to what stands approved by then', () => {
    const plan = planRepins('access', [
      approvedDesign('access', 13),
      approvedDesign('complaint-ux', 1, [
        ...onAccess,
        { workflow: 'complaint-intake', revision: 1 },
      ]),
      approvedDesign('complaint-intake', 1, onAccess),
      approvedDesign('current', 2, [{ workflow: 'access', revision: 13 }]),
    ]);
    expect(plan.refused).toEqual([]);
    expect(plan.ready.map((s) => [s.design.flow, s.approves, s.change.pins])).toEqual([
      ['complaint-intake', 2, [{ workflow: 'access', from: 12, to: 13 }]],
      [
        'complaint-ux',
        2,
        [
          { workflow: 'access', from: 12, to: 13 },
          { workflow: 'complaint-intake', from: 1, to: 2 },
        ],
      ],
    ]);
  });

  it('approves a pin-only proposal as filed, and refuses one with any other change by name', () => {
    const filed = doc('campaign-ux', [{ workflow: 'access', revision: 13 }]);
    const changed = { ...doc('billing-ux', [{ workflow: 'access', revision: 13 }]), title: 'x' };
    const plan = planRepins('access', [
      approvedDesign('access', 13),
      approvedDesign('campaign-ux', 1, onAccess, {
        revision: 2,
        designStatus: 'proposed',
        current: filed,
        pending: { revision: 2, document: filed, proposedBy: 'master' },
      }),
      approvedDesign('billing-ux', 1, onAccess, {
        revision: 2,
        designStatus: 'proposed',
        current: changed,
        pending: { revision: 2, document: changed, proposedBy: 'master' },
      }),
    ]);
    expect(plan.ready.map((s) => [s.design.flow, s.source, s.approves, s.write])).toEqual([
      ['campaign-ux', 'proposal', 2, null],
    ]);
    expect(plan.refused.map((r) => [r.design.flow, r.refusal.code])).toEqual([
      ['billing-ux', 'WORKFLOW_REPIN_PENDING_CHANGE'],
    ]);
  });

  it('refuses a design whose re-pin would rest on a base with no approved revision', () => {
    const plan = planRepins('access', [
      approvedDesign('access', 13),
      approvedDesign('draft-base', 0, undefined, {
        approvedRevision: null,
        designStatus: 'proposed',
      }),
      approvedDesign('ux', 1, [...onAccess, { workflow: 'draft-base', revision: 1 }]),
    ]);
    expect(plan.ready).toEqual([]);
    expect(plan.refused.map((r) => [r.design.flow, r.refusal.code])).toEqual([
      ['ux', 'WORKFLOW_DESIGN_BASE_UNAPPROVED'],
    ]);
  });

  it('takes only the designs named, and moves no pin onto a design left out', () => {
    const designs = [
      approvedDesign('access', 13),
      approvedDesign('intake', 1, onAccess),
      approvedDesign('ux', 1, [...onAccess, { workflow: 'intake', revision: 1 }]),
    ];
    const plan = planRepins('access', designs, new Set(['id-ux']));
    expect(plan.ready.map((s) => [s.design.flow, s.change.pins])).toEqual([
      ['ux', [{ workflow: 'access', from: 12, to: 13 }]],
    ]);
  });

  it('refuses designs whose bases name each other in a ring', () => {
    const plan = planRepins('access', [
      approvedDesign('access', 13),
      approvedDesign('a', 1, [...onAccess, { workflow: 'b', revision: 1 }]),
      approvedDesign('b', 1, [...onAccess, { workflow: 'a', revision: 1 }]),
    ]);
    expect(plan.ready).toEqual([]);
    expect(plan.refused.map((r) => r.refusal.code)).toEqual([
      'WORKFLOW_REPIN_CYCLE',
      'WORKFLOW_REPIN_CYCLE',
    ]);
  });

  it('is empty while the base has no approved revision', () => {
    expect(
      planRepins('access', [
        approvedDesign('access', 0, undefined, { approvedRevision: null }),
        approvedDesign('ux', 1, onAccess),
      ]),
    ).toEqual({ ready: [], refused: [] });
  });
});
