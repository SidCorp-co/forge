// Durable per-runner quarantine (ISS-825, third slice of the ISS-812 epic).
//
// The device circuit breaker (`getTrippedDeviceIds` in select.ts) trips
// correctly but its exclude set is a SOFT preference both `selectRunnerForJob`
// wrap-arounds deliberately discard when every device is tripped ("better to
// try than to wedge") — the right trade for a transient fault, wrong for a box
// whose git push credentials are permanently broken. Quarantine is durable
// state on the runner row instead, enforced INSIDE every candidate query in
// select.ts alongside `rateLimitedUntil`, so it survives both wrap-arounds by
// construction.

import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { broadcastRunnerChanged } from './apply-runner-limit.js';
import { isBoxAttributable } from './attribute-failure.js';

/**
 * Consecutive identical box-scoped failures on one runner that trip
 * quarantine. Override via `RUNNER_QUARANTINE_STREAK` env. Default 3 (mirrors
 * `DEVICE_FAILURE_STREAK`).
 */
export const RUNNER_QUARANTINE_STREAK = (() => {
  const n = Number.parseInt(process.env.RUNNER_QUARANTINE_STREAK ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

/**
 * How long a quarantine lasts before the runner is eligible for one more
 * probe. Override via `RUNNER_QUARANTINE_TTL_MS` env. Default 60 minutes — a
 * still-broken box re-trips on its next failure; a repaired one recovers
 * without operator action.
 */
export const RUNNER_QUARANTINE_TTL_MS = (() => {
  const n = Number.parseInt(process.env.RUNNER_QUARANTINE_TTL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60_000;
})();

/**
 * Extract the box-scoped check token from a `preflight_failed: <check>:
 * <detail>` error, or null when the error is not box-attributable (or the
 * prefix carries no check token). Two failures "match" when this token is
 * identical, not merely when both are box-attributable.
 */
export function parsePreflightCheck(error: string | null | undefined): string | null {
  if (!isBoxAttributable(error)) return null;
  const rest = (error as string).trimStart().slice('preflight_failed:'.length);
  const check = rest.split(':')[0]?.trim();
  return check ? check : null;
}

/**
 * Trip quarantine on `runnerId` when the current failure extends a streak of
 * `RUNNER_QUARANTINE_STREAK` identical box-scoped failures. Looks at the
 * `RUNNER_QUARANTINE_STREAK - 1` most recent PRIOR terminal jobs on the
 * runner (excluding `currentJobId` so this is race-free regardless of whether
 * the current job's row is committed yet) — trips only when exactly that many
 * rows exist, all `failed`, all sharing the current failure's check token.
 *
 * Best-effort by contract, like `attributeFailureToRunner`: quarantine must
 * never break the failure-finalize path it observes. Returns whether
 * quarantine was tripped (for tests / logging), not whether it "should" have.
 */
export async function maybeQuarantineRunner(
  runnerId: string | null | undefined,
  projectId: string,
  currentJobId: string,
  currentError: string | null | undefined,
): Promise<boolean> {
  if (!runnerId) return false;
  const check = parsePreflightCheck(currentError);
  if (!check) return false;

  const priorCount = RUNNER_QUARANTINE_STREAK - 1;
  try {
    const priorRows =
      priorCount > 0
        ? await db
            .select({ status: jobs.status, error: jobs.error })
            .from(jobs)
            .where(
              and(
                eq(jobs.runnerId, runnerId),
                ne(jobs.id, currentJobId),
                isNotNull(jobs.finishedAt),
                inArray(jobs.status, ['failed', 'done']),
              ),
            )
            .orderBy(desc(jobs.finishedAt))
            .limit(priorCount)
        : [];

    if (priorRows.length !== priorCount) return false;
    const allMatch = priorRows.every(
      (row) => row.status === 'failed' && parsePreflightCheck(row.error) === check,
    );
    if (!allMatch) return false;

    const reason = `preflight_failed: ${check}`;
    await db
      .update(runners)
      .set({
        quarantinedUntil: new Date(Date.now() + RUNNER_QUARANTINE_TTL_MS),
        quarantineReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, runnerId));
    logger.warn(
      { runnerId, check, streak: RUNNER_QUARANTINE_STREAK },
      'runner: quarantined after repeated identical box-scoped failure',
    );
    broadcastRunnerChanged(projectId, runnerId);
    return true;
  } catch (err) {
    logger.warn({ err, runnerId }, 'maybeQuarantineRunner failed, continuing');
    return false;
  }
}

/**
 * Clear quarantine on the given runner (called on successful job completion —
 * a box that succeeds is not quarantined). Cheap guard: only writes when
 * quarantine is actually set.
 */
export async function clearRunnerQuarantine(
  runnerId: string | null | undefined,
  projectId: string,
): Promise<void> {
  if (!runnerId) return;
  try {
    const [cleared] = await db
      .update(runners)
      .set({
        quarantinedUntil: null,
        quarantineReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(runners.id, runnerId), isNotNull(runners.quarantinedUntil)))
      .returning({ id: runners.id });
    if (cleared) {
      logger.info({ runnerId }, 'runner quarantine cleared');
      broadcastRunnerChanged(projectId, runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerQuarantine failed, continuing');
  }
}
