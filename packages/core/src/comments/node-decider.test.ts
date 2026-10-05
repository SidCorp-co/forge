import { describe, expect, it } from 'vitest';
import { nodeDeciderRefusal } from './entity-rules.js';

const P = '00000000-0000-4000-8000-000000000001';
const decision = {
  decision: 'Rewrite the breakdown step',
  reason: 'two aspects differ',
  node: { step: 'breakdown', verdict: 'rewrite' as const, layer: 'planned' as const },
};

describe('a node decision is posted by a holder of workflow-designs.approve (design-reconciliation decide)', () => {
  it('refuses a member who holds project.write only', () => {
    const r = nodeDeciderRefusal({ projectId: P, role: 'member', grants: [] }, decision, 'pilot');
    expect(r?.code).toBe('PERMISSION_FORBIDDEN');
    expect(r?.path).toBe('/decision/node');
    expect(r?.detail).toMatch(/workflow-designs\.approve/);
  });

  it('admits an admin, and a member whose grant names the approval', () => {
    expect(
      nodeDeciderRefusal({ projectId: P, role: 'admin', grants: [] }, decision, 'pilot'),
    ).toBeNull();
    expect(
      nodeDeciderRefusal(
        { projectId: P, role: 'member', grants: ['workflow-designs.approve'] },
        decision,
        'pilot',
      ),
    ).toBeNull();
  });

  it('asks nothing of a decision that names no node', () => {
    const { node: _n, ...plain } = decision;
    expect(
      nodeDeciderRefusal({ projectId: P, role: 'member', grants: [] }, plain, 'pilot'),
    ).toBeNull();
  });
});
