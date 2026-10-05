import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { describe, expect, it, vi } from 'vitest';
import { policyGapOf } from '../project-config/dispatch-policy.js';

vi.mock('./ports.js', () => ({
  devicesPorts: () => ({
    policyGapOf: (projectId: string, held: unknown, status: string) =>
      policyGapOf(projectId, held as Parameters<typeof policyGapOf>[1], status),
  }),
}));

const { admissionOf } = await import('./admissible.js');

const held = (states: Record<string, unknown>) => ({
  revision: 1,
  document: { qa: 'self', intake: 'auto', states, permissions: { std: { deny: [] } } },
});

describe('admissible withholds a takeable status the policy declares no state for, and names it', () => {
  it('no entry state: open, approved and reopen are withheld, each refused POLICY_STATE_UNDECLARED', () => {
    const { admission, refused } = admissionOf(
      'p',
      held({ in_progress: { model: 'm', permissions: 'std' } }),
    );
    expect(admission.statuses).toEqual([]);
    expect(refused.map((r) => r.code)).toEqual([
      'POLICY_STATE_UNDECLARED',
      'POLICY_STATE_UNDECLARED',
      'POLICY_STATE_UNDECLARED',
    ]);
    expect(refused[0]?.message).toContain('states.open');
  });

  it('an entry state admits every takeable status and refuses none', () => {
    const { admission, refused } = admissionOf(
      'p',
      held({ open: { model: 'm', permissions: 'std' } }),
    );
    expect(admission.statuses).toEqual(TAKEABLE_STATUSES);
    expect(refused).toEqual([]);
  });
});
