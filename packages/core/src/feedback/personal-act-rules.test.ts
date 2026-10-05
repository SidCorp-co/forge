import { describe, expect, it } from 'vitest';
import { personalActRefusal } from './rules.js';

const member = { projectId: 'p1', role: 'member' as const, grants: [] };
const approver = { projectId: 'p1', role: 'member' as const, grants: ['feedback.approve'] };

describe('feedback-triage verify: the reporter verifies their own resolved item', () => {
  it('lets a member reporter verify their own item', () => {
    expect(personalActRefusal(member, 'verified', true)).toBeNull();
  });

  it('lets a member reporter reopen their own item', () => {
    expect(personalActRefusal(member, 'reopened', true)).toBeNull();
  });

  it('refuses a member who is not the reporter, naming feedback.approve', () => {
    const r = personalActRefusal(member, 'verified', false);
    expect(r?.code).toBe('PERMISSION_FORBIDDEN');
    expect(r?.detail).toContain('feedback.approve');
  });

  it('lets a holder of feedback.approve verify on the reporter behalf', () => {
    expect(personalActRefusal(approver, 'verified', false)).toBeNull();
  });
});
