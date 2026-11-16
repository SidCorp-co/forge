// ISS-1256: a term's aliases match the term, so a person's own words reach it.
// @direct-test-of packages/core/src/find/expand.ts

import { describe, expect, it } from 'vitest';
import { expandedPhrases, expandedText, expandThroughGlossary, normalized } from './expand.js';
import type { GlossaryTerm } from './model-reads.js';

const runSlots: GlossaryTerm = {
  id: 't-1',
  projectId: 'p',
  slug: 'run-slots',
  title: 'Run slots',
  body: 'How many runs a box may run at once.',
  aliases: ['chia slot', 'fair-share scheduling', 'slotsFor'],
  moduleId: null,
};
const lease: GlossaryTerm = {
  ...runSlots,
  id: 't-2',
  slug: 'lease',
  title: 'Lease',
  aliases: ['giữ issue'], // i18n-allow: a Vietnamese alias is the case under test
};

describe('expandThroughGlossary', () => {
  it('names the term whose alias the query holds, with the alias that matched', () => {
    const named = expandThroughGlossary('chia slot', [lease, runSlots]);
    expect(named.map((n) => n.expansion)).toEqual([
      { term: 'Run slots', alias: 'chia slot', termId: 't-1' },
    ]);
  });

  it('matches across case, accents and punctuation', () => {
    expect(normalized('Giữ  Issue!')).toBe('giu issue'); // i18n-allow: an accented alias folds
    expect(expandThroughGlossary('how do we GIU ISSUE?', [lease])).toHaveLength(1);
    expect(expandThroughGlossary('Fair share scheduling', [runSlots])).toHaveLength(1);
  });

  it('matches whole words only, never a fragment of one', () => {
    expect(expandThroughGlossary('chia slots', [runSlots])).toHaveLength(0);
    expect(expandThroughGlossary('rechia slot', [runSlots])).toHaveLength(0);
  });

  it('names a term whose alias holds the whole query, but not for a query too short to mean it', () => {
    expect(expandThroughGlossary('fair-share', [runSlots])).toHaveLength(1);
    expect(expandThroughGlossary('ch', [runSlots])).toHaveLength(0);
  });

  it('expands the keyword text and the phrases by the named term’s title', () => {
    const named = expandThroughGlossary('chia slot', [runSlots]);
    expect(expandedText('chia slot', named)).toBe('chia slot Run slots');
    expect(expandedPhrases('chia slot', named)).toEqual(['chia slot', 'Run slots']);
    expect(expandedPhrases(' x ', [])).toEqual(['x']);
  });
});
