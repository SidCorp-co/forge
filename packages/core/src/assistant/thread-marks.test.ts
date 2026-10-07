// ISS-277: a room whose agent ended its turn asking something waits on the person. The reading is
// the message's end only: its last sentence, or the one a closing list of options hangs from, in
// prose outside quotes and code. A miss falls back to newest-first; a false wait is the defect.

import { describe, expect, it } from 'vitest';
import { closesOnQuestion, threadStatusOf } from './thread-marks.js';

describe('closesOnQuestion', () => {
  it('reads a closing question, in English and in Vietnamese', () => {
    expect(closesOnQuestion('I drafted REQ-1.\n\nShall I file it?')).toBe(true);
    expect(closesOnQuestion('Mình đã soạn REQ-1. Bạn có đồng ý không?')).toBe(true); // i18n-allow: the owner's own language in the FB-88 evidence
  });

  it('reads a full-width question mark, one behind closing emphasis, and one after a quote', () => {
    expect(closesOnQuestion('确认吗？')).toBe(true);
    expect(closesOnQuestion('Is that **right?**')).toBe(true);
    expect(closesOnQuestion('Do you mean "export"?')).toBe(true);
  });

  it('reads the question a closing list of options hangs from', () => {
    expect(closesOnQuestion('Which format?\n\n- CSV\n- XLSX')).toBe(true);
    expect(closesOnQuestion('Pick one?\n\n1. CSV\n2) XLSX')).toBe(true);
    expect(closesOnQuestion('Which format?\n- CSV\n- XLSX')).toBe(true);
  });

  it('reads an Arabic question mark, and a Greek one in either of its code points', () => {
    expect(closesOnQuestion('هل أقدّمه؟')).toBe(true); // i18n-allow: the Arabic question mark under test
    expect(closesOnQuestion('Να το καταχωρίσω;')).toBe(true); // i18n-allow: Greek, ASCII semicolon
    expect(closesOnQuestion('Να το καταχωρίσω;')).toBe(true); // i18n-allow: Greek question mark
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

  // the three false waits the independent judge reproduced at b1ba727, and their neighbours
  describe('reads no question where the message ends on a statement', () => {
    it('a rhetorical question it answers in the same paragraph', () => {
      expect(
        closesOnQuestion(
          'Why does this matter? Because the token expires, so the job now refreshes it.',
        ),
      ).toBe(false);
    });

    it('a question it quotes', () => {
      expect(closesOnQuestion('I recorded your question "Can we ship on Friday?" in REQ-2.')).toBe(
        false,
      );
      expect(closesOnQuestion('I recorded your question "Can we ship on Friday?"')).toBe(false);
      expect(closesOnQuestion('I logged “Can we ship?”')).toBe(false);
      expect(closesOnQuestion("I logged 'Can we ship?'")).toBe(false);
      expect(closesOnQuestion('Do you mean "export?"')).toBe(false);
      expect(closesOnQuestion('You asked:\n\n> Can we ship on Friday?')).toBe(false);
    });

    it('a closing code block holding a ternary or a SQL placeholder', () => {
      expect(closesOnQuestion('Changed it to:\n\n```ts\nconst v = ok ? a : b;\n```')).toBe(false);
      expect(closesOnQuestion('The query:\n\n```sql\nSELECT * FROM t WHERE id = ?\n```')).toBe(
        false,
      );
      expect(closesOnQuestion('The query:\n\n```sql\nSELECT * FROM t WHERE id = ?')).toBe(false);
      expect(closesOnQuestion('The query:\n\n    SELECT * FROM t WHERE id = ?')).toBe(false);
      expect(closesOnQuestion('It now runs `SELECT * FROM t WHERE id = ?`')).toBe(false);
      expect(closesOnQuestion('Pick one?\n\n```\n- a?\n```')).toBe(false);
    });

    it('a list whose items are not a question, after a paragraph that holds one mid-way', () => {
      expect(closesOnQuestion('Why? It was stale. Fixed:\n\n- CSV\n- XLSX')).toBe(false);
    });
  });

  // decision record on ISS-277, pass 2: these shapes stay misses (newest-first), never claims
  describe('leaves as misses the shapes it declines', () => {
    it('a request phrased as a statement', () => {
      expect(closesOnQuestion('I drafted REQ-1. Please confirm.')).toBe(false);
      expect(closesOnQuestion('Mình đã soạn REQ-1 rồi nhé.')).toBe(false); // i18n-allow: a Vietnamese statement ending in nhé
    });

    it('a question followed by a closing code block, quote, table or sign-off', () => {
      expect(closesOnQuestion('Shall I apply this?\n\n```diff\n+ a\n```')).toBe(false);
      expect(closesOnQuestion('Shall I file it?\n\nThanks!')).toBe(false);
      expect(closesOnQuestion('Which one?\n\n| a | b |\n|---|---|')).toBe(false);
    });

    it('an ASCII semicolon outside Greek', () => {
      expect(closesOnQuestion('Set it to x;')).toBe(false);
    });
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
