import { describe, expect, it } from 'vitest';
import { faults, keyEndsWith, keyHasSegment, kindOf, overBudget, wordsOf } from './copy-budget.mjs';

const CFG = {
  budget: 12,
  refusalBudget: 20,
  emptyBudget: 2,
  refusalSegments: /^(refusal|\w*Refused|deleteMessage)$/,
  emptySegments: /^(empty|empty[A-Z]\w*|none|no[A-Z]\w*)$/,
  explainSegments: /^(hint|\w*Hint|intro|emptyMessage)$/,
};
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const entry = (key, text, file = 'a/copy.json') => ({ file, key, text });
const refusedKeys = (...e) => [...overBudget(e, CFG).keys()].sort();

describe('wordsOf', () => {
  it('counts each placeholder as one word, however it expands', () => {
    expect(wordsOf('Moved {count} issues to {status}')).toBe(5);
    expect(wordsOf('{{current}} / {{total}}')).toBe(3);
  });
  it('is not fooled by runs of whitespace or a blank string', () => {
    expect(wordsOf('  a   b\n c ')).toBe(3);
    expect(wordsOf('')).toBe(0);
  });
});

describe('kindOf', () => {
  it('reads an explanation and an empty state from the last segment only', () => {
    expect(kindOf('x.views.hint', CFG)).toBe('explain');
    expect(kindOf('x.hint.title', CFG)).toBe('copy');
    expect(kindOf('x.list.none', CFG)).toBe('empty');
    expect(kindOf('x.none.title', CFG)).toBe('copy');
  });
  it('reads a refusal from any segment, whole', () => {
    expect(kindOf('x.refusal.moved', CFG)).toBe('refusal');
    expect(keyHasSegment('x.refusals.list', CFG.refusalSegments)).toBe(false);
    expect(keyEndsWith('x.emptyHint', CFG.explainSegments)).toBe(true);
  });
  it('lets an explanation win, so an empty state that explains is refused, not budgeted', () => {
    expect(kindOf('x.emptyMessage', CFG)).toBe('explain');
    expect(kindOf('x.refusal.hint', CFG)).toBe('explain');
  });
});

describe('overBudget', () => {
  it('passes 12 words and refuses 13', () => {
    const over = overBudget([entry('a.ok', words(12)), entry('a.long', words(13))], CFG);
    expect([...over.keys()]).toEqual(['a/copy.json::a.long']);
    expect(over.get('a/copy.json::a.long')).toMatchObject({ kind: 'copy', words: 13, budget: 12 });
  });
  it('allows a refusal or confirmation 20 and no more, by its key path', () => {
    expect(
      refusedKeys(
        entry('x.refusal.moved', words(20)),
        entry('x.parkRefused', words(21)),
        entry('x.deleteMessage', words(20)),
        entry('x.label', words(20)),
      ),
    ).toEqual(['a/copy.json::x.label', 'a/copy.json::x.parkRefused']);
  });
  it('holds an empty state to two words', () => {
    expect(
      refusedKeys(
        entry('x.empty', 'No runs'),
        entry('x.noMatch', 'No issues match'),
        entry('x.none', 'None'),
      ),
    ).toEqual(['a/copy.json::x.noMatch']);
  });
  it('refuses an explaining string at any length, and a blank one at none', () => {
    expect(
      refusedKeys(
        entry('x.views.hint', 'Short'),
        entry('x.intro', words(30)),
        entry('x.blankHint', ''),
      ),
    ).toEqual(['a/copy.json::x.intro', 'a/copy.json::x.views.hint']);
  });
});

describe('faults', () => {
  const linesOf = (...e) => faults(overBudget(e, CFG));
  it('is silent when every string holds its budget', () => {
    expect(linesOf(entry('k', words(12)), entry('k.empty', 'Nothing'))).toEqual([]);
  });
  it('names file, key, count and budget for a long string', () => {
    const [f] = linesOf(entry('k.new', words(13), 'f/copy.json'));
    expect(f).toBe('f/copy.json · k.new: 13 words, budget 12 for a copy string');
  });
  it('names the empty-state budget for a long empty state', () => {
    expect(linesOf(entry('k.none', 'No runs yet'))[0]).toContain(
      '3 words, budget 2 for an empty state',
    );
  });
  it('tells an explaining string to go, not to shrink', () => {
    expect(linesOf(entry('k.hint', 'Who can read this'))[0]).toContain(
      'refused at any length; delete it, or change the control',
    );
  });
  it('lists refusals sorted by file and key, so a run reads the same order twice', () => {
    const lines = linesOf(
      entry('b', words(13), 'z/copy.json'),
      entry('a', words(13), 'a/copy.json'),
    );
    expect(lines.map((l) => l.split(' · ')[0])).toEqual(['a/copy.json', 'z/copy.json']);
  });
});
