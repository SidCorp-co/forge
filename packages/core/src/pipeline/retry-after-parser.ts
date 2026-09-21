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
