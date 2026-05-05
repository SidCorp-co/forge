// Shared liveness window for the dispatcher + runner selector.
//
// stale-detector flips devices/runners to `offline` only on its 2-minute
// cron, so `status='online'` can lag reality. Desktop pings every ~25s;
// 90s default = ~3.6 missed pings of slack against network jitter / GC
// pauses, while still beating the 2min stale-detector cycle.

const DEFAULT_MS = 90_000;
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
