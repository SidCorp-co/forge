import { describe, expect, it } from 'vitest';
import { threadStatusOf } from './thread-marks.js';

const none = { onboarding: null, batchOpen: false, replyPending: false };

describe('threadStatusOf', () => {
  it('wears an onboarding thread’s own status over every other fact', () => {
    expect(threadStatusOf({ onboarding: 'done', batchOpen: true, replyPending: true })).toBe(
      'done',
    );
  });

  it('waits on the person while a batch is open, even with a reply on its way', () => {
    expect(threadStatusOf({ ...none, batchOpen: true, replyPending: true })).toBe('waiting_on_you');
  });

  it('is in progress while a message waits for its reply', () => {
    expect(threadStatusOf({ ...none, replyPending: true })).toBe('in_progress');
  });

  it('is done when nothing in the room waits on anyone', () => {
    expect(threadStatusOf(none)).toBe('done');
  });
});
