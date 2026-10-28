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

/** The wait at `now` as a sentence; null where none was named, no Retry is offered, or it is over (ISS-1229 r51). */
export function retryWaitWords(err: unknown, now: number): string | null {
  const at = retryAt(err);
  if (at === null || at - now <= 0) return null;
  return `You can retry in ${durationWords(at - now)}.`;
}

/** A wait in its largest whole unit, each rounded up, so no time is named sooner than the server allows. */
function durationWords(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

/** When to ask again, where the server named a wait no Retry counts: a write's, said with the time it named (r53). */
export function askAgainWords(err: unknown): string | null {
  const asked = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (answeredStatus(err) === null || !isRetryableApiError(err) || retryAt(err) !== null || typeof asked !== "number" || asked <= 0) return null;
  return `Try again in ${durationWords(asked)}.`;
}

/** The wait the server asked for, said once as it starts: what was asked stays true, what is left does not (r52). */
export function askedWaitWords(err: unknown): string | null {
  const asked = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (retryAt(err) === null || typeof asked !== "number" || asked <= 0) return null;
  return `The server asked for ${durationWords(asked)} before Retry.`;
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
