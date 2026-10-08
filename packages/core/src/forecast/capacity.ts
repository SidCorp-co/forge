/**
 * How many lanes the simulation works and how far its range can be leaned on: Little's law held to
 * the runs the project has had live at once and to the wave width its master declares, and the
 * confidence a range's sample and width earn.
 */

import {
  FORECAST_PEAK_DAYS,
  FORECAST_WINDOW_DAYS,
  type ForecastBasis,
  type ForecastConfidence,
} from '@forge/contracts/forecast';

const DAY_MINUTES = 1440;

export interface CycleSample {
  minutes: number;
  complexity: string | null;
}

export interface History {
  samples: readonly CycleSample[];
  /** Days the landings were counted over. */
  spanDays: number;
  /** The most declared runs live at once over the recent days; null where none was live. */
  peak: number | null;
  /** The job panes the project's master declares it opens at once (`devices.max_job_panes`): its wave width; null where none is declared. */
  width?: number | null;
}

export interface Concurrency {
  value: number;
  basis: string;
}

/**
 * Little's law, L = λ·W: the issues the project has had in progress at once on average, read from
 * its landings per day and their mean duration, never above the most runs it has actually had live
 * at once lately. A burst of landings reads a λ no lane ever sustained, and the work a master runs
 * as a two-run wave is never worked six at a time (HOP ISS-71's next-day p85), however many issues
 * stand at `in_progress` meanwhile.
 */
export function concurrencyOf(history: History): Concurrency | null {
  const n = history.samples.length;
  if (n === 0 || history.spanDays <= 0) return null;
  const perDay = n / history.spanDays;
  const meanMinutes = history.samples.reduce((s, c) => s + c.minutes, 0) / n;
  const wip = (perDay * meanMinutes) / DAY_MINUTES;
  const little = Math.max(1, Math.round(wip));
  const read = `Little's law over the last ${FORECAST_WINDOW_DAYS} days: ${perDay.toFixed(1)} landings a day × ${Math.round(meanMinutes)} min mean in progress ≈ ${wip.toFixed(1)} at once`;
  if (history.peak === null) {
    const width = history.width ?? null;
    if (width !== null && width < little) {
      return {
        value: Math.max(1, width),
        basis: `${read}, held to ${width}: the wave width the project's master declares (max_job_panes)`,
      };
    }
    return {
      value: little,
      basis: `${read}, not held to a run count: no run was live in the last ${FORECAST_PEAK_DAYS} days`,
    };
  }
  const cap = Math.max(1, history.peak);
  const width = history.width ?? null;
  if (width !== null && width < Math.min(little, cap)) {
    return {
      value: Math.max(1, width),
      basis: `${read}, held to ${width}: the wave width the project's master declares (max_job_panes)`,
    };
  }
  if (little <= cap) return { value: little, basis: read };
  return {
    value: cap,
    basis: `${read}, held to ${cap}: the most runs live at once over the last ${FORECAST_PEAK_DAYS} days`,
  };
}

/** How far a range can be leaned on (`ForecastConfidence`): the sample against the floor, and the range's own width. */
export function confidenceOf(
  basis: Pick<ForecastBasis, 'n' | 'floor'>,
  p50: number,
  p85: number,
): ForecastConfidence {
  const spread = Math.round(((p85 - p50) / Math.max(p50, 60)) * 100) / 100;
  const level =
    basis.n < 2 * basis.floor || spread > 1.5
      ? 'low'
      : basis.n >= 3 * basis.floor && spread <= 0.5
        ? 'high'
        : 'medium';
  return { level, n: basis.n, spread };
}
