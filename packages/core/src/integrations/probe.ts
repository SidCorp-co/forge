/**
 * Shared probe deadline (ISS-431) — race an adapter healthcheck against a
 * timeout. Used by the create/bind initial probe (routes.ts) and the hourly
 * health sweep. The adapter keeps running past the deadline (its result still
 * persists via its own `updateConnection` write); only the caller stops
 * waiting.
 */
export async function raceWithTimeout<T>(probe: Promise<T>, ms: number): Promise<T | null> {
  const deadline = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
  });
  // A rejection after the deadline already won must not surface as an
  // unhandled rejection — the adapter records its own failure state.
  probe.catch(() => {});
  return Promise.race([probe, deadline]);
}
