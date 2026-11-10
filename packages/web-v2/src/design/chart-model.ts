// Where a chart's printed values sit and how its days read, for every overview band and the project
// home (REQ-43 BC-14..BC-17). A chart draws no bar for a zero value, so a printed value never rides
// an index into the drawn bars: each row carries its own (`cap_<series>`, null where it prints none).

import { dayKeyIn } from "@forge/contracts/day-keys";
import type { CoverageSegment } from "./patterns/facts-rail";
import { LEGEND, type LegendTone, type StatusFamily, statusReading } from "./vocabulary";

/** The reader's time zone, which a band's days and weeks are counted in. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A day key of an instant on the reader's calendar, and today's. */
export function readerDays(now: Date = new Date()): { dayOf: (at: string | Date) => string; today: string } {
  const dayOf = dayKeyIn(readerZone());
  return { dayOf, today: dayOf(now) };
}

const DAY_LABEL = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** A `YYYY-MM-DD` key as a reader names the day: `Nov 8`. */
export const dayLabel = (key: string) => DAY_LABEL.format(new Date(`${key}T12:00:00Z`));

/** A day key's day of the month, the axis tick: `8`. */
export const dayTick = (key: string) => String(Number(key.slice(8)));

/** A share of a whole, 0 where there is no whole. */
export const shareOf = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** An average as the chart says it: whole above ten, one decimal below. */
export const averageText = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** A tone as a fill, the dot colour its badge draws. */
export const toneFill = (tone: LegendTone) => LEGEND[tone].dot;

export type Caps<K extends string> = Record<`cap_${K}`, number | null>;

/**
 * One series' printed values: its highest point and its last (today) carry their value, every other
 * point null, and a zero never prints (it draws no bar to sit on).
 */
export function peakCaps(values: readonly number[]): (number | null)[] {
  const peak = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const labelled = new Set([peak, values.length - 1]);
  return values.map((v, i) => (labelled.has(i) && v > 0 ? v : null));
}

/**
 * A stacked bar's total, carried by its topmost drawn segment (`cap_<key>`, null on the others): a
 * zero segment is not drawn, so a total hung on one fixed segment vanishes with it.
 */
export function stackCaps<K extends string, R extends Record<K, number>>(rows: readonly R[], keys: readonly K[]): (R & Caps<K> & { total: number })[] {
  return rows.map((r) => {
    const total = keys.reduce((n, k) => n + r[k], 0);
    const top = [...keys].reverse().find((k) => r[k] > 0) ?? null;
    const caps = Object.fromEntries(keys.map((k) => [`cap_${k}`, k === top ? total : null])) as Caps<K>;
    return { ...r, ...caps, total };
  });
}

/**
 * The flow of a list's states, in the lifecycle's order, each with its live count over `values` (one
 * per row) and the tone and name its badge wears in that family (the contract tone map), so the band
 * and every badge under it say a state the same way.
 */
export function stateFlowOf(family: StatusFamily, order: readonly string[], values: readonly string[], language?: string): CoverageSegment[] {
  const tally = new Map<string, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  // a state the order does not name is still drawn, after it: the parts always sum to the rows
  const keys = [...order, ...[...tally.keys()].filter((k) => !order.includes(k))];
  // a state no row holds is not drawn: "Refused 0" is a word on the face that says nothing
  return keys.filter((key) => (tally.get(key) ?? 0) > 0).map((key) => {
    const r = statusReading(family, key, language);
    return { key, label: r.label, count: tally.get(key) ?? 0, tone: r.tone };
  });
}
