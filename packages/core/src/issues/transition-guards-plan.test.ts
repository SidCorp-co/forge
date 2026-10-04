import { beforeEach, describe, expect, it, vi } from 'vitest';

const readProjectDocument = vi.fn();
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: (...args: unknown[]) => readProjectDocument(...args),
}));
const effectiveProjectRole = vi.fn();
vi.mock('../lib/authz.js', async (actual) => ({
  ...(await actual<typeof import('../lib/authz.js')>()),
  effectiveProjectRole: (...args: unknown[]) => effectiveProjectRole(...args),
}));

const { guardFault } = await import('./transition-guards.js');

const planned = {
  execute: vi.fn().mockResolvedValue([{ plan: 'p', acceptance_criteria: '1. a' }]),
};

const approve = (agency: 'human' | 'agent') =>
  guardFault({
    issue: { id: 'i-1', projectId: 'p-1' },
    from: 'open',
    to: 'approved',
    agency,
    actorUserId: 'u-1',
    executor: planned as never,
  });

beforeEach(() => {
  readProjectDocument.mockReset();
  readProjectDocument.mockResolvedValue({ document: { plan: { approval: { required: true } } } });
  effectiveProjectRole.mockReset();
});

describe('plan approval is plans.approve, not a person (ADR 0007)', () => {
  it('lets an agent holding plans.approve move the plan into approved', async () => {
    effectiveProjectRole.mockResolvedValue({ role: 'admin', orgRole: null });
    expect(await approve('agent')).toBeNull();
  });

  it('refuses a person lacking it by the one permission code', async () => {
    effectiveProjectRole.mockResolvedValue({ role: 'member', orgRole: null });
    const fault = await approve('human');
    expect(fault).toMatchObject({
      code: 'APPROVE_PERMISSION_REQUIRED',
      details: { permission: 'plans.approve', resource: 'plans', rule: 'plan.approval.required' },
    });
  });

  it('asks nothing when the project does not require plan approval', async () => {
    readProjectDocument.mockResolvedValue({ document: {} });
    effectiveProjectRole.mockResolvedValue({ role: 'member', orgRole: null });
    expect(await approve('agent')).toBeNull();
  });
});
