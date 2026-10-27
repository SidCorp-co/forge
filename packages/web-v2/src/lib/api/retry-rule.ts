// The one rule a failed read's Retry is decided by (ISS-1160, ISS-1229 r49 and r50). It imports nothing, so a
// design primitive can ask it without pulling the API client into its bundle.

/** The refusals a second read can change: a timeout, a request sent too early, a rate limit (ISS-1229 r49). */
const PASSING_REFUSALS = new Set([408, 425, 429]);

/** The status the server answered with, read off an `ApiError`; null for a read that ended without an answer. */
function answeredStatus(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== "ApiError") return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** A screen offers Retry only where retrying could change the answer: no answer, a 5xx or a passing refusal.
 *  Any other 4xx is the same request meeting the same refusal again. */
export function isRetryableApiError(err: unknown): boolean {
  const status = answeredStatus(err);
  return status === null || status >= 500 || PASSING_REFUSALS.has(status);
}
