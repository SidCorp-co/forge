/**
 * ISS-1056 — the window is the ISO week BEFORE the tick's, so Monday's tick and Tuesday's retry
 * name the same week, and its id is the one every artifact carries.
 */

import { describe, expect, it } from 'vitest';
import { weekBefore } from './window.js';

describe('weekBefore', () => {
  it('names Monday 00:00 UTC to the next Monday 00:00 UTC of the week before', () => {
    const w = weekBefore(new Date('2026-09-14T04:00:00Z')); // a Monday
    expect(w.from.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(w.id).toBe('2026-09-07..2026-09-14');
  });

  it('a Tuesday retry, a Sunday-night tick and a Monday 00:00 tick all name the same window', () => {
    const monday = weekBefore(new Date('2026-09-14T04:00:00Z')).id;
    expect(weekBefore(new Date('2026-09-15T09:30:00Z')).id).toBe(monday);
    expect(weekBefore(new Date('2026-09-20T23:59:59Z')).id).toBe(monday);
    expect(weekBefore(new Date('2026-09-14T00:00:00Z')).id).toBe(monday);
  });

  it('the week before Monday 00:00 is the week that ended a second earlier, never the same week', () => {
    expect(weekBefore(new Date('2026-09-13T23:59:59Z')).id).toBe('2026-08-31..2026-09-07');
    expect(weekBefore(new Date('2026-09-14T00:00:00Z')).id).toBe('2026-09-07..2026-09-14');
  });

  it('crosses a month and a year boundary by the calendar, not by the month', () => {
    expect(weekBefore(new Date('2026-01-01T12:00:00Z')).id).toBe('2025-12-22..2025-12-29');
  });
});
