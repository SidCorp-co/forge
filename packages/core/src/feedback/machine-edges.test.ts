import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { edgeBetween, exitsOf } from '@forge/contracts/state-machine';
import { describe, expect, it } from 'vitest';
import { verifyRefusal } from './rules.js';

describe('feedback-lifecycle: the machine draws only the moves the rules can take', () => {
  it('has no reopened → verified edge, because verify follows resolved and a reopened item never reads resolved', () => {
    expect(verifyRefusal('reopened')?.code).toBe('FEEDBACK_NOT_RESOLVED');
    expect(edgeBetween(FEEDBACK_MACHINE, 'reopened', 'verified')).toBeNull();
  });

  it('leaves a reopened item its two ways out: back to triage, or declined', () => {
    expect(exitsOf(FEEDBACK_MACHINE, 'reopened')).toEqual(['triaged', 'declined']);
  });

  it('verifies only a triaged item', () => {
    expect(edgeBetween(FEEDBACK_MACHINE, 'triaged', 'verified')?.act).toBe('reporter.verified');
  });
});
