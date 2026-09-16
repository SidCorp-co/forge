/**
 * ISS-1057 — the claim ledger read over the LAYERS themselves, which is where the text lives now.
 *
 * `persona-accounting.test.ts` holds the ledger and bites on the fragments a door renders. These
 * bite on the six layer texts directly, and they close the hole codex F3 named: thirty-three
 * ledger rows can each resolve exactly once while a sentence nobody wrote a row for is copied into
 * two layers, which is the duplication the split exists to make impossible. It is a file of its own
 * because the two together run past the 500-line budget.
 */

import { describe, expect, it } from 'vitest';
import { LEDGER } from '../persona-claims.fixture.js';
import { ALL_LAYERS } from './layers.js';

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

describe('the layers, sentence by sentence (ISS-1057)', () => {
  /** A layer's instruction BLOCKS: each bullet or paragraph whole, headings and blanks dropped. */
  // cm:guard a block and not a line, because a guide body wraps at 100 columns: walking lines made
  // every clause that straddles a wrap unclaimable, and the honest fix for that failure is to
  // shorten the clause until it proves nothing (the same reason `flat` exists above). Blocks are
  // also not split on `.`, which breaks on `forge issue ISS-<n>.` and on every abbreviation.
  const sentencesOf = (text: string): string[] => {
    const blocks: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        blocks.push('');
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (trimmed.startsWith('- ') || last === undefined || last === '') blocks.push(trimmed);
      else blocks[blocks.length - 1] = `${last} ${trimmed}`;
    }
    return blocks.map((b) => flat(b)).filter((b) => b.length > 0);
  };

  const BY_LAYER = new Map<string, string[]>(
    ALL_LAYERS.map((l: { id: string; text: string }) => [l.id, sentencesOf(l.text)]),
  );

  // cm:guard this is the assertion the split is FOR: one place per sentence. Without it, moving the
  // text into layers buys a directory and nothing else — a clause copied into `base` and `tools`
  // renders twice at every door and each copy drifts on its own (criterion 23).
  it('finds no sentence of any layer in a second layer (criterion 23)', () => {
    const seen = new Map<string, string>();
    for (const [id, sentences] of BY_LAYER) {
      for (const sentence of sentences) {
        const owner = seen.get(sentence);
        expect(owner, `"${sentence.slice(0, 70)}" is in both ${owner} and ${id}`).toBeUndefined();
        seen.set(sentence, id);
      }
    }
  });

  // cm:guard the other half: a sentence no ledger row claims is an instruction that arrived without
  // anybody recording that it did, which is the drop check read forwards (criterion 24).
  it('finds every sentence of every layer claimed by a ledger entry (criterion 24)', () => {
    for (const [id, sentences] of BY_LAYER) {
      for (const sentence of sentences) {
        expect(
          LEDGER.some((c) => c.clauses.some((clause) => sentence.includes(flat(clause)))),
          `layer ${id} carries a sentence no ledger entry claims: ${sentence.slice(0, 90)}`,
        ).toBe(true);
      }
    }
  });

  // cm:guard the ledger is read against the LAYERS and not only against what a door rendered, so a
  // claim whose owner changed file is caught here rather than surviving on a door that still
  // happens to render both (criterion 22).
  it('resolves each of the thirty-three claims in exactly one layer or non-layer fragment (criterion 22)', () => {
    for (const claim of LEDGER) {
      const owners = [...BY_LAYER].filter(([, sentences]) =>
        claim.clauses.every((clause) => sentences.some((s) => s.includes(flat(clause)))),
      );
      expect(
        owners.length,
        `${claim.id} resolves in ${owners.map(([i]) => i).join(', ') || 'no layer'}`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
