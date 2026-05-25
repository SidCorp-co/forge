/**
 * ISS-198 — hold expiry policy.
 *
 * `setManualHoldBlock` no longer hard-codes "indefinite hold by default".
 * Every caller routes its classification + trigger through this module to
 * compute an explicit `manualHoldUntil`:
 *
 *   - permanent / permission failures → NULL (operator must review).
 *   - transient_network repeat (>=3 prior transient failures in the
 *     recovery window) → now + 30min. After 30min the pipeline sweeper
 *     auto-clears and the next dispatcher tick re-picks the issue.
 *   - session_lost (runner-side timeout / watchdog kill) → now + 5min.
 *     Worker process blips usually self-heal in seconds, so a short hold
 *     covers the gap while the next dispatch lands on a fresh runner.
 *   - everything else → NULL (default to operator review).
 *
 * Callers that don't have rich recovery stats (e.g. adapter_error in the
 * dispatcher hot path) pass `{}` for recoveryStats and accept the default
 * (NULL) — adapter dispatch failures are rare enough that auto-clearing
 * them would mostly just hide latent runner config problems.
 */
import type { FailureClassificationKind, ManualHoldTrigger } from './manual-hold.js';

export interface ComputeHoldUntilInput {
  classificationKind: FailureClassificationKind;
  trigger: ManualHoldTrigger;
  /** Counters maintained by the recovery subsystem (ISS-197). Optional. */
  recoveryStats?: {
    transientFailures: number;
    permissionFailures: number;
  };
}

const TRANSIENT_HOLD_MS = 30 * 60_000;
const SESSION_LOST_HOLD_MS = 5 * 60_000;
const TRANSIENT_REPEAT_THRESHOLD = 3;

export function computeHoldUntil(
  input: ComputeHoldUntilInput,
  now: Date = new Date(),
): Date | null {
  // Permanent / permission failures: operator must look at the failure
  // context before the pipeline retries. Auto-clearing here would just
  // burn another provider call against the same broken state.
  if (input.classificationKind === 'permanent_invalid') return null;

  // Transient repeat: the provider is degraded but the failure mode is
  // recoverable. Hold for 30min so the next tick lands well clear of the
  // typical provider blip window.
  const transientCount = input.recoveryStats?.transientFailures ?? 0;
  if (
    input.classificationKind === 'transient_network' &&
    transientCount >= TRANSIENT_REPEAT_THRESHOLD
  ) {
    return new Date(now.getTime() + TRANSIENT_HOLD_MS);
  }

  // Runner-side timeout: worker process likely crashed or wedged. A short
  // hold lets the dispatcher reroute to a fresh runner once stale-detector
  // has flipped the prior runner offline.
  if (input.trigger === 'session_lost') {
    return new Date(now.getTime() + SESSION_LOST_HOLD_MS);
  }

  return null;
}
