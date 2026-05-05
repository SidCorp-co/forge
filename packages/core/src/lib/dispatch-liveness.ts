// Shared liveness window for the dispatcher + runner selector.
//
// stale-detector flips devices/runners to `offline` only on its 2-minute
// cron, so `status='online'` can lag reality. The desktop pings /heartbeat
// every ~25s, so anything older than DISPATCH_LIVENESS_MS (default 60s)
// is treated as effectively gone — the dispatcher skips it instead of
// handing off a job that won't get claimed.

const DEFAULT_MS = 60_000;
const MIN_MS = 10_000;

export function dispatchLivenessMs(): number {
  const raw = process.env.DISPATCH_LIVENESS_MS;
  if (!raw) return DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_MS ? n : DEFAULT_MS;
}

export function isLastSeenFresh(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < dispatchLivenessMs();
}
