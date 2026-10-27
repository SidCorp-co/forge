const PASSING_REFUSALS = new Set([408, 425, 429]);

function answeredStatus(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== "ApiError") return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** The one Retry rule (ISS-1229 r50): no answer, 5xx, 408, 425, 429. Imports nothing, for the design bundle. */
export function isRetryableApiError(err: unknown): boolean {
  const status = answeredStatus(err);
  return status === null || status >= 500 || PASSING_REFUSALS.has(status);
}

/** When the server will take the read again (`Retry-After`, as a time), where it said and the rule offers Retry. */
export function retryAt(err: unknown): number | null {
  if (answeredStatus(err) === null || !isRetryableApiError(err)) return null;
  const at = (err as { retryAt?: unknown }).retryAt;
  return typeof at === "number" ? at : null;
}

/**
 * The wait at `now` as a sentence, each unit rounded up; null where none was named, the rule offers no Retry
 * (a 403 carrying Retry-After stays final), or the wait is over (ISS-1229 r51, judge-158 on criterion 479).
 */
export function retryWaitWords(err: unknown, now: number): string | null {
  const at = retryAt(err);
  if (at === null) return null;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return null;
  if (seconds < 90) return `You can retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `You can retry in ${minutes} minutes.` : `You can retry in ${Math.ceil(minutes / 60)} hours.`;
}

export interface FailedRead {
  failed: boolean;
  error: unknown;
  retry: () => void;
}

/** One Retry for several reads: offered where any failed read allows one, and reading only those again. */
export function retryFailedReads(reads: FailedRead[]): { error: unknown; onRetry: () => void } {
  const failed = reads.filter((r) => r.failed);
  const again = failed.filter((r) => isRetryableApiError(r.error));
  return {
    error: (again[0] ?? failed[0])?.error,
    onRetry: () => {
      for (const r of again) r.retry();
    },
  };
}
