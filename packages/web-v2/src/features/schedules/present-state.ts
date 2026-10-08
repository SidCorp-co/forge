// What a schedule row says about the present, as opposed to what its last run once said.
// Colour and the status slot belong to the present state (enabled or paused); the last run's
// verdict is a dated fact, so it is rendered with its age and goes stale (ISS-1163).
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type { ScheduleRow } from "./types";

/** A last result older than this many of the schedule's longest gaps is stale. */
export const STALE_AFTER_CADENCES = 2;

/** The rule the screen prints beside the list, so the threshold is stated rather than implied. */
export const STALE_RULE =
  "A last result is marked stale once it is older than two cadences — twice the longest gap " +
  "between the schedule's runs — or while the schedule is paused.";

/** How many upcoming fires are read to find the longest gap; a weekday cron's widest gap is the weekend. */
const GAP_SAMPLE = 14;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Cadence {
  /** The cron in words, or null when the translator cannot read it. */
  words: string | null;
  /** The raw expression, always kept so whoever audits the schedule can read the source. */
  expression: string;
}

export function describeCadence(cron: string): Cadence {
  try {
    const words = cronstrue.toString(cron, {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
    return { words, expression: cron };
  } catch {
    return { words: null, expression: cron };
  }
}

/** The longest gap between consecutive fires of `cron` after `from`, or null when it cannot be read. */
export function longestGapMs(cron: string, from: Date): number | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    let prev = it.next().toDate().getTime();
    let longest = 0;
    for (let i = 1; i < GAP_SAMPLE; i++) {
      const next = it.next().toDate().getTime();
      longest = Math.max(longest, next - prev);
      prev = next;
    }
    return longest > 0 ? longest : null;
  } catch {
    return null;
  }
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "17 days ago"; "just now" under a minute and for a timestamp ahead of the clock. */
export function formatAge(iso: string, now: Date): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const age = now.getTime() - then;
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${plural(Math.floor(age / MINUTE), "minute")} ago`;
  if (age < DAY) return `${plural(Math.floor(age / HOUR), "hour")} ago`;
  return `${plural(Math.floor(age / DAY), "day")} ago`;
}

export type LastRunView =
  | { kind: "never" }
  | {
      kind: "ran";
      /** "Succeeded 17 days ago", "Failed 2 hours ago", "Running since 3 hours ago". */
      text: string;
      stale: boolean;
    };

const VERDICT: Record<"success" | "failed" | "running", { word: string; since: string }> = {
  success: { word: "Succeeded", since: "" },
  failed: { word: "Failed", since: "" },
  running: { word: "Running", since: "since " },
};

/**
 * The last run as a dated fact. Never a status: the verdict is words with an age, and past the
 * threshold (or while the schedule is paused) it is marked stale.
 */
export function lastRunView(row: ScheduleRow, now: Date): LastRunView {
  if (!row.lastStatus) return { kind: "never" };
  const { word, since } = VERDICT[row.lastStatus];
  const age = row.lastRunAt ? formatAge(row.lastRunAt, now) : null;
  const text = age ? `${word} ${since}${age}` : `${word}, time unknown`;
  return { kind: "ran", text, stale: isStale(row, now) };
}

function isStale(row: ScheduleRow, now: Date): boolean {
  if (!row.enabled) return true;
  if (!row.lastRunAt) return false;
  const at = new Date(row.lastRunAt).getTime();
  if (Number.isNaN(at)) return false;
  const gap = longestGapMs(row.cron, now);
  // A cadence the parser cannot read gives no threshold to measure against: no claim either way.
  if (gap === null) return false;
  return now.getTime() - at > STALE_AFTER_CADENCES * gap;
}

/** The line that opens the list: what the whole adds up to. */
export function listSum(rows: readonly Pick<ScheduleRow, "enabled">[]): string {
  const total = rows.length;
  const enabled = rows.filter((r) => r.enabled).length;
  const noun = plural(total, "schedule");
  if (enabled === 0) return `${noun} · none enabled`;
  if (enabled === total) return total === 1 ? `${noun} · enabled` : `${noun} · all enabled`;
  return `${noun} · ${enabled} enabled`;
}
