import { describe, expect, it } from 'vitest';
import { nodesOfDesign, tracedStepChanges } from './auto-follow.js';

// REQ-41 BC-10: what decides whether a requirement follows an approved design by itself.

const design = (steps: [string, string?][], edges: [string, string, string?][] = []) => {
  const nodes = nodesOfDesign({
    steps: steps.map(([id, title]) => ({ id, does: 'x', after: [], ...(title ? { title } : {}) })),
    edges: edges.map(([from, to, label]) => ({ from, to, ...(label ? { label } : {}) })),
  });
  if (!nodes) throw new Error('fixture design holds no steps');
  return nodes;
};

const pinned = design(
  [
    ['cart', 'Cart'],
    ['pay', 'Pay'],
    ['ship', 'Ship'],
  ],
  [
    ['cart', 'pay'],
    ['pay', 'ship', 'paid'],
  ],
);

describe('tracedStepChanges', () => {
  const traces = [
    { code: 'BC-1', steps: ['pay'], edges: [] },
    { code: 'BC-2', steps: ['ship'], edges: [{ from: 'pay', to: 'ship', label: 'paid' }] },
  ];

  it('reads nothing changed where every traced step and edge survives and only an untraced one moved', () => {
    const approved = design(
      [
        ['cart', 'Basket'],
        ['pay', 'Pay'],
        ['ship', 'Ship'],
        ['refund', 'Refund'],
      ],
      [
        ['cart', 'pay'],
        ['pay', 'ship', 'paid'],
      ],
    );
    expect(tracedStepChanges(traces, pinned, approved)).toEqual([]);
  });

  it('names a traced step removed and one renamed, each with the criterion that traces it', () => {
    const approved = design(
      [
        ['cart', 'Cart'],
        ['ship', 'Dispatch'],
      ],
      [['pay', 'ship', 'paid']],
    );
    expect(tracedStepChanges(traces, pinned, approved)).toEqual([
      { code: 'BC-1', node: 'pay', change: 'removed' },
      { code: 'BC-2', node: 'ship', change: 'renamed' },
    ]);
  });

  it('names a traced edge the approved revision no longer holds, by its ends', () => {
    const approved = design([
      ['cart', 'Cart'],
      ['pay', 'Pay'],
      ['ship', 'Ship'],
    ]);
    expect(tracedStepChanges(traces, pinned, approved)).toEqual([
      { code: 'BC-2', node: 'pay>ship', change: 'removed' },
    ]);
  });

  it('reads only removals where no pinned revision is there to compare a name against', () => {
    const approved = design([['ship', 'Dispatch']]);
    expect(tracedStepChanges(traces, null, approved)).toEqual([
      { code: 'BC-1', node: 'pay', change: 'removed' },
      { code: 'BC-2', node: 'pay>ship', change: 'removed' },
    ]);
  });
});

describe('nodesOfDesign', () => {
  it('reads a step by the label its node shows before its title, and nothing from a document with no steps', () => {
    const nodes = nodesOfDesign({
      steps: [{ id: 'pay', title: 'Pay', node: { type: 'task', label: 'Take payment' } }],
    });
    expect(nodes?.steps.get('pay')).toBe('Take payment');
    expect(nodesOfDesign({ title: 'empty' })).toBeNull();
    expect(nodesOfDesign(null)).toBeNull();
  });
});
