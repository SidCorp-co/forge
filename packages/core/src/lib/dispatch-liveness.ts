/** The period a box beats at: runner-transport `heartbeat.rs:INTERVAL_SECS`. */
const BOX_HEARTBEAT_MS = 30_000;

/**
 * A box is stale once it has missed three beats running. Every liveness reading of a box (the device
 * and runner stale detectors, the dispatch window) is this margin, never the bare period, so one
 * late beat does not flap a healthy box offline.
 */
export const BOX_STALE_MS = 3 * BOX_HEARTBEAT_MS;

export function dispatchLivenessMs(): number {
  return BOX_STALE_MS;
}
