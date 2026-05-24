// ISS-198 — manualHold badge text.
//
// Three rendering states a caller surfaces in the UI:
//   - 'none': issue is not held.
//   - 'auto-resume': held with an active future expiry. Label: `Auto-resume in Nm`.
//   - 'manual-only': held with NULL expiry — operator must clear it.
//
// `now` is injectable so callers can drive a setInterval re-render and tests
// can pass deterministic timestamps.

export type HoldBadgeState =
  | { kind: 'none' }
  | { kind: 'auto-resume'; label: string; minutesLeft: number }
  | { kind: 'manual-only'; label: string };

export function formatHoldCountdown(
  manualHold: boolean | undefined,
  manualHoldUntil: string | Date | null | undefined,
  now: Date = new Date(),
): HoldBadgeState {
  if (!manualHold) return { kind: 'none' };
  if (!manualHoldUntil) {
    return { kind: 'manual-only', label: 'Hold (manual resume only)' };
  }
  const target =
    manualHoldUntil instanceof Date
      ? manualHoldUntil.getTime()
      : new Date(manualHoldUntil).getTime();
  const deltaMs = target - now.getTime();
  if (deltaMs <= 0) {
    // Expiry has elapsed but the sweeper hasn't cleared yet — fall back to
    // the manual-only label rather than showing "Auto-resume in 0m". The
    // server-side sweeper runs every minute, so this window is short.
    return { kind: 'manual-only', label: 'Hold (manual resume only)' };
  }
  const minutesLeft = Math.max(1, Math.ceil(deltaMs / 60_000));
  return {
    kind: 'auto-resume',
    minutesLeft,
    label: `Auto-resume in ${minutesLeft}m`,
  };
}
