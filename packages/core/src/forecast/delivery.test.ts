import type { Forecast, ForecastBasis } from '@forge/contracts/forecast';
import { say, verbatim } from '@forge/contracts/said';
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
  anchoredAt: asOf,
  confidence: { level: 'medium', n: 12, spread: 0 },
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

  it('names the admins and the act, with no date, where a person cuts the release', () => {
    const d = deliver({
      release: {
        mode: 'manual',
        nextVersion: '0.1.0',
        lags: lags(40),
        holders: [{ id: 'a', name: 'Ada', kind: 'human' }],
      },
    });
    expect(d.release).toMatchObject({ kind: 'person', who: 'Ada', act: 'cut 0.1.0' });
    expect(d.inHands).toBeNull();
  });

  it('names the approver where the project requires an approval, even on land', () => {
    const leg = releaseLegOf({
      mode: 'approval',
      nextVersion: '1.4.0',
      lags: lags(40),
      holders: [{ id: 'd', name: 'Dana Lee', kind: 'human' }],
    });
    expect(leg).toMatchObject({ kind: 'person', who: 'Dana Lee' });
    expect(leg.kind === 'person' && leg.act).toBe('cut 1.4.0, then approve it');
  });

  it('says nobody holds the permission, and where it is granted, for each mode a person owes', () => {
    for (const [mode, permission] of [
      ['approval', 'releases.approve'],
      ['manual', 'project.admin'],
      ['none', 'project.write'],
    ] as const) {
      const leg = releaseLegOf({ mode, nextVersion: '0.1.0', lags: [], holders: [] });
      expect(leg, mode).toMatchObject({ kind: 'person', who: 'Nobody', holders: [] });
      expect(leg.kind === 'person' && leg.act, mode).toContain(
        `no person on this project holds ${permission} until it is granted under Settings → Members`,
      );
    }
  });

  it('names the people who hold the approval, three then the count, with the version the cut takes', () => {
    const h = (name: string, kind: 'human' | 'agent' = 'human') => ({ id: name, name, kind });
    const one = releaseLegOf({
      mode: 'approval',
      nextVersion: '0.1.0',
      lags: [],
      holders: [h('Dana Lee')],
    });
    expect(one).toMatchObject({ kind: 'person', who: 'Dana Lee', version: '0.1.0' });
    const two = releaseLegOf({
      mode: 'approval',
      nextVersion: '0.1.0',
      lags: [],
      holders: [h('bot', 'agent'), h('Dana Lee'), h('Sam Ng')].slice(1),
    });
    expect(two).toMatchObject({ who: 'Dana Lee, Sam Ng' });
    const many = releaseLegOf({
      mode: 'approval',
      nextVersion: '0.1.0',
      lags: [],
      holders: [h('a'), h('b'), h('c'), h('d'), h('e')],
    });
    expect(many).toMatchObject({ who: 'a, b, c +2' });
    expect(many.kind === 'person' && many.reason).toContain('a, b, c, d, e');
  });

  // JU-7: hop's dashboard read 'then orchestrator cuts it' to orchestrator, beside Needs-you's 'You · cut 0.3.0'
  it('names the reader as You where the release act is theirs, whatever the mode', () => {
    const h = { id: 'o1', name: 'orchestrator', kind: 'human' as const };
    const mine = (mode: 'approval' | 'manual' | 'none') =>
      releaseLegOf({ mode, nextVersion: '0.3.0', lags: [], holders: [h], viewerOwes: true });
    expect(mine('approval')).toMatchObject({ who: 'You', act: 'cut 0.3.0, then approve it' });
    expect(mine('manual')).toMatchObject({ who: 'You', act: 'cut 0.3.0' });
    expect(mine('none')).toMatchObject({ who: 'You', act: 'release it by hand and close it' });
    const theirs = releaseLegOf({ mode: 'approval', nextVersion: '0.3.0', lags: [], holders: [h] });
    expect(theirs).toMatchObject({ who: 'orchestrator' });
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
      says: {
        who: say('standing.who.named', { name: 'A project writer' }),
        act: say('issues.standing.act.answer'),
        reason: verbatim('r'),
      },
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
