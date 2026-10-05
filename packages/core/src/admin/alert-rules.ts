// The pure half of the alert engine: thresholds and the classifiers `alert-queries.ts` reads its rows through.

import type { AdminAlertStatus } from './types.js';

const CRIT_STUCK_JOBS = 3;

export const CRIT_STARVED_PROJECTS = 3;

export const SPEND_WINDOW_HOURS = 1;
const SPEND_MIN_USD = 5;

const SPEND_CRIT_FACTOR = 2;
const SCHEDULE_CRIT_MARGIN = 2;
const DELIVERY_CRIT_FACTOR = 1.6;
export const DELIVERY_MIN_SAMPLE = 5;

export const STATUS_RANK: Record<AdminAlertStatus, number> = {
  ok: 0,
  warn: 1,
  crit: 2,
};

/** crit beats warn beats ok — for combining several contributors into one alert's overall status. */
export function worstStatus(a: AdminAlertStatus, b: AdminAlertStatus): AdminAlertStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A2 classification: 'ok' when nothing is stuck; 'crit' at CRIT_STUCK_JOBS or when the oldest offender has waited 4x the stale threshold; 'warn' otherwise. */
export function classifyStuck(
  count: number,
  oldestAgeSeconds: number,
  staleSeconds: number,
): AdminAlertStatus {
  if (count === 0) return 'ok';
  if (count >= CRIT_STUCK_JOBS || oldestAgeSeconds > staleSeconds * 4) return 'crit';
  return 'warn';
}

/** A4 classification: ratio of current window vs the preceding window, gated by an absolute floor so a near-zero baseline can't fire on noise. */
export function classifySpend(
  current: number,
  baseline: number,
  spikeMultiple: number,
): AdminAlertStatus {
  if (current < SPEND_MIN_USD) return 'ok';
  if (baseline <= 0) return 'warn';
  const ratio = current / baseline;
  if (ratio >= spikeMultiple * SPEND_CRIT_FACTOR) return 'crit';
  if (ratio >= spikeMultiple) return 'warn';
  return 'ok';
}

/**
 * A4's second, ABSOLUTE arm: trailing-24h spend against the configured ceiling.
 *
 * The ratio arm alone cannot see a spend that is high but steady — a deployment
 * burning $200/day every day has a ratio of 1.0 and reads `ok` forever. That is
 * the gap ISS-654's ceiling fills, so the two arms are combined with
 * `worstStatus`, never substituted for one another.
 */
const SPEND_CEILING_WARN_FRACTION = 0.8;

export function classifySpendCeiling(
  spendUsdDay: number,
  ceilingUsdDay: number | null,
): AdminAlertStatus {
  if (ceilingUsdDay === null || ceilingUsdDay <= 0) return 'ok';
  if (spendUsdDay >= ceilingUsdDay) return 'crit';
  if (spendUsdDay >= ceilingUsdDay * SPEND_CEILING_WARN_FRACTION) return 'warn';
  return 'ok';
}

/** A5 schedule contributor classification: consecutive trailing failures. */
export function classifyScheduleStreak(streak: number, warnStreak: number): AdminAlertStatus {
  if (streak >= warnStreak + SCHEDULE_CRIT_MARGIN) return 'crit';
  if (streak >= warnStreak) return 'warn';
  return 'ok';
}

/** A5 integration-delivery contributor classification: fail-rate over the minimum sample. */
export function classifyDeliveryFailRate(
  failed: number,
  total: number,
  warnRatePct: number,
): AdminAlertStatus {
  if (total < DELIVERY_MIN_SAMPLE) return 'ok';
  const rate = failed / total;
  const warnRate = warnRatePct / 100;
  if (rate >= Math.min(1, warnRate * DELIVERY_CRIT_FACTOR)) return 'crit';
  if (rate >= warnRate) return 'warn';
  return 'ok';
}

export function pluralJobs(n: number): string {
  return `${n} job${n === 1 ? '' : 's'}`;
}
