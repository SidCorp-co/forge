import { describe, expect, it } from 'vitest';
import { blankMarkedClauses, cutHeldSentences, UNVERIFIED_MARK } from './reply-marks.js';

describe('a marked claim is read past', () => {
  it('blanks the clause a mark closes, in either language, and keeps every offset', () => {
    for (const language of ['en', 'vi'] as const) {
      const text = 'ISS-4 shipped on 2026-10-01. ISS-5 is open.';
      const marked = text.replace('2026-10-01.', `2026-10-01 ${UNVERIFIED_MARK[language]}.`);
      const blanked = blankMarkedClauses(marked);
      expect(blanked).toHaveLength(marked.length);
      expect(blanked.trim()).toBe('. ISS-5 is open.');
    }
  });

  it('leaves a reply without a mark as it is', () => {
    const text = 'ISS-4 (unverified) shipped.';
    expect(blankMarkedClauses(text)).toBe(text);
  });
});

describe('a held claim is cut by its whole sentence, never marked (REQ-41 BC-3)', () => {
  it('cuts the whole sentence holding the quote and keeps every other sentence as written', () => {
    const text = 'REQ-34 waits on you. It is 87% done; ISS-5 is open. That is all.';
    expect(cutHeldSentences(text, ['87% done'])).toBe('REQ-34 waits on you. That is all.');
  });

  it('cuts a list line whole and closes up what is left', () => {
    const text =
      'Waiting on you:\n- REQ-34: agree revision 2\n- ISS-9 has 412 open rows\n\nThat is all.';
    expect(cutHeldSentences(text, ['412 open rows'])).toBe(
      'Waiting on you:\n- REQ-34: agree revision 2\n\nThat is all.',
    );
  });

  it('cuts two claims in one sentence once, and the last sentence with no stop', () => {
    const text = 'One is fine. ISS-7 shipped on 2026-10-01 to 40 users';
    expect(cutHeldSentences(text, ['2026-10-01', '40 users'])).toBe('One is fine.');
  });

  it('cuts nothing it cannot find: a quote not in the reply is null, not a guess', () => {
    expect(cutHeldSentences('ISS-5 is open.', ['87% done'])).toBeNull();
  });

  it('leaves nothing where every sentence held a claim', () => {
    expect(cutHeldSentences('It is 87% done.', ['87% done'])).toBe('');
  });

  it('cuts the whole sentence even where it joins two statements, so no part is left without its verb', () => {
    const text = 'REQ-31 is in delivery, and ISS-9998 does not exist on the tracker. REQ-34 waits on you.';
    expect(cutHeldSentences(text, ['ISS-9998'])).toBe('REQ-34 waits on you.');
  });

  it('cuts a labelled list item whole, so a label is never left behind its claim', () => {
    expect(
      cutHeldSentences('- REQ-31: in delivery\n- ISS-9998: not found on the tracker', ['ISS-9998']),
    ).toBe('- REQ-31: in delivery');
  });
});

// The trims the owner read on dev on 2026-10-22 (conversation a760cd5f): each cut ended mid-sentence,
// because a stop or a colon at the end of the two characters a clause boundary was read from counted
// as one before a space — the colon inside `07:36Z`, the one closing `**Requirements:`.
describe('a trim never leaves a cut timestamp, a dangling marker or a bare list (REQ-41 BC-3)', () => {
  it('keeps a timestamp whole: the sentence stating the unbacked count goes, not half the time', () => {
    const text =
      'Có. Theo **Needs you** lúc `2026-10-22T07:36Z`, có **59** quyết định đang chờ bạn.\n\n### Nên chấp nhận ngay\n- **REQ-25 — Accept revision 1**: cả 3 business criteria đều pass trên running build.\n- **REQ-36 — MK-2**: cần xem mockup trước.'; // i18n-allow: the dev reply this trim was read from
    const cut = cutHeldSentences(text, ['59', '3 business criteria']);
    expect(cut).toBe('Có.\n\n### Nên chấp nhận ngay\n- **REQ-36 — MK-2**: cần xem mockup trước.'); // i18n-allow: the dev reply this trim was read from
    expect(cut).not.toContain('T07\n');
  });

  it('drops a labelled list item whole, never leaving its bold label open', () => {
    const text =
      '- **Requirements:** có **45** requirement, **12** đã delivered. Nguồn: **Project status**.\n- **Điểm nghẽn chính:** REQ-9 đang `needs_info`. Nguồn: **Project status**.'; // i18n-allow: the dev reply this trim was read from
    const cut = cutHeldSentences(text, ['45']);
    expect(cut).toBe('- **Điểm nghẽn chính:** REQ-9 đang `needs_info`. Nguồn: **Project status**.'); // i18n-allow: the dev reply this trim was read from
    expect(cut).not.toContain('**Requirements Nguồn'); // i18n-allow: the dev reply this trim was read from
  });

  it('drops the sentence that introduced a list of keys, never leaving the bare list to open the reply', () => {
    const text =
      'Tôi mở 9 issue đã thống nhất: **ISS-609, ISS-612–ISS-617, ISS-569 và ISS-607**. Ba issue **ISS-603, ISS-606, ISS-608** không còn nằm trong hàng chờ hiện tại.'; // i18n-allow: the dev reply this trim was read from
    expect(cutHeldSentences(text, ['9 issue'])).toBe(
      'Ba issue **ISS-603, ISS-606, ISS-608** không còn nằm trong hàng chờ hiện tại.', // i18n-allow: the dev reply this trim was read from
    );
  });

  it('takes a list item with the items nested under it, and a heading left with nothing under it', () => {
    const text =
      '### Re-pin\n- **6 design re-pin**: chỉ đổi revision.\n  - `system-context` → Follow r17\n  - `issue-lifecycle` → Follow r19\n\n### Mở để làm việc\n- ISS-609 đã sẵn sàng.'; // i18n-allow: the dev reply this trim was read from
    expect(cutHeldSentences(text, ['6 design re-pin'])).toBe(
      '### Mở để làm việc\n- ISS-609 đã sẵn sàng.', // i18n-allow: the dev reply this trim was read from
    );
  });

  it('takes the whole line where a sentence cut would leave a bold or code span open', () => {
    const text = 'Theo **Needs you. Có 59 quyết định** đang chờ.\nISS-5 is open.'; // i18n-allow: the dev reply this trim was read from
    expect(cutHeldSentences(text, ['59'])).toBe('ISS-5 is open.');
  });

  it('reads a version, a time and a decimal as one word, never as a sentence end', () => {
    const text = 'Release 0.4.0 shipped at 07:36 and covers 2.5 issues on average. ISS-5 is open.';
    expect(cutHeldSentences(text, ['2.5 issues'])).toBe('ISS-5 is open.');
  });
});
