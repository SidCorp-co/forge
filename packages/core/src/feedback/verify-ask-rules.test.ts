import { describe, expect, it } from 'vitest';
import { verifyAskRefusal, verifyRefusal } from './verify-rules.js';

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

// ISS-1159: the verify door let sid-desk FB-9 be verified on a release that shipped its carrier's
// failing c2; a criterion shipped failing refuses the verify by name, whatever the phase reads
describe('feedback-lifecycle verify: a carrier shipped failing verifies nothing (ISS-1159)', () => {
  it('refuses FEEDBACK_CARRIER_FAILED naming each failing criterion', () => {
    const r = verifyRefusal('planned', ['ISS-18 c2']);
    expect(r?.code).toBe('FEEDBACK_CARRIER_FAILED');
    expect(r?.detail).toContain('ISS-18 c2');
    expect(verifyRefusal('resolved', ['ISS-18 c2'])?.code).toBe('FEEDBACK_CARRIER_FAILED');
  });

  it('verifies a resolved item whose carriers shipped clean, as before', () => {
    expect(verifyRefusal('resolved', [])).toBeNull();
    expect(verifyRefusal('resolved')).toBeNull();
  });
});
