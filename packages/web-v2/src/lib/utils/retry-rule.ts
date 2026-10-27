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
