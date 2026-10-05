/** The period a box beats at: runner-transport `heartbeat.rs:INTERVAL_SECS`. */
const BOX_HEARTBEAT_MS = 30_000;

/**
 * A box is stale once it has missed three beats running. Every liveness reading of a box (the device
 * and runner stale detectors, the dispatch window) is this margin, never the bare period, so one
 * late beat does not flap a healthy box offline.
 */
export const BOX_STALE_MS = 3 * BOX_HEARTBEAT_MS;

const DEFAULT_MS = BOX_STALE_MS;
const MIN_MS = 10_000;

export function dispatchLivenessMs(): number {
  const raw = process.env.DISPATCH_LIVENESS_MS;
  if (!raw) return DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_MS ? n : DEFAULT_MS;
}
