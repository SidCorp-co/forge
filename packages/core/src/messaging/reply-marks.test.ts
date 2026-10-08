import { describe, expect, it } from 'vitest';
import { blankMarkedClauses, markUnverified } from './reply-marks.js';

describe('a marked claim is read past', () => {
  it('blanks the clause a mark closes, in either language, and keeps every offset', () => {
    for (const language of ['en', 'vi'] as const) {
      const text = 'ISS-4 shipped on 2026-10-01. ISS-5 is open.';
      const marked = markUnverified(text, ['shipped on 2026-10-01'], language) as string;
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
