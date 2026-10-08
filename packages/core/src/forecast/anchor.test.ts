import { say } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { type CycleSample, concurrencyOf, runForecast, type WorkItem } from './model.js';
import { lastMove, moveBetween } from './moves.js';
import { clockOf } from './read.js';

// HOP's REQ-7 forecast went from 12:28 to 14:34 in 28 minutes with nothing on screen saying why: a
// queued item's date was "now + a draw", so the clock alone moved it. Anchored on the last event, two
// reads with no event between them give the same dates; an event that moves them names itself.

const MINUTE = 60_000;
const EVENT_AT = new Date('2026-10-08T09:00:00Z');
const samples: CycleSample[] = Array.from({ length: 40 }, (_, i) => ({
  minutes: 60 + i * 5,
  complexity: null,
}));
const item = (key: string, rank: number, over: Partial<WorkItem> = {}): WorkItem => ({
  id: key,
  key,
  complexity: null,
  landed: false,
  landedAt: null,
  ended: null,
  startedAt: null,
  rank,
  blockedBy: [],
  wait: null,
  ...over,
});

const read = (readAt: Date) =>
  runForecast({
    ...clockOf({ at: EVENT_AT }, readAt),
    items: [
      item('ISS-88', 1, { startedAt: new Date(EVENT_AT.getTime() - 30 * MINUTE) }),
      item('ISS-72', 2),
    ],
    history: { samples, spanDays: 20, peak: 2, width: null },
    projectWait: null,
    writers: [],
    seed: 7,
  }).forecasts;

describe('an anchored forecast', () => {
  it('gives the same dates to two reads 30 minutes apart with no event between them', () => {
    const at9 = read(new Date('2026-10-08T09:09:00Z'));
    const at937 = read(new Date('2026-10-08T09:37:00Z'));
    for (const key of ['ISS-88', 'ISS-72']) {
      const a = at9.get(key);
      const b = at937.get(key);
      if (a?.kind !== 'forecast' || b?.kind !== 'forecast') throw new Error(`${key} has no range`);
      expect([b.p50At, b.p85At]).toEqual([a.p50At, a.p85At]);
      expect(b.anchoredAt).toBe(EVENT_AT.toISOString());
    }
  });

  it('carries a confidence read off its sample and its width', () => {
    const f = read(EVENT_AT).get('ISS-72');
    if (f?.kind !== 'forecast') throw new Error('no range');
    expect(f.confidence.n).toBe(40);
    expect(['high', 'medium', 'low']).toContain(f.confidence.level);
  });
});

describe('a forecast move', () => {
  const at = (
    p50: string,
    p85: string,
    anchoredAt: string,
    event = say('forecast.event.none'),
  ) => ({
    anchoredAt,
    p50At: p50,
    p85At: p85,
    event,
  });
  const before = at(
    '2026-10-08T12:28:00.000Z',
    '2026-10-08T18:42:00.000Z',
    '2026-10-08T09:00:00.000Z',
  );
  const landedLate = say('forecast.event.transition', {
    key: 'ISS-88',
    status: 'awaiting_release',
  });
  const after = at(
    '2026-10-08T14:34:00.000Z',
    '2026-10-09T01:21:00.000Z',
    '2026-10-08T09:30:00.000Z',
    landedLate,
  );

  it('says how far the dates moved and the event that moved them', () => {
    expect(moveBetween(before, after)).toMatchObject({ byMinutes: 126, because: landedLate });
  });

  it('is no move where an event left the dates where they were', () => {
    expect(moveBetween(before, { ...before, anchoredAt: '2026-10-08T09:10:00.000Z' })).toBeNull();
  });

  it('reads the last anchor that moved the dates, past anchors that did not', () => {
    const quiet = {
      ...after,
      anchoredAt: '2026-10-08T10:00:00.000Z',
      event: say('forecast.event.runStartedAny'),
    };
    expect(lastMove([quiet, after, before], quiet.anchoredAt)).toMatchObject({
      byMinutes: 126,
      because: landedLate,
    });
  });
});

describe("the master's wave width", () => {
  // 40 landings a day of 160 min mean: Little reads 4+ at once; HOP's master runs a wave of 2
  const busy = { samples, spanDays: 1, peak: 4 };

  it('holds the lanes to the width the master declares', () => {
    expect(concurrencyOf({ ...busy, width: 2 })?.value).toBe(2);
    expect(concurrencyOf({ ...busy, width: 2 })?.basis).toMatch(/max_job_panes/);
  });

  it('is not read where the master declares none', () => {
    expect(concurrencyOf({ ...busy, width: null })?.value).toBe(4);
  });
});
