// ISS-277: a room waits on the person when the agent's last reply was recorded as awaiting their
// answer. The record is read in conversation-waiting-on-you-e2e; this is the status order over it.

import { describe, expect, it } from 'vitest';
import { threadStatusOf } from './thread-marks.js';

describe('threadStatusOf', () => {
  const quiet = { onboarding: null, batchOpen: false, replyPending: false, agentAsked: false };

  it('waits on the person when the agent asked, and is done when it did not', () => {
    expect(threadStatusOf({ ...quiet, agentAsked: true })).toBe('waiting_on_you');
    expect(threadStatusOf(quiet)).toBe('done');
  });

  it('reads a reply still being made before an earlier question', () => {
    expect(threadStatusOf({ ...quiet, agentAsked: true, replyPending: true })).toBe('in_progress');
  });

  it('lets an onboarding thread keep its own status', () => {
    expect(threadStatusOf({ ...quiet, onboarding: 'in_progress', agentAsked: true })).toBe(
      'in_progress',
    );
  });
});
