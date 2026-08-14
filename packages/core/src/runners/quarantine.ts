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
 * FIRST quarantine's length — the base of {@link QUARANTINE_BACKOFF}, not the
 * whole story. Override via `RUNNER_QUARANTINE_TTL_MS` env. Default 60 minutes.
 */
export const RUNNER_QUARANTINE_TTL_MS = (() => {
  const n = Number.parseInt(process.env.RUNNER_QUARANTINE_TTL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60_000;
})();

// cm:guard this ladder MUST stay monotonically increasing and MUST end at a multiple large enough to be quiet for a day — a FLAT TTL turns a permanently-broken box into an unbounded job shredder, because expiry hands it one more probe forever. Measured 2026-08-14 on the flat 60m TTL: runner ubuntu1/Anhome took one job an hour for 8 straight hours (21:46→02:04), every one dying on the same `preflight_failed: work_tree`, and SidPeak did the same on `hooks_path` — a workspace fault and a missing husky install are both conditions only a human can clear, so no amount of waiting was ever going to help.
// cm:why multipliers of the base rather than absolute durations, so RUNNER_QUARANTINE_TTL_MS stays a single honest knob — setting it to 5m for a test shortens the whole ladder proportionally instead of only its first rung
const QUARANTINE_BACKOFF = [1, 2, 4, 8, 24] as const;

/**
 * Quarantine length for the `level`-th consecutive trip on the same check
 * (0 = first). Escalates 1h → 2h → 4h → 8h → 24h at the default base, then
 * holds at the last rung: a box that has failed the same check seven times
 * running gets one probe a day, not one an hour.
 */
export function quarantineTtlMs(level: number): number {
  const rung = QUARANTINE_BACKOFF[Math.min(Math.max(level, 0), QUARANTINE_BACKOFF.length - 1)];
  return RUNNER_QUARANTINE_TTL_MS * (rung ?? 1);
}

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
 * `RUNNER_QUARANTINE_STREAK` identical box-scoped failures. Walks back through
 * the runner's terminal jobs (excluding `currentJobId` so this is race-free
 * regardless of whether the current job's row is committed yet), counting the
 * leading run of `failed` rows sharing the current failure's check token; trips
 * once that run reaches the streak, and the run's LENGTH picks the rung on
 * {@link quarantineTtlMs} so each re-trip buys longer quiet.
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
  // cm:why one rung deeper than the ladder needs, so the top rung is reached by a real streak rather than by the LIMIT running out — read a row short and a 30-failure box would keep drawing the same middle rung forever
  const lookback = priorCount + QUARANTINE_BACKOFF.length;
  try {
    const priorRows =
      lookback > 0
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
            .limit(lookback)
        : [];

    if (priorRows.length < priorCount) return false;
    let matching = 0;
    for (const row of priorRows) {
      if (row.status !== 'failed' || parsePreflightCheck(row.error) !== check) break;
      matching += 1;
    }
    if (matching < priorCount) return false;

    // cm:guard the level MUST come from the streak length and nothing else — there is no strike counter on the runner row, and adding one would be a second source of truth that `clearRunnerQuarantine` (which only nulls the two columns) would leave stale. The job history IS the counter: one success breaks the run, so a repaired box drops straight back to rung 0.
    const level = matching + 1 - RUNNER_QUARANTINE_STREAK;
    const ttlMs = quarantineTtlMs(level);
    const reason = `preflight_failed: ${check}`;
    await db
      .update(runners)
      .set({
        quarantinedUntil: new Date(Date.now() + ttlMs),
        quarantineReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, runnerId));
    logger.warn(
      { runnerId, check, streak: matching + 1, level, ttlMs },
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
