// ISS-277: a room whose agent ended its turn asking something waits on the person. The reading is
// the closing paragraph only, so a question the agent went on to answer, or a `?` in a link, is none.

import { describe, expect, it } from 'vitest';
import { closesOnQuestion, threadStatusOf } from './thread-marks.js';

describe('closesOnQuestion', () => {
  it('reads a closing question, in English and in Vietnamese', () => {
    expect(closesOnQuestion('I drafted REQ-1.\n\nShall I file it?')).toBe(true);
    expect(closesOnQuestion('Mình đã soạn REQ-1. Bạn có đồng ý không?')).toBe(true); // i18n-allow: the owner's own language in the FB-88 evidence
  });

  it('reads a full-width question mark and one behind closing emphasis or a quote', () => {
    expect(closesOnQuestion('确认吗？')).toBe(true);
    expect(closesOnQuestion('Is that **right?**')).toBe(true);
    expect(closesOnQuestion('Do you mean "export?"')).toBe(true);
  });

  it('reads the question a closing list of options hangs from', () => {
    expect(closesOnQuestion('Which format?\n\n- CSV\n- XLSX')).toBe(true);
    expect(closesOnQuestion('Pick one?\n\n1. CSV\n2) XLSX')).toBe(true);
  });

  it('reads no question in a statement, an empty message, or a question it went on to answer', () => {
    expect(closesOnQuestion('REQ-1 is filed.')).toBe(false);
    expect(closesOnQuestion('   ')).toBe(false);
    expect(closesOnQuestion('Why did it fail?\n\nThe token had expired.')).toBe(false);
  });

  it('reads no question in a link query or a list that does not follow one', () => {
    expect(closesOnQuestion('It is at https://forge.test/r?id=1 now.')).toBe(false);
    expect(closesOnQuestion('Done:\n\n- CSV?x=1\n- XLSX')).toBe(false);
  });
});

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
