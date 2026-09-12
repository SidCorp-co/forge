import { describe, expect, it } from 'vitest';
import { walkFlow, weekStartsEnding } from './pulse-folds.js';
import { PULSE_FLOW_WEEKS } from './pulse-types.js';

const weeks = ['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20'];
const counts = (
  created: Record<string, number>,
  closed: Record<string, number>,
  reopened: Record<string, number>,
) => ({
  created: new Map(Object.entries(created)),
  closed: new Map(Object.entries(closed)),
  reopened: new Map(Object.entries(reopened)),
});

describe('weekStartsEnding', () => {
  it('returns twelve Mondays, oldest first, ending in the week the reader is in', () => {
    const out = weekStartsEnding(new Date('2026-09-12T06:00:00.000Z'));
    expect(out).toHaveLength(PULSE_FLOW_WEEKS);
    expect(out.at(-1)).toBe('2026-09-07');
    expect(out[0]).toBe('2026-06-22');
    for (const d of out) expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it('takes a Sunday to the Monday that opened its week, not the next one', () => {
    expect(weekStartsEnding(new Date('2026-09-13T23:00:00.000Z'), 1)).toEqual(['2026-09-07']);
  });
});

describe('walkFlow', () => {
  it('carries the backlog that stood before the window into the first week', () => {
    const out = walkFlow(weeks, counts({ '2026-06-29': 10 }, {}, {}), 543);
    expect(out[0]).toEqual({
      weekStart: '2026-06-29',
      created: 10,
      closed: 0,
      reopened: 0,
      backlog: 553,
    });
  });

  it('subtracts a close once and adds the later reopen back once', () => {
    const out = walkFlow(
      weeks,
      counts({ '2026-06-29': 1 }, { '2026-07-06': 1 }, { '2026-07-13': 1 }),
      0,
    );
    expect(out.map((w) => w.backlog)).toEqual([1, 0, 1, 1]);
    expect(out[2]?.reopened).toBe(1);
  });

  it('closes the reopened issue a second time without double-counting the first', () => {
    const out = walkFlow(
      weeks,
      counts({ '2026-06-29': 1 }, { '2026-07-06': 1, '2026-07-20': 1 }, { '2026-07-13': 1 }),
      0,
    );
    expect(out.map((w) => w.backlog)).toEqual([1, 0, 1, 0]);
    expect(out.map((w) => w.closed)).toEqual([0, 1, 0, 1]);
  });

  it('reports a week nothing happened in rather than omitting it', () => {
    const out = walkFlow(weeks, counts({}, {}, {}), 7);
    expect(out).toHaveLength(4);
    expect(out.every((w) => w.backlog === 7)).toBe(true);
  });
});
