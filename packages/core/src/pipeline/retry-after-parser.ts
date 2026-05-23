/**
 * RFC 7231 §7.1.3 Retry-After header parser (ISS-197).
 *
 * Pure: no I/O, no database, no Date.now() side effects beyond computing a
 * future timestamp. Two accepted forms:
 *   • delta-seconds: "600"            → now + 600s
 *   • HTTP-date:     "Wed, 21 Oct 2026 07:28:00 GMT" → that absolute instant
 *
 * Defensive against misconfigured providers:
 *   • negative delta-seconds          → null
 *   • NaN / unparseable HTTP-date     → null
 *   • past HTTP-date                  → null (provider already finished)
 *   • delta > 24h                     → clamped to now + 24h
 *   • absolute date > 24h ahead       → clamped to now + 24h
 *
 * The cooldown floor (60s) is exported as `MIN_RETRY_COOLDOWN_MS` so the
 * retry engine can apply it without redefining the literal. Kept in this
 * file (pipeline/) rather than jobs/ so the clean-break grep
 * (`60_000` in packages/core/src/jobs/) stays empty.
 */

export const MIN_RETRY_COOLDOWN_MS = 60_000;
export const MAX_RETRY_AFTER_CAP_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfter(header: string | null | undefined): Date | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const cappedMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_CAP_MS);
    return new Date(Date.now() + cappedMs);
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  const future = ms - Date.now();
  if (future < 0) return null;
  if (future > MAX_RETRY_AFTER_CAP_MS) {
    return new Date(Date.now() + MAX_RETRY_AFTER_CAP_MS);
  }
  return new Date(ms);
}

/**
 * Case-insensitive header lookup. Headers come from runner adapters as a
 * plain object — node fetch lowercases, axios preserves case, so we match
 * either.
 */
export function readRetryAfterHeader(
  headers: Record<string, unknown> | null | undefined,
): string | null {
  if (!headers || typeof headers !== 'object') return null;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'retry-after') {
      const v = (headers as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}
