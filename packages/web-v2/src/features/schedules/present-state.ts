// What a schedule row says about the present; the last run is a dated fact, never a status (ISS-1163).
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type { ScheduleRow } from "./types";

/** A last result is stale once this many scheduled runs have come due since it. */
export const STALE_AFTER_RUNS = 2;

export const STALE_RULE =
  "A last result is marked stale once two scheduled runs have come due since it, or while " +
  "the schedule is paused.";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Cadence {
  /** The cron in words, or null when the translator cannot read it. */
  words: string | null;
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

const VERDICT: Record<NonNullable<ScheduleRow["lastStatus"]>, { word: string; since: string }> = {
  success: { word: "Succeeded", since: "" },
  failed: { word: "Failed", since: "" },
  running: { word: "Running", since: "since " },
  skipped: { word: "Skipped", since: "" },
};

/** A status core writes that this screen has no wording for reads as its own word, neutral. */
function verdictWords(status: NonNullable<ScheduleRow["lastStatus"]>): { word: string; since: string } {
  return VERDICT[status] ?? { word: String(status), since: "" };
}

/**
 * The last run as a dated fact. Never a status: the verdict is words with an age, and past the
 * threshold (or while the schedule is paused) it is marked stale.
 */
export function lastRunView(row: ScheduleRow, now: Date): LastRunView {
  if (!row.lastStatus) return { kind: "never" };
  const { word, since } = verdictWords(row.lastStatus);
  const age = row.lastRunAt ? formatAge(row.lastRunAt, now) : null;
  const text = age ? `${word} ${since}${age}` : `${word}, time unknown`;
  return { kind: "ran", text, stale: isStale(row, now) };
}

function isStale(row: ScheduleRow, now: Date): boolean {
  if (!row.enabled) return true;
  if (!row.lastRunAt) return false;
  const at = new Date(row.lastRunAt);
  if (Number.isNaN(at.getTime())) return false;
  // The cron's own calendar decides when runs come due, so a weekday-only or monthly schedule is
  // measured against the runs it actually owed. The parser reads it in this browser's zone, which
  // can move a boundary by the offset and no further.
  try {
    const it = CronExpressionParser.parse(row.cron, { currentDate: at });
    let due = 0;
    for (let i = 0; i < STALE_AFTER_RUNS; i++) {
      if (it.next().toDate().getTime() <= now.getTime()) due++;
      else break;
    }
    return due >= STALE_AFTER_RUNS;
  } catch {
    // A cadence the parser cannot read gives no runs to count: no claim either way.
    return false;
  }
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
