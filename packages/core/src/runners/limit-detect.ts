/**
 * Runner rate-limit / usage-limit / auth detection (ported + adapted from the
 * forge-agents predecessor's `error-classification.ts`).
 *
 * The Rust runner already emits `[USAGE_LIMIT] <msg…resets…>` into `jobs.error`
 * and Anthropic 429/auth errors surface in the error text + `failureMeta`.
 * This module turns that raw text into a structured `RunnerLimit` so the
 * failure path can stamp the runner row, the dispatcher can skip it until the
 * reset time, and the UI can render a distinct "limited" badge.
 *
 * Kept pure (no DB, no I/O) so it is trivially testable — the write side lives
 * in `apply-runner-limit.ts`.
 */

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

/**
 * Detect a Claude CLI usage limit. Specific patterns that include the reset
 * phrase avoid false positives from agent responses that merely *discuss*
 * usage limits. Also matches the runner's explicit `[USAGE_LIMIT]` token.
 */
export function isUsageLimitError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (text.includes('[USAGE_LIMIT]')) return true;
  // CLI includes "resets ..." after the limit message. The reset value can be a
  // bare time ("resets 11am") or a dated time ("resets Jun 4, 11am"), and the
  // limit phrase may carry a qualifier ("your weekly limit", "your 5-hour limit").
  const resetsValue = String.raw`resets\s+(?:[A-Za-z]+\s+)?\d`;
  if (
    new RegExp(String.raw`you've hit your(?:\s+[\w-]+)?\s+limit.*${resetsValue}`, 'i').test(text)
  ) {
    return true;
  }
  if (new RegExp(String.raw`out of extra usage.*${resetsValue}`, 'i').test(text)) return true;
  // Fallback: short error-only text (not a full agent response) → loose match.
  if (
    text.length < 300 &&
    (lower.includes('out of extra usage') || /you've hit your(?:\s+[\w-]+)?\s+limit/i.test(text))
  ) {
    return true;
  }
  return false;
}

/**
 * Detect an HTTP 429 / rate-limit error (distinct from a usage limit — these
 * are short provider throttles rather than account-level quota windows).
 */
export function isRateLimitError(text: string): boolean {
  if (!text) return false;
  return /\b429\b|\brate[\s_-]?limit/i.test(text);
}

/**
 * Detect a 401 invalid-credentials auth failure. This is NOT auto-recoverable
 * (no reset time) — the runner's credentials need fixing — but we still flag
 * the runner so an operator sees why it stopped taking work.
 */
export function isAuthError(text: string): boolean {
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
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const getPart = (type: string) =>
      Number.parseInt(parts.find((p) => p.type === type)!.value, 10);
    const tzYear = getPart('year');
    const tzNowMonth = getPart('month');
    const tzNowDay = getPart('day');
    const tzHour = getPart('hour') === 24 ? 0 : getPart('hour');
    const tzMinute = getPart('minute');

    let targetMonth: number;
    let targetDay: number;
    let targetYear = tzYear;
    if (monthStr && dayStr && MONTH_MAP[monthStr]) {
      targetMonth = MONTH_MAP[monthStr];
      targetDay = dayStr;
      // Year-rollover: a dated reset whose month is far behind the current
      // month (e.g. "resets Jan 2" seen in December) refers to next year.
      // >6 months behind is the unambiguous wrap (limits reset in hours/days,
      // never months), so it can't be a stale in-year date.
      if (tzNowMonth - targetMonth > 6) targetYear += 1;
    } else {
      targetMonth = tzNowMonth;
      const nowMinutes = tzHour * 60 + tzMinute;
      const resetMinutes = hour * 60 + minute;
      targetDay = tzNowDay + (resetMinutes > nowMinutes ? 0 : 1);
    }

    const guessUtc = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, hour, minute, 0));
    const guessParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(guessUtc);
    const getGuessPart = (type: string) =>
      Number.parseInt(guessParts.find((p) => p.type === type)!.value, 10);
    const guessLocalHour = getGuessPart('hour') === 24 ? 0 : getGuessPart('hour');
    const guessLocalMinute = getGuessPart('minute');

    const offsetMinutes = guessLocalHour * 60 + guessLocalMinute - (hour * 60 + minute);
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
 * limit/auth class we highlight. Detection order: usage-limit (most specific
 * account window) → auth (operator must fix) → generic rate-limit/429.
 *
 * @param retryAfter pre-parsed `Retry-After` timestamp from the classifier, if any.
 */
export function detectRunnerLimit(text: string, retryAfter?: Date | null): RunnerLimit | null {
  const t = text ?? '';

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
