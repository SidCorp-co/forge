import type { ReleaseBlockerCode, ReleaseRefusalCode } from '@forge/contracts/releases';
import { type Refusal, RefusalError, refuser } from '../lib/refusal.js';
import { type ReleaseBlockerReport, releaseBlockerSentence } from './blocker-sentences.js';

/** Every release refusal, at every door, in the one refusal envelope. */
export const refuseRelease = refuser<ReleaseRefusalCode>('RELEASE_REFUSED');

/** One blocker, answered under its code with the sentence readiness lists it with. */
export function blockerRefusal(code: ReleaseBlockerCode, details?: Record<string, unknown>) {
  return refuseRelease(code, releaseBlockerSentence(code, details));
}

/**
 * The probes did not agree that the release is live. The row carries the commit production was
 * found serving, which the finish record keeps beside the reason.
 */
export function notVerifiedRefusal(reason: string, live: string | null): RefusalError {
  const row: Refusal & { live: string | null } = {
    code: 'RELEASE_NOT_VERIFIED',
    path: '',
    detail: reason,
    live,
  };
  return new RefusalError([row], 'RELEASE_REFUSED');
}

/** The commit a `RELEASE_NOT_VERIFIED` refusal found serving, or null. */
export function liveOf(err: unknown): string | null {
  if (!(err instanceof RefusalError)) return null;
  const live = (err.refusals[0] as { live?: unknown } | undefined)?.live;
  return typeof live === 'string' ? live : null;
}

/** A finish worker's hold on its attempt was taken over; it must write nothing more. */
export const FENCE_LOST = 'RELEASE_FINISH_LEASE_LOST';

export const fenceLost = () =>
  refuseRelease(
    FENCE_LOST,
    'this finish worker no longer holds the attempt: another worker took it over, so this one writes nothing more',
  );

/**
 * Every reason standing in the report, the first first: an operator clearing one already knows
 * what else stands (ISS-1127). Null when nothing does.
 */
export function releaseBlockedRefusal(report: ReleaseBlockerReport): RefusalError | null {
  if (report.blockers.length === 0) return null;
  return new RefusalError(
    report.blockers.map((b) => ({ code: b.code, path: '', detail: b.message })),
    'RELEASE_REFUSED',
  );
}

/** What a stored record says of a failure: a refusal's sentences, or an error's message. */
export function reasonOf(err: unknown): string {
  if (err instanceof RefusalError) return err.refusals.map((r) => r.detail).join(' ');
  return err instanceof Error ? err.message : String(err);
}
