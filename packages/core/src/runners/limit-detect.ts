import { isSpendLimitError, isUsageLimitError } from '@forge/contracts/runners';
import type { RunnerLimitReason } from '../db/schema.js';

export interface RunnerLimit {
  reason: RunnerLimitReason;
  /** Absolute reset time for time-based limits; null for `auth`. */
  until: Date | null;
  /** Short human-readable detail for the UI / `runners.limitDetail`. */
  detail: string;
}

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Default cooldown when a usage/rate limit carries no parseable reset time. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

const SPEND_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Detect an HTTP 429 / rate-limit error (distinct from a usage limit — these
 * are short provider throttles rather than account-level quota windows).
 */
function isRateLimitError(text: string): boolean {
  if (!text) return false;
  return /\b429\b|\brate[\s_-]?limit/i.test(text);
}

/**
 * Detect a 401 invalid-credentials auth failure. This is NOT auto-recoverable
 * (no reset time) — the runner's credentials need fixing — but we still flag
 * the runner so an operator sees why it stopped taking work.
 */
function isAuthError(text: string): boolean {
  if (!text) return false;
  return (
    // CLI-specific phrasings are unambiguous → match anywhere.
    /API Error:\s*401/i.test(text) ||
    /failed to authenticate/i.test(text) ||
    /invalid authentication credentials/i.test(text) ||
    // Looser combinations use a BOUNDED gap (≤60 chars) so a long agent
    // response that merely contains "401" and the word "unauthorized" far
    // apart isn't misread as an auth failure (mirrors the usage-limit guard).
    /\b401\b[\s\S]{0,60}?(invalid|unauthorized|authentication)/i.test(text)
  );
}

/** The wall clock in `tz` at `at`; throws on an unknown zone. */
function zonedClock(
  tz: string,
  at: Date,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (type: string) => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`zonedClock: ${tz} formats no ${type} part`);
    return Number.parseInt(value, 10);
  };
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') === 24 ? 0 : part('hour'),
    minute: part('minute'),
  };
}

/**
 * Parse the reset time from a usage-limit message.
 * Formats: "resets 4am (America/Los_Angeles)", "resets 5:59pm (Asia/Bangkok)",
 * "resets Apr 17, 2pm (Asia/Bangkok)". Returns an absolute UTC Date or null.
 */
export function parseUsageLimitReset(text: string): Date | null {
  const match = text.match(
    /resets\s+(?:([A-Za-z]+)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?(am|pm)\s*\(([^)]+)\)/i,
  );
  if (!match) return null;

  // match[3], [5], [6] are non-optional in the regex, but strict TS types all
  // capture groups as `string | undefined`; bail defensively if any is absent.
  if (match[3] === undefined || match[5] === undefined || match[6] === undefined) return null;
  const monthStr = match[1] ? match[1].toLowerCase().slice(0, 3) : null;
  const dayStr = match[2] ? Number.parseInt(match[2], 10) : null;
  let hour = Number.parseInt(match[3], 10);
  const minute = match[4] ? Number.parseInt(match[4], 10) : 0;
  const ampm = match[5].toLowerCase();
  const tz = match[6].trim();

  if (ampm === 'am' && hour === 12) hour = 0;
  else if (ampm === 'pm' && hour !== 12) hour += 12;

  try {
    const now = new Date();
    const tzNow = zonedClock(tz, now);

    let targetMonth: number;
    let targetDay: number;
    let targetYear = tzNow.year;
    if (monthStr && dayStr && MONTH_MAP[monthStr]) {
      targetMonth = MONTH_MAP[monthStr];
      targetDay = dayStr;
      // Year-rollover: a dated reset whose month is far behind the current
      // month (e.g. "resets Jan 2" seen in December) refers to next year.
      // >6 months behind is the unambiguous wrap (limits reset in hours/days,
      // never months), so it can't be a stale in-year date.
      if (tzNow.month - targetMonth > 6) targetYear += 1;
    } else {
      targetMonth = tzNow.month;
      const nowMinutes = tzNow.hour * 60 + tzNow.minute;
      const resetMinutes = hour * 60 + minute;
      targetDay = tzNow.day + (resetMinutes > nowMinutes ? 0 : 1);
    }

    const guessUtc = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, hour, minute, 0));
    const guess = zonedClock(tz, guessUtc);
    const offsetMinutes = guess.hour * 60 + guess.minute - (hour * 60 + minute);
    const correctedOffset =
      offsetMinutes > 720
        ? offsetMinutes - 1440
        : offsetMinutes < -720
          ? offsetMinutes + 1440
          : offsetMinutes;

    const resetUtc = new Date(guessUtc.getTime() - correctedOffset * 60 * 1000);
    if (resetUtc.getTime() <= now.getTime()) {
      resetUtc.setTime(resetUtc.getTime() + 24 * 60 * 60 * 1000);
    }
    return resetUtc;
  } catch {
    return null;
  }
}

/**
 * Inspect failure text (and an optional already-extracted provider Retry-After)
 * and return the runner-limit verdict, or null if the failure is not a
 * limit/auth class we highlight. Detection order: spend-cap → usage-limit
 * (most specific account window) → auth (operator must fix) → generic
 * rate-limit/429.
 *
 * @param retryAfter pre-parsed `Retry-After` timestamp from the classifier, if any.
 */
export function detectRunnerLimit(text: string, retryAfter?: Date | null): RunnerLimit | null {
  const t = text ?? '';

  if (isSpendLimitError(t)) {
    const until = retryAfter ?? new Date(Date.now() + SPEND_LIMIT_COOLDOWN_MS);
    return { reason: 'usage_limit', until, detail: summarize(t) };
  }

  if (isUsageLimitError(t)) {
    const until =
      parseUsageLimitReset(t) ?? retryAfter ?? new Date(Date.now() + DEFAULT_LIMIT_COOLDOWN_MS);
    return { reason: 'usage_limit', until, detail: summarize(t) };
  }

  if (isAuthError(t)) {
    return { reason: 'auth', until: null, detail: summarize(t) };
  }

  if (isRateLimitError(t)) {
    const until = retryAfter ?? new Date(Date.now() + DEFAULT_LIMIT_COOLDOWN_MS);
    return { reason: 'rate_limit', until, detail: summarize(t) };
  }

  return null;
}

function summarize(text: string): string {
  const cleaned = text.replace(/\[USAGE_LIMIT\]\s*/g, '').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned;
}
