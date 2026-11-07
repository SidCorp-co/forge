// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts
// A row's impact names its deadline as owed now with the latest day, never "due {date}", which the
// epod master read as a day to start on and parked REQ-12's check (ISS-1113).
import { describe, expect, it } from 'vitest';
import { impactOf, waitsOn } from './needs-you-decision-builders.js';

describe("a Needs-you row's deadline reads as owed now", () => {
  const row = { key: 'REQ-12', due: { stuck: false, dueAt: '2026-11-13T00:00:00.000Z' } };

  it('says the item is owed now, the date as the latest day', () => {
    expect(waitsOn(row)).toBe('REQ-12 is owed now, latest 2026-11-13');
    expect(impactOf(row, 'its delivery is accepted')).toBe(
      'REQ-12 is owed now, latest 2026-11-13; its delivery is accepted.',
    );
  });

  it('never words the date as one to wait for', () => {
    expect(waitsOn(row)).not.toMatch(/\b(due|by) 2026-11-13/);
  });

  it('keeps a stuck item said as stuck, and an undated one as waiting', () => {
    expect(waitsOn({ ...row, due: { stuck: true, dueAt: row.due.dueAt } })).toBe(
      'REQ-12 is stuck until this is decided',
    );
    expect(waitsOn({ key: 'REQ-12' })).toBe('REQ-12 waits on this');
  });
});
