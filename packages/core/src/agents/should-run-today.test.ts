import { describe, expect, it } from 'vitest';
import { shouldRunToday } from './should-run-today.js';

describe('shouldRunToday', () => {
  it("'off' is always false", () => {
    expect(shouldRunToday('off', new Date('2026-05-04T00:00:00Z'))).toBe(false);
    expect(shouldRunToday('off', new Date('2026-05-05T12:00:00Z'))).toBe(false);
    expect(shouldRunToday('off', new Date('2026-01-01T00:00:00Z'))).toBe(false);
  });

  it("'weekly' true only on Monday", () => {
    expect(shouldRunToday('weekly', new Date('2026-05-04T00:00:00Z'))).toBe(true); // Mon
    expect(shouldRunToday('weekly', new Date('2026-05-05T00:00:00Z'))).toBe(false); // Tue
    expect(shouldRunToday('weekly', new Date('2026-05-10T00:00:00Z'))).toBe(false); // Sun
  });

  it("'biweekly' true on Monday of even-indexed weeks (anchor 2024-01-01)", () => {
    // 2024-01-01 is anchor week-0 (even) → true
    expect(shouldRunToday('biweekly', new Date('2024-01-01T00:00:00Z'))).toBe(true);
    // 2024-01-08 is week-1 (odd) → false
    expect(shouldRunToday('biweekly', new Date('2024-01-08T00:00:00Z'))).toBe(false);
    // 2024-01-15 is week-2 (even) → true
    expect(shouldRunToday('biweekly', new Date('2024-01-15T00:00:00Z'))).toBe(true);
    // Tuesday of an even week is still false
    expect(shouldRunToday('biweekly', new Date('2024-01-16T00:00:00Z'))).toBe(false);
  });

  it("'monthly' true only on day 1 of the month", () => {
    expect(shouldRunToday('monthly', new Date('2026-05-01T00:00:00Z'))).toBe(true);
    expect(shouldRunToday('monthly', new Date('2026-05-02T00:00:00Z'))).toBe(false);
    expect(shouldRunToday('monthly', new Date('2026-05-31T23:59:59Z'))).toBe(false);
  });
});
