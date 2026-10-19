import { describe, expect, it } from 'vitest';
import { ENTRY_CRITERION_KEYS } from '../issues/entry-criteria-keys.js';
import { HOLD_SENTENCE_WORDS } from '../pipeline/release-hold-kinds.js';
import {
  entryRecordsShortfallWords,
  landingShortfallWords,
  openQuestionsShortfallWords,
  type ShortfallWords,
  shortfallSaid,
} from './shortfall-words.js';

// ISS-1421 r12 — the release banner said "It is missing a plan, acceptance criteria, a release note,
// evidence of the work and a merge mark, which this project requires before a close." (25 words)
// while the hold comment beneath it said the same thing in 17. One wording, held to the hold's 20.

function subsets<T>(items: readonly T[]): T[][] {
  const all: T[][] = [[]];
  for (const item of items) {
    for (const s of all.slice()) all.push([...s, item]);
  }
  return all.slice(1);
}

const every: Array<[string, ShortfallWords]> = [
  ['not marked merged', landingShortfallWords(false)],
  ['outside git, unmarked', landingShortfallWords(true)],
  ['one open question', openQuestionsShortfallWords(1)],
  ['two open questions', openQuestionsShortfallWords(2)],
  ...subsets(ENTRY_CRITERION_KEYS).flatMap((keys) =>
    [true, false].map(
      (session) =>
        [
          `missing ${keys.join('+')}, session ${session}`,
          entryRecordsShortfallWords(keys, session),
        ] as [string, ShortfallWords],
    ),
  ),
];

describe('every shortfall sentence the banner and the gate panel show', () => {
  it('covers all 31 sets of close records, with and without a session', () => {
    expect(every).toHaveLength(4 + 31 * 2);
  });

  it.each(every)('%s: each sentence is capitalised, stopped and at most 20 words', (_, words) => {
    for (const said of [
      shortfallSaid({ reason: words.reason, clears: words.clears }),
      shortfallSaid({ reason: words.reason, clears: words.clearsHere }),
    ]) {
      for (const sentence of said.split(/(?<=\.)\s+/)) {
        expect(sentence, sentence).toMatch(/^[A-Z"]/);
        expect(sentence, sentence).toMatch(/\.$/);
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(HOLD_SENTENCE_WORDS);
      }
    }
  });

  it('says five missing records in the sentence the hold comment uses', () => {
    const five = entryRecordsShortfallWords(ENTRY_CRITERION_KEYS, true);
    expect(shortfallSaid({ reason: five.reason, clears: five.clearsHere })).toMatch(
      /^It is missing a plan, acceptance criteria, a release note, evidence of the work and a merge mark\. /,
    );
  });
});
