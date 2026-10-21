import type {
  DeliveryForecast,
  Forecast,
  ForecastBasis,
  ForecastPaused,
  ReleaseLeg,
} from '@forge/contracts/forecast';
import type { RunStanding, RunState } from '@forge/contracts/run-standing';
import { say } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { progressOf } from './progress.js';

const asOf = '2026-10-16T09:00:00.000Z';
const stamp = { label: 'forecast' as const, asOf };
const basis: ForecastBasis = {
  n: 20,
  floor: 10,
  windowDays: 60,
  complexity: null,
  cycleP50Minutes: 60,
  cycleP85Minutes: 90,
  throughputPerDay: 1,
  concurrency: 1,
  concurrencyBasis: 'test',
};
const range: Forecast = {
  ...stamp,
  kind: 'forecast',
  anchoredAt: asOf,
  confidence: { level: 'medium', n: 20, spread: 0.5 },
  p50At: '2026-10-18T09:00:00.000Z',
  p85At: '2026-10-20T09:00:00.000Z',
  p50Minutes: 2880,
  p85Minutes: 5760,
  ahead: 1,
  aheadKeys: ['ISS-2'],
  waitsOn: [],
  basis,
  late: null,
};
const paused: ForecastPaused = {
  ...stamp,
  kind: 'paused',
  who: 'Minh',
  act: 'answer a question',
  reason: 'a run asked',
  says: {
    who: say('standing.who.you'),
    act: say('standing.act.none'),
    reason: say('standing.act.none'),
  },
  ref: 'ISS-4',
  since: asOf,
  late: null,
};
const personLeg: ReleaseLeg = {
  kind: 'person',
  mode: 'manual',
  who: 'Ada',
  act: 'cut 0.2.0',
  reason: 'an admin cuts each release',
  says: {
    who: say('standing.who.you'),
    act: say('standing.act.none'),
    reason: say('standing.act.none'),
  },
  version: '0.2.0',
  holders: [{ id: 'a', name: 'Ada', kind: 'human' }],
};
const delivery = (over: Partial<DeliveryForecast>): DeliveryForecast => ({
  ...stamp,
  landing: range,
  release: {
    kind: 'automatic',
    basis: { n: 12, floor: 10, windowDays: 60, lagP50Minutes: 30, lagP85Minutes: 40 },
  },
  inHands: {
    p50At: '2026-10-18T10:00:00.000Z',
    p85At: '2026-10-20T10:00:00.000Z',
    p50Minutes: 2940,
    p85Minutes: 5800,
  },
  shipped: null,
  ...over,
});

/** A run on `key` in `state`; only the fields the block reads are real. */
function run(key: string, state: RunState, over: Partial<RunStanding> = {}): RunStanding {
  return {
    id: `run-${key}-${state}`,
    title: `Build ${key}`,
    issue: { key, title: `issue ${key}`, status: 'in_progress' },
    issues: [key],
    state,
    since: asOf,
    step: { source: 'run_column', step: 'implement', since: null },
    waitingOn: {
      kind: 'person',
      who: 'Minh',
      act: 'answer a question',
      rule: 'the run asked',
      ref: null,
      dueAt: null,
      says: {
        who: say('standing.who.you'),
        act: say('standing.act.none'),
        rule: say('standing.act.none'),
      },
    },
    ...over,
  } as unknown as RunStanding;
}

const base = {
  asOf,
  work: { total: 2, shipped: 0, awaitingRelease: 0, toDo: 2 },
  runs: [],
  waits: [],
  noDelivery: 'no issue carries it yet',
};

describe('the progress block: is work running, and when is it done', () => {
  it('dates a forecast in people’s hands and says it in one paragraph', () => {
    const p = progressOf({ ...base, delivery: delivery({}) });
    expect(p.eta).toMatchObject({
      estimate: true,
      likelyBy: '2026-10-18T10:00:00.000Z',
      almostSurelyBy: '2026-10-20T10:00:00.000Z',
      of: 'hands',
      confidence: 'medium',
    });
    expect(p.says).toContain('Likely done by 2026-10-18, almost surely by 2026-10-20');
    expect(p).toMatchObject({ label: 'forecast', asOf, running: false });
  });

  it('names the runs working right now', () => {
    const p = progressOf({ ...base, runs: [run('ISS-3', 'running')], delivery: delivery({}) });
    expect(p.running).toBe(true);
    expect(p.runs).toEqual([
      expect.objectContaining({ issue: 'ISS-3', state: 'running', step: 'implement' }),
    ]);
    expect(p.says).toMatch(/^Running now: ISS-3 \(implement\)\./);
  });

  it('says nothing runs where its only run is queued, and names the queued one', () => {
    const p = progressOf({ ...base, runs: [run('ISS-3', 'queued')], delivery: delivery({}) });
    expect(p.running).toBe(false);
    expect(p.says).toMatch(/^Nothing is running right now; ISS-3 is queued\./);
  });

  it('lists a run waiting on a person, and a gate by its name, among the waits', () => {
    const gate = run('ISS-5', 'waiting_gate', {
      waitingOn: {
        kind: 'gate',
        gate: 'deploy lock',
        resumesAt: null,
        rule: 'another run holds it',
        says: { rule: say('standing.act.none') },
      },
    });
    const p = progressOf({
      ...base,
      runs: [run('ISS-3', 'waiting_person'), gate],
      delivery: delivery({}),
    });
    expect(p.waitingOn).toEqual([
      expect.objectContaining({ who: 'Minh', act: 'answer a question', ref: 'ISS-3' }),
      expect.objectContaining({ who: 'A gate', act: 'deploy lock', ref: 'ISS-5' }),
    ]);
    expect(p.says).toContain('Waiting on Minh to answer a question.');
  });

  it('states why there is no estimate where nothing carries the work', () => {
    const p = progressOf({ ...base, work: null, delivery: null, noDelivery: 'it is a draft' });
    expect(p.eta).toEqual({ estimate: false, done: false, why: 'it is a draft' });
    expect(p.says).toBe('Nothing is running right now. No estimate: it is a draft.');
  });

  it('refuses to compose a block whose missing ETA has no reason', () => {
    expect(() => progressOf({ ...base, delivery: null, noDelivery: '  ' })).toThrow(
      /no delivery forecast and no reason why/,
    );
  });

  it('gives no date under the history floor, and says the count', () => {
    const p = progressOf({
      ...base,
      delivery: delivery({
        landing: { ...stamp, kind: 'not_enough_history', n: 3, floor: 10 },
        release: null,
        inHands: null,
      }),
    });
    expect(p.eta).toEqual({
      estimate: false,
      done: false,
      why: 'not enough history, 3 of 10 landed issues',
    });
  });

  it('names a paused landing’s person as a wait, with no date', () => {
    const p = progressOf({
      ...base,
      delivery: delivery({ landing: paused, release: null, inHands: null }),
    });
    expect(p.eta).toEqual({
      estimate: false,
      done: false,
      why: 'waits on Minh to answer a question',
    });
    expect(p.waitingOn).toEqual([
      expect.objectContaining({ who: 'Minh', act: 'answer a question', ref: 'ISS-4' }),
    ]);
  });

  it('dates the landing alone where a person cuts the release, and names that act', () => {
    const p = progressOf({ ...base, delivery: delivery({ release: personLeg, inHands: null }) });
    expect(p.eta).toMatchObject({ estimate: true, of: 'landing', likelyBy: range.p50At });
    expect(p.waitingOn).toEqual([expect.objectContaining({ who: 'Ada', act: 'cut 0.2.0' })]);
    expect(p.says).toContain('merged; its release has no date');
  });

  it('says shipped work is done, in its version', () => {
    const p = progressOf({
      ...base,
      delivery: delivery({
        landing: { ...stamp, kind: 'landed', landedAt: asOf },
        release: null,
        inHands: null,
        shipped: { version: '0.0.3', at: null },
      }),
    });
    expect(p.eta).toEqual({ estimate: false, done: true, why: 'shipped in 0.0.3' });
    expect(p.says).toContain('Done: shipped in 0.0.3.');
  });
});
