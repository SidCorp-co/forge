// Shared liveness window for the dispatcher + runner selector.
//
// ISS-198 tightened the default from 90s to 30s. Stale-detector now flips
// runners to `offline` every minute, and Gate L5 in the dispatcher uses
// this same window — anything past 30s is treated as a stale runner that
// cannot receive new dispatches. Desktop pings every ~25s, so 30s leaves
// only one missed ping of slack.

const DEFAULT_MS = 30_000;
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
