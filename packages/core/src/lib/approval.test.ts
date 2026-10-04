import { APPROVAL_RESOURCES } from '@forge/contracts/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const effectiveProjectRole = vi.fn();
vi.mock('./authz.js', () => ({
  effectiveProjectRole: (...args: unknown[]) => effectiveProjectRole(...args),
}));

const { approvalRefusal, approvalRefusalFor, mayApprove, mayApproveOn } = await import(
  './approval.js'
);

const P = 'p-1';

beforeEach(() => effectiveProjectRole.mockReset());

describe('mayApprove: approval is a permission (ADR 0007)', () => {
  it.each([...APPROVAL_RESOURCES])('%s.approve is held by admin and by no lesser role', (r) => {
    expect(mayApprove({ userId: 'u', role: 'admin' }, r)).toBe(true);
    expect(mayApprove({ userId: 'u', role: 'member' }, r)).toBe(false);
    expect(mayApprove({ userId: 'u', role: 'viewer' }, r)).toBe(false);
    expect(mayApprove({ userId: 'u', role: null }, r)).toBe(false);
  });

  it('reads no agency and no authorship: the facts carry neither', () => {
    const facts = { userId: 'agent-who-proposed-it', role: 'admin' as const };
    expect(Object.keys(facts).sort()).toEqual(['role', 'userId']);
    expect(mayApprove(facts, 'mockups')).toBe(true);
  });
});

describe('approvalRefusal: one code naming the permission', () => {
  it('answers null for a holder', () => {
    expect(approvalRefusal({ userId: 'u', role: 'admin' }, 'releases', P, 'x')).toBeNull();
  });

  it('refuses APPROVE_PERMISSION_REQUIRED with permission and resource, and names the act and the role held', () => {
    const r = approvalRefusal(
      { userId: 'u-9', role: 'member' },
      'requirements',
      P,
      'agreeing REQ-4',
    );
    expect(r).toMatchObject({
      code: 'APPROVE_PERMISSION_REQUIRED',
      path: '',
      permission: 'requirements.approve',
      resource: 'requirements',
    });
    expect(r?.detail).toContain('agreeing REQ-4');
    expect(r?.detail).toContain('u-9 holds member');
    expect(r?.detail).toContain('requirements.approve');
  });

  it('names an outsider as holding no role', () => {
    expect(approvalRefusal({ userId: 'u', role: null }, 'plans', P, 'x')?.detail).toContain(
      'holds no role',
    );
  });
});

describe('the reading variants take the effective (org-derived) role', () => {
  it('an org owner or admin reads as project admin and holds it', async () => {
    effectiveProjectRole.mockResolvedValue({ projectId: P, role: 'admin', orgRole: 'owner' });
    expect(await mayApproveOn('u', P, 'contracts')).toBe(true);
    expect(await approvalRefusalFor({ userId: 'u' }, P, 'contracts', 'x')).toBeNull();
    expect(effectiveProjectRole).toHaveBeenCalledWith('u', P);
  });

  it('no access at all is refused', async () => {
    effectiveProjectRole.mockResolvedValue(null);
    expect((await approvalRefusalFor({ userId: 'u' }, P, 'feedback', 'x'))?.code).toBe(
      'APPROVE_PERMISSION_REQUIRED',
    );
  });
});
