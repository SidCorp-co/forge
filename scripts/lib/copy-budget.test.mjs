import { describe, expect, it } from 'vitest';
import { baselineOf, faults, frozen, isRefusalKey, overBudget, wordsOf } from './copy-budget.mjs';

const CFG = {
  budget: 12,
  refusalBudget: 20,
  refusalSegments: /^(refusal|\w*Refused|deleteMessage)$/,
};
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const entry = (key, text, file = 'a/copy.json') => ({ file, key, text });
const baselineWith = (...rows) =>
  frozen({ files: Object.fromEntries(rows.map(([file, key, n]) => [file, { [key]: n }])) });

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

describe('overBudget', () => {
  it('passes 12 words and refuses 13', () => {
    const over = overBudget([entry('a.ok', words(12)), entry('a.long', words(13))], CFG);
    expect([...over.keys()]).toEqual(['a/copy.json::a.long']);
    expect(over.get('a/copy.json::a.long')).toMatchObject({ words: 13, budget: 12 });
  });
  it('allows a refusal or confirmation 20 and no more, by its key path', () => {
    const over = overBudget(
      [
        entry('x.refusal.moved', words(20)),
        entry('x.parkRefused', words(21)),
        entry('x.deleteMessage', words(20)),
        entry('x.hint', words(20)),
      ],
      CFG,
    );
    expect([...over.keys()].sort()).toEqual(['a/copy.json::x.hint', 'a/copy.json::x.parkRefused']);
  });
  it('matches a key by whole segment, not by substring', () => {
    expect(isRefusalKey('x.refusals.list', CFG.refusalSegments)).toBe(false);
    expect(isRefusalKey('x.refusal.list', CFG.refusalSegments)).toBe(true);
  });
});

describe('faults', () => {
  const over = (...e) => overBudget(e, CFG);
  it('is silent when the strings over budget are exactly the baseline', () => {
    expect(faults(over(entry('k', words(13))), baselineWith(['a/copy.json', 'k', 13]))).toEqual([]);
  });
  it('refuses a new over-budget string naming file, key, count and budget', () => {
    const [f] = faults(over(entry('k.new', words(13))), new Map());
    expect(f).toContain('a/copy.json');
    expect(f).toContain('k.new');
    expect(f).toContain('13 words, budget 12');
  });
  it('refuses a string that grew past its baseline', () => {
    expect(
      faults(over(entry('k', words(15))), baselineWith(['a/copy.json', 'k', 13]))[0],
    ).toContain('grew from 13 to 15');
  });
  it('refuses a fixed string whose baseline entry stays, and a deleted key likewise', () => {
    const base = baselineWith(['a/copy.json', 'k', 13]);
    expect(faults(over(entry('k', words(12))), base)[0]).toContain('remove its baseline entry');
    expect(faults(over(), base)[0]).toContain('remove its baseline entry');
  });
  it('refuses a string trimmed but still over until the baseline records the new count', () => {
    expect(
      faults(over(entry('k', words(14))), baselineWith(['a/copy.json', 'k', 20]))[0],
    ).toContain('trim the baseline entry');
  });
});

describe('baselineOf', () => {
  it('round-trips through frozen, sorted by file and key', () => {
    const o = overBudget([entry('b', words(13)), entry('a', words(14))], CFG);
    expect(Object.keys(baselineOf(o).files['a/copy.json'])).toEqual(['a', 'b']);
    expect(faults(o, frozen(baselineOf(o)))).toEqual([]);
  });
});
