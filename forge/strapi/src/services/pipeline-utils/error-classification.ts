/**
 * Error detection and device management for pipeline failures.
 */

import { DEVICE_UID } from './constants';

/**
 * Detect errors that indicate a project-level Antigravity misconfiguration.
 * These errors will affect ALL sessions for the project, so retrying
 * individual sessions is pointless — the project should be paused.
 */
export function isProjectLevelError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('project') && lower.includes('not found') ||
    lower.includes('no antigravity runner available') ||
    lower.includes('no antigravity configuration') ||
    lower.includes('proxy unreachable')
  );
}

/**
 * Detect errors where the Claude CLI session no longer exists on the device.
 * Resuming with this sessionId will always fail — the session must be marked
 * noResume so findResumableSession skips it.
 */
export function isSessionNotFoundError(error: string): boolean {
  return /no conversation found with session id/i.test(error);
}

/**
 * Detect errors that indicate a device environment misconfiguration.
 * These errors (wrong working directory, missing distro, etc.) won't resolve
 * on retry — they require manual intervention on the device.
 */
export function isDeviceEnvironmentError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('no such file or directory') ||
    lower.includes('cannot access') && lower.includes('no such file') ||
    lower.includes('wsl distro') && lower.includes('not found')
  );
}

// ─── Usage Limit Detection & Device Disable ─────────────────────────────────

/**
 * Check if an error string indicates a Claude CLI usage limit.
 * Uses specific patterns that include reset time to avoid false positives
 * from agent responses that merely discuss usage limits.
 */
export function isUsageLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  // Strict pattern: CLI always includes "resets Xam/pm (timezone)" after the limit message
  if (/you've hit your limit.*resets\s+\d/i.test(text)) return true;
  if (/out of extra usage.*resets\s+\d/i.test(text)) return true;
  // Fallback: if text is short (error-only, not full agent response), allow loose match
  if (text.length < 200 && (lower.includes('out of extra usage') || lower.includes("you've hit your limit"))) return true;
  return false;
}

/**
 * Detect transient API overload errors (529 Overloaded).
 * These are retryable but need a cooldown period — the API server is
 * temporarily overwhelmed and immediate retries will fail.
 */
export function isTransientOverloadError(text: string): boolean {
  return /529.*overloaded|overloaded.*529|repeated.*529|529.*error/i.test(text);
}

/**
 * Detect Claude API 500 internal server errors.
 * These indicate the API is temporarily unhealthy — pause and retry later.
 */
export function isApiServerError(text: string): boolean {
  return /API Error:\s*500|"type":\s*"api_error".*Internal server error|check status\.claude\.com/i.test(text);
}

export const API_SERVER_ERROR_DISABLE_MS = 10 * 60 * 1000;

/**
 * Parse the reset time from a usage limit message.
 * Expected formats: "resets 4am (America/Los_Angeles)", "resets 5:59pm (Asia/Bangkok)"
 * Returns an absolute Date in UTC, or null if unparseable.
 */
const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseUsageLimitReset(text: string): Date | null {
  // Match patterns like: "resets 12am (Asia/Bangkok)", "resets 5:59pm (US/Eastern)",
  // "resets Apr 17, 2pm (Asia/Bangkok)", "resets Apr 17, 5:59pm (US/Eastern)"
  const match = text.match(/resets\s+(?:([A-Za-z]+)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?(am|pm)\s*\(([^)]+)\)/i);
  if (!match) return null;

  const monthStr = match[1] ? match[1].toLowerCase().slice(0, 3) : null;
  const dayStr = match[2] ? parseInt(match[2], 10) : null;
  let hour = parseInt(match[3], 10);
  const minute = match[4] ? parseInt(match[4], 10) : 0;
  const ampm = match[5].toLowerCase();
  const tz = match[6].trim();

  if (ampm === 'am' && hour === 12) hour = 0;
  else if (ampm === 'pm' && hour !== 12) hour += 12;

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
    const tzYear = getPart('year');
    const tzNowMonth = getPart('month');
    const tzNowDay = getPart('day');
    const tzHour = getPart('hour') === 24 ? 0 : getPart('hour');
    const tzMinute = getPart('minute');

    // Use explicit date from message if available, otherwise infer today/tomorrow
    let targetMonth: number;
    let targetDay: number;
    if (monthStr && dayStr && MONTH_MAP[monthStr]) {
      targetMonth = MONTH_MAP[monthStr];
      targetDay = dayStr;
    } else {
      targetMonth = tzNowMonth;
      const nowMinutes = tzHour * 60 + tzMinute;
      const resetMinutes = hour * 60 + minute;
      targetDay = tzNowDay + (resetMinutes > nowMinutes ? 0 : 1);
    }

    // Build rough UTC guess, then correct for timezone offset
    const guessUtc = new Date(Date.UTC(tzYear, targetMonth - 1, targetDay, hour, minute, 0));

    const guessParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(guessUtc);
    const getGuessPart = (type: string) => parseInt(guessParts.find((p) => p.type === type)!.value, 10);
    const guessLocalHour = getGuessPart('hour') === 24 ? 0 : getGuessPart('hour');
    const guessLocalMinute = getGuessPart('minute');

    const offsetMinutes = (guessLocalHour * 60 + guessLocalMinute) - (hour * 60 + minute);
    const correctedOffset = offsetMinutes > 720 ? offsetMinutes - 1440
      : offsetMinutes < -720 ? offsetMinutes + 1440
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
 * Disable a device until the given time (usage limit cooldown).
 * Looks up the device by its deviceId string and sets disabledUntil.
 */
export async function disableDeviceUntil(strapi: any, deviceId: string, until: Date): Promise<void> {
  const devices = await strapi.documents(DEVICE_UID).findMany({
    filters: { deviceId: { $eq: deviceId } },
    limit: 1,
  });
  if (!devices.length) {
    strapi.log.warn(`[device-pool] Cannot disable device ${deviceId}: not found`);
    return;
  }
  await strapi.documents(DEVICE_UID).update({
    documentId: devices[0].documentId,
    data: { disabledUntil: until.toISOString() },
  });
  strapi.log.info(`[device-pool] Device ${deviceId} disabled until ${until.toISOString()} (usage limit)`);
}

/**
 * Detect usage limit error and disable the device if found.
 * Checks error string and accumulated text. Returns true if usage limit was detected.
 */
export async function handleUsageLimitIfPresent(
  strapi: any,
  deviceId: string | undefined,
  error: string | undefined,
  streamText: string | undefined,
): Promise<boolean> {
  if (!deviceId) return false;

  const textToCheck = [error || '', streamText || ''].join(' ');
  if (!isUsageLimitError(textToCheck)) return false;

  const resetDate = parseUsageLimitReset(textToCheck);
  // Default to 1 hour if reset time can't be parsed
  const until = resetDate || new Date(Date.now() + 60 * 60 * 1000);

  await disableDeviceUntil(strapi, deviceId, until);
  return true;
}
