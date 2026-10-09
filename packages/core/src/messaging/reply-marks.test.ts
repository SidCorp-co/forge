import { describe, expect, it } from 'vitest';
import { blankMarkedClauses, cutClauses, UNVERIFIED_MARK } from './reply-marks.js';

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

describe('a held claim is cut, never marked (REQ-41 BC-3)', () => {
  it('cuts the whole clause holding the quote and keeps every other clause as written', () => {
    const text = 'REQ-34 waits on you. It is 87% done; ISS-5 is open.';
    expect(cutClauses(text, ['87% done'])).toBe('REQ-34 waits on you. ISS-5 is open.');
  });

  it('cuts a list line whole and closes up what is left', () => {
    const text =
      'Waiting on you:\n- REQ-34: agree revision 2\n- ISS-9 has 412 open rows\n\nThat is all.';
    expect(cutClauses(text, ['412 open rows'])).toBe(
      'Waiting on you:\n- REQ-34: agree revision 2\n\nThat is all.',
    );
  });

  it('cuts two claims in one clause once, and the last clause with no stop', () => {
    const text = 'One is fine. ISS-7 shipped on 2026-10-01 to 40 users';
    expect(cutClauses(text, ['2026-10-01', '40 users'])).toBe('One is fine.');
  });

  it('cuts nothing it cannot find: a quote not in the reply is null, not a guess', () => {
    expect(cutClauses('ISS-5 is open.', ['87% done'])).toBeNull();
  });

  it('leaves nothing where every clause held a claim', () => {
    expect(cutClauses('It is 87% done.', ['87% done'])).toBe('');
  });
});
