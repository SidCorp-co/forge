import { describe, expect, it } from 'vitest';
import { isoOf, isoOrNull } from './iso-time.js';

describe('isoOrNull', () => {
  it("turns Postgres's own text into ISO", () => {
    expect(isoOrNull('2026-10-20 04:15:53.658+00')).toBe('2026-10-20T04:15:53.658Z');
    expect(isoOrNull('2026-10-20 06:15:53+02')).toBe('2026-10-20T04:15:53.000Z');
    expect(isoOrNull('2026-10-20 04:15:53.658+05:30')).toBe('2026-10-19T22:45:53.658Z');
  });

  it('answers a Date and an ISO string as ISO', () => {
    expect(isoOrNull(new Date('2026-10-20T04:15:53.658Z'))).toBe('2026-10-20T04:15:53.658Z');
    expect(isoOf('2026-10-20T04:15:53.658Z')).toBe('2026-10-20T04:15:53.658Z');
  });

  it('answers null for no value', () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
  });

  it('refuses by name a value that is not a timestamp', () => {
    expect(() => isoOrNull('yesterday')).toThrow('"yesterday" is not a timestamp');
  });
});
