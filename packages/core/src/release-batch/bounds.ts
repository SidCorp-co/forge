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

/** Where a run's silence is measured from, and which of the two moments that is. */
export interface StallOrigin {
  at: number;
  from: 'ledger' | 'taken';
}

/**
 * The newest write to the run's ledger, or the time a box took its job where that is newer than
 * every write. A write at the same instant as the job is the ledger's: it is the later act.
 */
export function stallOrigin(
  attempts: ReleaseAttemptRow[],
  takenAt?: Date | null,
): StallOrigin | null {
  const newestWrite = attempts
    .flatMap((a) => [a.startedAt.getTime(), ...(a.settledAt ? [a.settledAt.getTime()] : [])])
    .reduce<number | null>((max, t) => (max === null || t > max ? t : max), null);
  const taken = takenAt?.getTime() ?? null;
  if (taken !== null && (newestWrite === null || taken > newestWrite)) {
    return { at: taken, from: 'taken' };
  }
  return newestWrite === null ? null : { at: newestWrite, from: 'ledger' };
}

const STALL_WHY: Record<StallOrigin['from'], string> = {
  ledger: 'time since the newest write to this run’s ledger',
  taken: 'time since a box took this run’s job, with nothing written to its ledger since',
};

/**
 * The three bounds, measured against one run's ledger.
 *
 * `now` is injected so the reading is testable without real time. `takenAt` is when a box took
 * the run's job: given, it is where a run's silence is measured from once the ledger holds nothing
 * newer, so a run that took its job and died before promoting reads as stalled. Without it the
 * stall bound reads only a run that has promoted.
 */
export function readBounds(
  attempts: ReleaseAttemptRow[],
  opts: {
    now?: number;
    total?: number;
    stall?: number;
    takenAt?: Date | null;
    /** The run has ended: its bounds measure up to `at` where it is known, and nothing holds. */
    ended?: { at: Date | null } | undefined;
  } = {},
): BoundsReading {
  const now = opts.ended?.at?.getTime() ?? opts.now ?? Date.now();
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

  const origin = stallOrigin(attempts, opts.takenAt);
  const stall: BoundReading =
    origin === null || (firstPromotion === null && opts.takenAt == null)
      ? {
          name: 'stall',
          crossed: false,
          measuredMs: null,
          thresholdMs: stallThreshold,
          why: 'this run has recorded no promotion, so nothing has reached production to measure from',
        }
      : {
          name: 'stall',
          crossed: now - origin.at > stallThreshold,
          measuredMs: now - origin.at,
          thresholdMs: stallThreshold,
          why: STALL_WHY[origin.from],
        };

  const regression: BoundReading = {
    name: 'regression',
    ...readRegression(settled(attempts)),
    measuredMs: null,
    thresholdMs: null,
  };

  const bounds = [total, stall, regression];
  const crossedNames = bounds.filter((b) => b.crossed).map((b) => b.name);
  return { holding: opts.ended === undefined && crossedNames.length > 0, crossedNames, bounds };
}
