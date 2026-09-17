/**
 * ISS-1085 slice 3 — whether one Sentry issue becomes a Forge issue.
 *
 * The gate's default is NOT to file, and every arm below is a refusal that names itself. That is
 * the whole design: a Sentry issue that does not become work has to be distinguishable, in the
 * schedule run's own output, from a Sentry issue nobody looked at. A gate whose skips are silent
 * reads identically to a gate that never ran.
 *
 * Pure on purpose — one issue plus the thresholds in, one verdict out, no database and no clock.
 * The thresholds come from `admin_thresholds` (ISS-654 operator policy) and are passed in rather
 * than read here, so the same function is judged against any policy a test names.
 *
 * ABSENCE IS A REFUSAL, never a pass. Sentry not reporting a count is not the same as Sentry
 * reporting zero, and reading it as "probably fine" is how an admission gate stops being one — the
 * same rule this repo states as a loud break beating a silent substitution.
 */

import { isValidDetectorKey } from '../../issues/detector-key.js';
import type { SentryIssueDetail } from './types.js';

/**
 * The levels this gate admits, and nothing else.
 *
 * Sentry orders `debug < info < warning < error < fatal`. The issue's contract says `level:error`
 * or above, which is these two. A level Sentry did not report is refused rather than guessed at.
 */
export const SENTRY_ADMITTED_LEVELS = ['error', 'fatal'] as const;

/** The Sentry status an issue must be in to become work. A resolved error is not work. */
export const SENTRY_ADMITTED_STATUS = 'unresolved';

export interface SentryAdmissionThresholds {
  minEventCount: number;
  minUserCount: number;
}

export type SentryAdmissionVerdict =
  | { admit: true; externalId: string; detectorKey: string }
  | { admit: false; reason: string };

/**
 * The detector key a Sentry issue claims, or `null` where its `shortId` cannot form one.
 *
 * `issues/detector-key.ts` accepts lowercase slash-separated slugs, so a Sentry shortId like
 * `FORGE-WEB-3K` folds to `sentry/forge-web-3k`. A shortId that folds to something that key rule
 * rejects is NOT filed under a made-up key: the key is what makes the kernel hold at most one live
 * issue per detector, and a filer that invents one when the real one does not fit has turned that
 * guarantee off for the rows it invented it for.
 */
export function sentryDetectorKey(shortId: string): string | null {
  const folded = shortId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (folded === '') return null;
  const key = `sentry/${folded}`;
  return isValidDetectorKey(key) ? key : null;
}

/** One Sentry issue judged against operator policy. */
export function judgeSentryIssue(
  issue: SentryIssueDetail,
  thresholds: SentryAdmissionThresholds,
): SentryAdmissionVerdict {
  // The join key first: without a shortId there is no `external_id`, so a second sighting could not
  // find this issue and the pull would file it again on every tick.
  if (issue.shortId === null || issue.shortId.trim() === '') {
    return {
      admit: false,
      reason: `Sentry issue ${issue.id} carries no shortId, which is the external id a second sighting is matched on`,
    };
  }

  if (issue.level === null) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} carries no level, and the admission gate admits ${SENTRY_ADMITTED_LEVELS.join(' and ')} — an absent level is refused rather than assumed`,
    };
  }
  if (!(SENTRY_ADMITTED_LEVELS as readonly string[]).includes(issue.level)) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} is level ${issue.level}, and the admission gate admits ${SENTRY_ADMITTED_LEVELS.join(' and ')}`,
    };
  }

  if (issue.status !== SENTRY_ADMITTED_STATUS) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} is ${issue.status === null ? 'carrying no status' : `status ${issue.status}`}, and the admission gate admits ${SENTRY_ADMITTED_STATUS}`,
    };
  }

  if (issue.count === null) {
    return {
      admit: false,
      reason: `Sentry reported no event count for issue ${issue.shortId}, and a threshold of ${thresholds.minEventCount} cannot be applied to a count that is absent — this is refused rather than read as zero`,
    };
  }
  if (issue.count < thresholds.minEventCount) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} has ${issue.count} event(s), below the admission threshold of ${thresholds.minEventCount}`,
    };
  }

  if (issue.userCount === null) {
    return {
      admit: false,
      reason: `Sentry reported no affected-user count for issue ${issue.shortId}, and a threshold of ${thresholds.minUserCount} cannot be applied to a count that is absent — this is refused rather than read as zero`,
    };
  }
  if (issue.userCount < thresholds.minUserCount) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} has affected ${issue.userCount} user(s), below the admission threshold of ${thresholds.minUserCount}`,
    };
  }

  const detectorKey = sentryDetectorKey(issue.shortId);
  if (detectorKey === null) {
    return {
      admit: false,
      reason: `Sentry issue ${issue.shortId} cannot form a detector key — the key is what holds at most one live Forge issue per Sentry issue, and filing without one would turn that off`,
    };
  }

  return { admit: true, externalId: issue.shortId, detectorKey };
}
