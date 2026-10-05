import { describe, expect, it } from 'vitest';
import { verifyAskRefusal } from './rules.js';

describe('feedback-triage verify-ask: who is asked, and when', () => {
  it('asks the reporter about a resolved item', () => {
    expect(verifyAskRefusal('resolved', false)).toBeNull();
  });

  it.each(['new', 'triaged', 'planned', 'verified', 'declined', 'reopened'] as const)(
    'refuses an item that reads %s as FEEDBACK_NOT_RESOLVED',
    (phase) => {
      expect(verifyAskRefusal(phase, false)?.code).toBe('FEEDBACK_NOT_RESOLVED');
    },
  );

  it('refuses the reporter asking themselves, pointing at verify', () => {
    const r = verifyAskRefusal('resolved', true);
    expect(r?.code).toBe('FEEDBACK_VERIFY_ASK_SELF');
    expect(r?.detail).toContain('verify');
  });
});
