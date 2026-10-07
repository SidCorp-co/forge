/**
 * Done as a person means it, pure: the landing forecast, then what the release adds before the
 * change is in their hands. Where production releases on its own, the project's own landed→released
 * durations are sampled trial by trial onto the landing (the same seeded Monte Carlo, the same floor);
 * where a person cuts, approves or releases by hand, the act is named and no date is given for it
 * (VISION: state-never-lies). Every rule here is a unit test in `delivery.test.ts`.
 */

import {
  type DeliveryForecast,
  FORECAST_HISTORY_FLOOR,
  FORECAST_LABEL,
  FORECAST_TRIALS,
  FORECAST_WINDOW_DAYS,
  type Forecast,
  type ForecastSpan,
  type ReleaseLeg,
  type ReleaseMode,
} from '@forge/contracts/forecast';
import { percentile, seeded } from './model.js';

const MINUTE = 60_000;

export interface ReleaseFacts {
  mode: ReleaseMode;
  /** The number the next cut takes, named in the act a person owes. */
  nextVersion: string | null;
  /** Landed→released minutes of the project's issues shipped in the window. */
  lags: readonly number[];
  floor?: number;
}

export interface Shipped {
  version: string | null;
  at: string | null;
}

const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);

export function releaseLegOf(r: ReleaseFacts): ReleaseLeg {
  const floor = r.floor ?? FORECAST_HISTORY_FLOOR;
  const version = r.nextVersion ?? 'the next version';
  switch (r.mode) {
    case 'automatic': {
      if (r.lags.length < floor) return { kind: 'not_enough_history', n: r.lags.length, floor };
      const sorted = ascending(r.lags);
      return {
        kind: 'automatic',
        basis: {
          n: sorted.length,
          floor,
          windowDays: FORECAST_WINDOW_DAYS,
          lagP50Minutes: Math.round(percentile(sorted, 0.5)),
          lagP85Minutes: Math.round(percentile(sorted, 0.85)),
        },
      };
    }
    case 'approval':
      return {
        kind: 'person',
        mode: 'approval',
        who: 'A release approver',
        act: `cut ${version}, then approve it`,
        reason:
          'this project requires a holder of releases.approve to approve each release, so no date is forecast for it',
      };
    case 'manual':
      return {
        kind: 'person',
        mode: 'manual',
        who: 'A project admin',
        act: `cut ${version}`,
        reason:
          "this project's production does not deploy on land, so an admin cuts each release and no date is forecast for it",
      };
    case 'none':
      return {
        kind: 'person',
        mode: 'none',
        who: 'A project writer',
        act: 'release it by hand and close it',
        reason:
          'this project declares no production environment, so no release carries a landed change',
      };
  }
}

export function spanOf(now: Date, minutes: Float64Array): ForecastSpan {
  const sorted = Float64Array.from(minutes).sort();
  const p50 = Math.round(percentile(sorted, 0.5));
  const p85 = Math.round(percentile(sorted, 0.85));
  return {
    p50Minutes: p50,
    p85Minutes: p85,
    p50At: new Date(now.getTime() + p50 * MINUTE).toISOString(),
    p85At: new Date(now.getTime() + p85 * MINUTE).toISOString(),
  };
}

/**
 * The release lag still ahead of a change `age` minutes past its landing: drawn from the releases
 * that took at least that long, as an issue in flight is drawn from the landings that ran longer; one
 * older than every release on record has no such history and is drawn as a fresh lag.
 */
function lagDraw(lags: readonly number[], random: () => number) {
  return (age: number): number => {
    const longer = age > 0 ? lags.filter((m) => m > age) : lags;
    const pool = longer.length > 0 ? longer : lags;
    const drawn = pool[Math.floor(random() * pool.length)] as number;
    return longer.length > 0 ? drawn - age : drawn;
  };
}

export interface DeliveryInput {
  asOf: string;
  now: Date;
  landing: Forecast;
  /** Each trial's landing in minutes from now, where `landing` is a range. */
  trials: Float64Array | null;
  /** The last landing, where `landing` is landed and something is still unshipped. */
  landedAt: Date | null;
  shipped: Shipped | null;
  release: ReleaseFacts;
  seed: number;
}

export function deliveryOf(i: DeliveryInput): DeliveryForecast {
  const stamp = { label: FORECAST_LABEL, asOf: i.asOf };
  const none = { ...stamp, landing: i.landing, release: null, inHands: null };
  if (i.shipped) return { ...none, shipped: i.shipped };
  if (i.landing.kind !== 'forecast' && i.landing.kind !== 'landed')
    return { ...none, shipped: null };
  const leg = releaseLegOf(i.release);
  if (leg.kind !== 'automatic') return { ...none, release: leg, shipped: null };
  const draw = lagDraw(i.release.lags, seeded(i.seed));
  let inHands: ForecastSpan | null = null;
  if (i.landing.kind === 'forecast' && i.trials) {
    const at = i.trials.map((landsIn) => landsIn + draw(0));
    inHands = spanOf(i.now, at);
  } else if (i.landing.kind === 'landed') {
    const age = i.landedAt ? Math.max(0, (i.now.getTime() - i.landedAt.getTime()) / MINUTE) : 0;
    inHands = spanOf(
      i.now,
      Float64Array.from({ length: FORECAST_TRIALS }, () => draw(age)),
    );
  }
  return { ...stamp, landing: i.landing, release: leg, inHands, shipped: null };
}
