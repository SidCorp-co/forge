import { describe, expect, it } from 'vitest';
import { addWorkingDays } from './working-days.js';

describe('addWorkingDays', () => {
  it('counts Monday to Friday only', () => {
    // 2026-10-01 is a Thursday
    expect(addWorkingDays(new Date('2026-10-01T09:00:00Z'), 2).toISOString()).toBe(
      '2026-10-05T09:00:00.000Z',
    );
    expect(addWorkingDays(new Date('2026-10-05T09:00:00Z'), 5).toISOString()).toBe(
      '2026-10-12T09:00:00.000Z',
    );
  });

  it('starts a weekend count from the following Monday', () => {
    expect(addWorkingDays(new Date('2026-10-03T12:00:00Z'), 1).toISOString()).toBe(
      '2026-10-05T12:00:00.000Z',
    );
    expect(addWorkingDays(new Date('2026-10-03T12:00:00Z'), 0).toISOString()).toBe(
      '2026-10-05T12:00:00.000Z',
    );
  });
});
