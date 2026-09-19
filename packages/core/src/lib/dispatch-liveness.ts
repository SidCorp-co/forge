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
