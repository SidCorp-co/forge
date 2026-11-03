import type { ScheduleKind } from '@forge/contracts/schedules';
import { type CronExpression, CronExpressionParser } from 'cron-parser';

interface CronValidationResult {
  ok: boolean;
  error?: string;
  nextRunAt?: Date;
}

const MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A kind core runs inline, cheaply, and whose lag a person waits on may fire more often than the
 * hour every session-starting kind is held to: a beta port (ISS-923) every 15 minutes.
 */
const MIN_INTERVAL_MS_OF: Partial<Record<ScheduleKind, number>> = {
  beta_port: 15 * 60 * 1000,
};

const minutes = (ms: number) => Math.round(ms / 60_000);

function asDate(result: unknown): Date {
  return (result as { toDate(): Date }).toDate();
}

/** The options a schedule's cron is read with: its zone where it names one, else UTC, as the tick reads it. */
function readIn(timeZone: string | null | undefined, currentDate?: Date) {
  return { ...(currentDate ? { currentDate } : {}), tz: timeZone || 'UTC' };
}

/** Whether `timeZone` is an IANA zone this runtime can read a cron in. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validateCron(
  cron: string,
  timeZone?: string | null,
  kind: ScheduleKind = 'prompt',
): CronValidationResult {
  let interval: CronExpression;
  try {
    interval = CronExpressionParser.parse(cron, readIn(timeZone));
  } catch {
    return { ok: false, error: 'Invalid cron expression' };
  }
  const t1 = asDate(interval.next()).getTime();
  const t2 = asDate(interval.next()).getTime();
  const diffMs = t2 - t1;
  const min = MIN_INTERVAL_MS_OF[kind] ?? MIN_INTERVAL_MS;
  if (diffMs < min) {
    return {
      ok: false,
      error: `Minimum schedule interval is ${min === MIN_INTERVAL_MS ? '1 hour' : `${minutes(min)} minutes for a ${kind} schedule`}. This cron runs every ${minutes(diffMs)} minutes.`,
    };
  }
  return { ok: true };
}

export function nextRunFor(
  cron: string,
  fromDate: Date = new Date(),
  timeZone?: string | null,
): Date | null {
  try {
    return asDate(CronExpressionParser.parse(cron, readIn(timeZone, fromDate)).next());
  } catch {
    return null;
  }
}

/** The latest slot of `cron` at or before `at`: the period a fire at `at` answers. */
export function slotAt(cron: string, at: Date, timeZone?: string | null): Date {
  const just = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + 60_000);
  return asDate(CronExpressionParser.parse(cron, readIn(timeZone, just)).prev());
}
