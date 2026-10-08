import { describe, expect, it } from 'vitest';
import { storedText } from './data-egress.js';

// the text a sensitive project stores for a feedback title or body (`preparedFeedback` passes both
// through `storedText`): a phone number is masked however it was typed, a date or a time is kept
const stored = (text: string) => storedText('redact', text).text;

describe('a phone number in stored text', () => {
  it.each([
    ['contiguous', 'call 0912345678 back'],
    ['spaced', 'call 0912 345 678 back'],
    ['dotted', 'call 0912.345.678 back'],
    ['dashed', 'call 0912-345-678 back'],
    ['country code', 'call +84 912 345 678 back'],
    ['non-breaking spaces', 'call 0912 345 678 back'],
    ['thin spaces', 'call 0912 345 678 back'],
    ['narrow no-break spaces', 'call 0912 345 678 back'],
    ['en dashes', 'call 0912–345–678 back'],
    ['spaced en dashes', 'call 0912 – 345 – 678 back'],
  ])('is masked when written %s', (_how, text) => {
    expect(stored(text)).toBe('call [number] back');
  });

  it('masks an area code in brackets with its number', () => {
    expect(stored('call (028) 3822 1234 in office hours')).toBe('call [number] in office hours');
    expect(stored('call +84 (0) 912 345 678')).toBe('call [number]');
  });

  it('masks two numbers written side by side, each on its own', () => {
    expect(stored('phones 0912 345 678 0913 456 789')).toBe('phones [number] [number]');
    expect(stored('phones 028 3822 1234 0912 345 678')).toBe('phones [number] [number]');
  });

  it('counts each masked number', () => {
    expect(storedText('redact', 'call 0912 345 678 or 0913 456 789').redactions).toBe(2);
  });

  it('keeps a date followed by a time', () => {
    expect(stored('failed at 2026-10-08 14:30')).toBe('failed at 2026-10-08 14:30');
    expect(stored('failed at 08.10.2026 14:30')).toBe('failed at 08.10.2026 14:30');
  });

  it('masks a number written just before a time', () => {
    expect(stored('0912 345 678 14:30')).toBe('[number] 14:30');
  });

  it('keeps short numbers, versions and a long run with no phone in it', () => {
    expect(stored('build 0.4.0-dev.158, code 12345678')).toBe('build 0.4.0-dev.158, code 12345678');
    expect(stored('id 1234 5678 9012 3456 7890 1234')).toBe('id 1234 5678 9012 3456 7890 1234');
  });

  it('stores the text as written on a project with no restriction', () => {
    expect(storedText('off', 'call 0912 345 678 back').text).toBe('call 0912 345 678 back');
  });
});
