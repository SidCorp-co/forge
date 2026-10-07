import type { Forecast, ForecastBasis } from '@forge/contracts/forecast';
import { describe, expect, it } from 'vitest';
import { deliveryOf, type ReleaseFacts, releaseLegOf } from './delivery.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const MINUTE = 60_000;
const asOf = NOW.toISOString();
const stamp = { label: 'forecast' as const, asOf };
const basis: ForecastBasis = {
  n: 20,
  floor: 10,
  windowDays: 60,
  complexity: null,
  cycleP50Minutes: 60,
  cycleP85Minutes: 60,
  throughputPerDay: 1,
  concurrency: 1,
  concurrencyBasis: 'test',
};
const range: Forecast = {
  ...stamp,
  kind: 'forecast',
  p50At: asOf,
  p85At: asOf,
  p50Minutes: 120,
  p85Minutes: 120,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis,
  late: null,
};
const lags = (n: number, minutes = 30) => Array.from({ length: n }, () => minutes);
const automatic = (n = 12, minutes = 30): ReleaseFacts => ({
  mode: 'automatic',
  nextVersion: '0.2.0',
  lags: lags(n, minutes),
});

const deliver = (over: Partial<Parameters<typeof deliveryOf>[0]>) =>
  deliveryOf({
    asOf,
    now: NOW,
    landing: range,
    trials: Float64Array.from({ length: 100 }, () => 120),
    landedAt: null,
    shipped: null,
    release: automatic(),
    seed: 3,
    ...over,
  });

describe('delivery: in people’s hands, not merged', () => {
  it('adds the sampled release lag to every landing trial where production releases on its own', () => {
    const d = deliver({});
    expect(d.release).toMatchObject({ kind: 'automatic', basis: { n: 12, lagP50Minutes: 30 } });
    expect(d.inHands).toMatchObject({ p50Minutes: 150, p85Minutes: 150 });
  });

  it('names the person and the act, with no date, where a person cuts the release', () => {
    const d = deliver({ release: { mode: 'manual', nextVersion: '0.1.0', lags: lags(40) } });
    expect(d.release).toMatchObject({ kind: 'person', who: 'A project admin', act: 'cut 0.1.0' });
    expect(d.inHands).toBeNull();
  });

  it('names the approver where the project requires an approval, even on land', () => {
    const leg = releaseLegOf({ mode: 'approval', nextVersion: '1.4.0', lags: lags(40) });
    expect(leg).toMatchObject({ kind: 'person', who: 'A release approver' });
    expect(leg.kind === 'person' && leg.act).toBe('cut 1.4.0, then approve it');
  });

  it('gives no in-hands span below the release history floor', () => {
    const d = deliver({ release: automatic(9) });
    expect(d.release).toEqual({ kind: 'not_enough_history', n: 9, floor: 10 });
    expect(d.inHands).toBeNull();
  });

  it('reads a landed change still waiting as the lag left after its age', () => {
    const d = deliver({
      landing: { ...stamp, kind: 'landed', landedAt: asOf },
      trials: null,
      landedAt: new Date(NOW.getTime() - 20 * MINUTE),
      release: { mode: 'automatic', nextVersion: null, lags: [...lags(6, 10), ...lags(6, 50)] },
    });
    expect(d.inHands).toMatchObject({ p50Minutes: 30, p85Minutes: 30 });
  });

  it('says shipped, with nothing forecast, once every issue shipped', () => {
    const d = deliver({ shipped: { version: '0.3.1', at: asOf } });
    expect(d).toMatchObject({ shipped: { version: '0.3.1' }, release: null, inHands: null });
  });

  it('carries a paused landing through with no release and no span', () => {
    const paused: Forecast = {
      ...stamp,
      kind: 'paused',
      who: 'A project writer',
      act: 'answer a question',
      reason: 'r',
      ref: null,
      since: null,
      late: null,
    };
    expect(deliver({ landing: paused })).toMatchObject({
      landing: { kind: 'paused' },
      release: null,
      inHands: null,
      shipped: null,
    });
  });
});
