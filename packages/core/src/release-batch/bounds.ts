import type { ReleaseAttemptRow } from './ledger.js';

/** Defaults, and there is no per-project override — see the plan's trade note. */
export const BOUND_DEFAULTS = {
  total: 90 * 60_000,
  stall: 25 * 60_000,
} as const;

export type BoundName = 'total' | 'stall' | 'regression';

export interface BoundReading {
  name: BoundName;
  crossed: boolean;
  /** Milliseconds for the duration bounds; `null` for `regression`. */
  measuredMs: number | null;
  thresholdMs: number | null;
  why: string;
}

export interface BoundsReading {
  holding: boolean;
  /** The bounds that are crossed, in the order below. */
  crossedNames: BoundName[];
  bounds: BoundReading[];
}

function settled(attempts: ReleaseAttemptRow[]): ReleaseAttemptRow[] {
  return attempts.filter((a) => a.settledAt !== null);
}

/** Whether the newest settled reading is `down` after an earlier `up`, and what the ledger shows. */
function readRegression(readings: ReleaseAttemptRow[]): { crossed: boolean; why: string } {
  const newest = readings.at(-1);
  if (newest === undefined) {
    return {
      crossed: false,
      why: 'no attempt on this run has settled, so there is no reading to compare',
    };
  }
  if (newest.health === 'up') {
    return { crossed: false, why: 'the newest settled attempt reads the application up' };
  }
  if (newest.health !== 'down') {
    return { crossed: false, why: 'the newest settled attempt recorded no health reading' };
  }
  if (!readings.slice(0, -1).some((a) => a.health === 'up')) {
    return {
      crossed: false,
      why: 'the newest settled attempt reads the application down, and no settled attempt before it read it up',
    };
  }
  return {
    crossed: true,
    why: 'the newest settled attempt reads the application down after an earlier one read it up',
  };
}

/**
 * The three bounds, measured against one run's ledger.
 *
 * `now` is injected so the reading is testable without real time.
 */
export function readBounds(
  attempts: ReleaseAttemptRow[],
  opts: { now?: number; total?: number; stall?: number } = {},
): BoundsReading {
  const now = opts.now ?? Date.now();
  const totalThreshold = opts.total ?? BOUND_DEFAULTS.total;
  const stallThreshold = opts.stall ?? BOUND_DEFAULTS.stall;

  const promotions = attempts.filter((a) => a.stage === 'promote');
  const firstPromotion = promotions
    .map((a) => a.startedAt.getTime())
    .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);

  const total: BoundReading =
    firstPromotion === null
      ? {
          name: 'total',
          crossed: false,
          measuredMs: null,
          thresholdMs: totalThreshold,
          why: 'this run has recorded no promotion, so nothing has reached production to measure from',
        }
      : {
          name: 'total',
          crossed: now - firstPromotion > totalThreshold,
          measuredMs: now - firstPromotion,
          thresholdMs: totalThreshold,
          why: 'time since this run first promoted',
        };

  const lastWrite = attempts
    .flatMap((a) => [a.startedAt.getTime(), a.settledAt?.getTime() ?? Number.NEGATIVE_INFINITY])
    .reduce<number | null>((max, t) => (max === null || t > max ? t : max), null);
  const stallFrom = lastWrite !== null && Number.isFinite(lastWrite) ? lastWrite : firstPromotion;
  const stall: BoundReading =
    firstPromotion === null || stallFrom === null
      ? {
          name: 'stall',
          crossed: false,
          measuredMs: null,
          thresholdMs: stallThreshold,
          why: 'this run has recorded no promotion, so nothing has reached production to measure from',
        }
      : {
          name: 'stall',
          crossed: now - stallFrom > stallThreshold,
          measuredMs: now - stallFrom,
          thresholdMs: stallThreshold,
          why: 'time since the newest write to this run’s ledger',
        };

  const regression: BoundReading = {
    name: 'regression',
    ...readRegression(settled(attempts)),
    measuredMs: null,
    thresholdMs: null,
  };

  const bounds = [total, stall, regression];
  const crossedNames = bounds.filter((b) => b.crossed).map((b) => b.name);
  return { holding: crossedNames.length > 0, crossedNames, bounds };
}
