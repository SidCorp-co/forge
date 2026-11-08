import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { edgeBetween, exitsOf } from '@forge/contracts/state-machine';
import { describe, expect, it } from 'vitest';
import { personalActRefusal, reopenRefusal } from './rules.js';
import { verifyRefusal } from './verify-rules.js';

describe('feedback-lifecycle: the machine draws only the moves the rules can take', () => {
  it('has no reopened → verified edge, because verify follows resolved and a reopened item never reads resolved', () => {
    expect(verifyRefusal('reopened')?.code).toBe('FEEDBACK_NOT_RESOLVED');
    expect(edgeBetween(FEEDBACK_MACHINE, 'reopened', 'verified')).toBeNull();
  });

  it('leaves a reopened item its two ways out: back to triage, or declined', () => {
    expect(exitsOf(FEEDBACK_MACHINE, 'reopened')).toEqual(['triaged', 'declined']);
  });

  // owner 2026-11-08, D5: a verify by ship, or by an agent on someone's behalf, is no one's last word
  it('reopens a verified item with a reason, and only a declined item is terminal', () => {
    expect(edgeBetween(FEEDBACK_MACHINE, 'verified', 'reopened')?.act).toBe('reporter.reopened');
    expect(FEEDBACK_MACHINE.terminal).toEqual(['declined']);
    expect(reopenRefusal('verified', 'it is back')).toBeNull();
    expect(reopenRefusal('verified', ' ')?.code).toBe('FEEDBACK_REOPEN_REASON_REQUIRED');
    expect(reopenRefusal('declined', 'it is back')?.code).toBe('FEEDBACK_NOT_RESOLVED');
    expect(reopenRefusal('planned', 'it is back')?.code).toBe('FEEDBACK_NOT_RESOLVED');
  });

  it('verifies only a triaged item', () => {
    expect(edgeBetween(FEEDBACK_MACHINE, 'triaged', 'verified')?.act).toBe('reporter.verified');
  });

  it('declares on triaged → verified the permission the verify rule asks of someone not the reporter', () => {
    const declared = edgeBetween(FEEDBACK_MACHINE, 'triaged', 'verified')?.permission;
    const outsider = { projectId: 'p1', role: null, grants: [] };
    expect(personalActRefusal(outsider, 'verified', false)?.detail).toContain(
      `needs ${declared} on project`,
    );
  });
});
