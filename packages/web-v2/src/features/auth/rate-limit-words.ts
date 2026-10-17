import { ApiError } from "@/lib/api/client";

function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Sign-in and register show this one sentence for a rate-limited attempt (ISS-1421 r4). */
export function rateLimitedSentence(details: unknown): string {
  const raw = (details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  const seconds = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : null;
  const when = seconds === null ? "Wait a moment, then try again." : `Try again in ${waitWords(seconds)}.`;
  return `Too many attempts from this network. ${when}`;
}

export function rateLimitedOf(err: unknown): string | null {
  return err instanceof ApiError && err.code === "RATE_LIMITED" ? rateLimitedSentence(err.details) : null;
}
