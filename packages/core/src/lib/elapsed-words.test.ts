import { describe, expect, it } from 'vitest';
import { elapsedWords } from './elapsed-words.js';

const now = new Date('2026-10-15T12:00:00.000Z');

describe('elapsedWords', () => {
  it.each([
    ['2026-10-15T11:59:30.000Z', 'less than a minute'],
    ['2026-10-15T11:59:00.000Z', '1 minute'],
    ['2026-10-15T11:20:00.000Z', '40 minutes'],
    ['2026-10-15T11:00:00.000Z', '1 hour'],
    ['2026-10-15T00:00:01.000Z', '11 hours'],
    ['2026-10-14T12:00:00.000Z', '1 day'],
    ['2026-10-12T11:00:00.000Z', '3 days'],
  ])('says %s is %s before noon', (since, words) => {
    expect(elapsedWords(new Date(since), now)).toBe(words);
  });

  it('reads the text Postgres hands a raw query for a timestamptz', () => {
    expect(elapsedWords('2026-10-15 10:26:16.817935+00', now)).toBe('1 hour');
  });

  it('says less than a minute for a time the clock has not reached', () => {
    expect(elapsedWords('2026-10-15T12:05:00.000Z', now)).toBe('less than a minute');
  });

  it('refuses a value that is not a time, naming it', () => {
    expect(() => elapsedWords('yesterday-ish', now)).toThrow(/"yesterday-ish" is not a time/);
  });
});
