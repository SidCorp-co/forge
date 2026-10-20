/**
 * What a held job's payload says of its hold, read without the release machinery: the run read
 * describes a hold with these, and `hold.ts` holds and releases jobs by them (ISS-1228).
 */

export const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'verify_unavailable',
]);

/** Payload key carrying the hold bookkeeping on the successor row. */
export const HOLD_PAYLOAD_KEY = '__hold';

export interface HoldState {
  reason: string;
  heldAt: string;
  /** False once this lineage has already spent its single auto-release. */
  autoRelease: boolean;
}

/**
 * Reasons whose clearance this module can VERIFY before re-queueing, by
 * re-running the check that failed.
 */
export const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
]);

/**
 * Reasons with nothing to re-check: waiting IS the whole remedy, so the hold
 * simply retries once {@link HOLD_RECHECK_MS} has passed.
 */
export const TIME_CHECKED_REASONS: ReadonlySet<string> = new Set(['verify_unavailable']);

/**
 * Every reason that may auto-release. Derived, never hand-listed — a reason
 * has to pick a lane above to get in.
 */
export const AUTO_RELEASE_REASONS: ReadonlySet<string> = new Set([
  ...CONDITION_CHECKED_REASONS,
  ...TIME_CHECKED_REASONS,
]);

/** How long a {@link TIME_CHECKED_REASONS} hold waits before it tries again. */
export const HOLD_RECHECK_MS = 10 * 60_000;

/**
 * Whether a hold for `reason` clears without anyone doing anything.
 *
 * The one predicate every surface that describes a hold must ask, so no copy
 * can promise a resume this module will not perform.
 */
export function holdResumesItself(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && AUTO_RELEASE_REASONS.has(reason);
}

/**
 * Whether holding `job` for `reason` produces a hold that will release itself.
 *
 * Narrower than {@link holdResumesItself}: it also spends the once-per-lineage
 * bound, so a re-hold answers false even for a self-clearing reason.
 */
export function holdAutoReleases(priorPayload: unknown, reason: string): boolean {
  return readHoldState(priorPayload) === null && AUTO_RELEASE_REASONS.has(reason);
}

export function readHoldState(payload: unknown): HoldState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>)[HOLD_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { reason, heldAt, autoRelease } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || typeof heldAt !== 'string') return null;
  return { reason, heldAt, autoRelease: autoRelease === true };
}
