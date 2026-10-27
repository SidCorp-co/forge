import { describe, expect, it } from 'vitest';
import { durationWords, elapsedWords, utcMomentWords } from './elapsed-words.js';

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

describe('durationWords', () => {
  it.each([
    [30_000, 'less than a minute'],
    [900_000, '15 minutes'],
    [3 * 3_600_000, '3 hours'],
    [2 * 86_400_000, '2 days'],
  ])('says %i ms as %s, the words elapsedWords uses', (ms, words) => {
    expect(durationWords(ms)).toBe(words);
  });
});

describe('utcMomentWords', () => {
  it('says a moment as a person reads it, in UTC, never as an ISO stamp', () => {
    expect(utcMomentWords('2026-10-21T14:53:09.000Z')).toBe('21 October 2026, 14:53 UTC');
  });

  it('says a value that is not a time is unreadable, rather than printing it', () => {
    expect(utcMomentWords('soon')).toBe('a time that could not be read');
  });
});
