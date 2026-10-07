import { describe, expect, it } from 'vitest';
import { personalActRefusal } from './rules.js';

const member = { projectId: 'p1', role: 'member' as const, grants: [] };
const approver = { projectId: 'p1', role: 'member' as const, grants: ['feedback.approve'] };
const outsider = { projectId: 'p1', role: null, grants: [] };

describe('feedback-triage verify: anyone on the project confirms a fix; the reporter alone says it is not fixed', () => {
  it('lets a member reporter verify and reopen their own item', () => {
    expect(personalActRefusal(member, 'verified', true)).toBeNull();
    expect(personalActRefusal(member, 'reopened', true)).toBeNull();
  });

  it('lets any member verify an item they did not report, with no feedback.approve', () => {
    expect(personalActRefusal(member, 'verified', false)).toBeNull();
  });

  it('refuses someone with no role on the project from verifying', () => {
    expect(personalActRefusal(outsider, 'verified', false)?.code).toBe('PERMISSION_FORBIDDEN');
  });

  it('still keeps reopening for the reporter or a holder of feedback.approve', () => {
    const r = personalActRefusal(member, 'reopened', false);
    expect(r?.code).toBe('PERMISSION_FORBIDDEN');
    expect(r?.detail).toContain('feedback.approve');
    expect(personalActRefusal(approver, 'reopened', false)).toBeNull();
  });
});
