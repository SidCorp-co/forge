export const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'verify_unavailable',
]);

export const HOLD_PAYLOAD_KEY = '__hold';

export interface HoldState {
  reason: string;
  heldAt: string;
  /** False once this lineage has already spent its single auto-release. */
  autoRelease: boolean;
}

/** Reasons whose clearance is verified before re-queueing, by re-running the check that failed. */
export const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
]);

/** Reasons with nothing to re-check: the hold retries once {@link HOLD_RECHECK_MS} has passed. */
export const TIME_CHECKED_REASONS: ReadonlySet<string> = new Set(['verify_unavailable']);

export const AUTO_RELEASE_REASONS: ReadonlySet<string> = new Set([
  ...CONDITION_CHECKED_REASONS,
  ...TIME_CHECKED_REASONS,
]);

export const HOLD_RECHECK_MS = 10 * 60_000;

/** Whether a hold for `reason` clears by itself: every surface describing a hold asks this. */
export function holdResumesItself(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && AUTO_RELEASE_REASONS.has(reason);
}

/** Narrower than {@link holdResumesItself}: a re-hold has spent the lineage's one auto-release. */
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
