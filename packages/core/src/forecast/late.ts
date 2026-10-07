/**
 * When an open item is late, decided once in core and carried on the forecast it belongs to
 * (`ForecastLate`), so no screen computes its own lateness: work under way that has run past the
 * p85 of similar landed work, or a person's turn left unanswered for over a day.
 */

import { FORECAST_WAIT_LATE_MINUTES, type ForecastLate } from '@forge/contracts/forecast';

const MINUTE = 60_000;

function lateSince(reason: ForecastLate['reason'], at: number, now: Date): ForecastLate | null {
  const by = Math.floor((now.getTime() - at) / MINUTE);
  if (by < 1) return null;
  return { reason, since: new Date(at).toISOString(), byMinutes: by };
}

/** Work that began at `startedAt` is late once it has run past `cycleP85Minutes`, the p85 of its pool's landed cycles. */
export function lateAfterP85(
  startedAt: Date | null,
  cycleP85Minutes: number,
  now: Date,
): ForecastLate | null {
  if (!startedAt) return null;
  return lateSince('p85_passed', startedAt.getTime() + cycleP85Minutes * MINUTE, now);
}

/** A person's turn that began at `since` is late a day on; a wait with no known start is never called late. */
export function lateWaiting(since: string | null, now: Date): ForecastLate | null {
  if (!since) return null;
  const began = Date.parse(since);
  if (Number.isNaN(began)) {
    throw new Error(`forecast: a wait began at ${JSON.stringify(since)}, which is not a time`);
  }
  return lateSince('waiting_over_day', began + FORECAST_WAIT_LATE_MINUTES * MINUTE, now);
}

/** The latest of several members' lateness: a scope is as late as its latest member. */
export function latestLate(members: readonly (ForecastLate | null)[]): ForecastLate | null {
  return members.reduce<ForecastLate | null>(
    (worst, m) => (m && (!worst || m.byMinutes > worst.byMinutes) ? m : worst),
    null,
  );
}
