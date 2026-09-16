/**
 * When a release run has been going on long enough that a person should look.
 *
 * A release run had no bound of any kind: it ran until its agent finished,
 * aborted, or died, and a run whose agent died sat `running` with its roster at
 * `releasing` until somebody noticed. These are not timeouts — nothing here
 * kills anything. They are the three readings that say "this stopped being a
 * release in progress and became a situation", and the state route reports them
 * so the next agent and the operator read the same thing.
 *
 * Three, because they catch three different shapes of stuck: a release that is
 * still doing things and has been at it far too long, a release that has gone
 * quiet, and a release that is making things worse.
 */

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

/**
 * The three bounds, measured against one run's ledger.
 *
 * `now` is injected so the reading is testable without real time.
 */
// cm:guard a bound is crossed on `measured > threshold` and NEVER on equality. The difference shows up exactly once — at the boundary — and a run held at precisely its threshold is one that has not yet exceeded anything, which is the reading an operator gets asked to defend.
// cm:guard a run with NO `promote` row has crossed neither DURATION bound, whatever its age. Nothing has reached production for them to measure from: the run is still in the part where an abort costs nothing, and reporting it as holding would send a person to a release that has not begun.
// cm:guard `regression` measures SETTLED attempts only. An attempt whose act never reported has no health reading at all, and reading its NULL as `down` would report a regression over an agent that was killed mid-deploy.
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

  // cm:guard the stall clock is reset by EVERY write to any attempt row, an account included. An agent that is reporting what it is doing has not gone quiet, and a stall measured off settled attempts alone would page over a deploy that is simply slow.
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

  const readings = settled(attempts);
  const wasUp = readings.findIndex((a) => a.health === 'up');
  const newest = readings.at(-1);
  const regression: BoundReading = {
    name: 'regression',
    crossed:
      wasUp !== -1 &&
      newest !== undefined &&
      newest.health === 'down' &&
      readings.indexOf(newest) > wasUp,
    measuredMs: null,
    thresholdMs: null,
    why: 'the newest settled attempt reads the application down after an earlier one read it up',
  };

  const bounds = [total, stall, regression];
  const crossedNames = bounds.filter((b) => b.crossed).map((b) => b.name);
  return { holding: crossedNames.length > 0, crossedNames, bounds };
}
