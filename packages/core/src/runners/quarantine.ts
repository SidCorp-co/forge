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
//
// Which failures count is `classifyBoxFault` in attribute-failure.ts, not this
// file. ISS-862 widened it past preflight: a box that accepts a dispatch and
// never claims it is as broken as one that fails its own checks, and for
// 4h41m on pixelight nothing here could see that.

import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { emitPipelineWedge, resolvePipelineWedge } from '../pipeline/wedge.js';
import { broadcastRunnerChanged } from './apply-runner-limit.js';
import { classifyBoxFault } from './attribute-failure.js';

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
  const fault = classifyBoxFault(currentError);
  if (!fault) return false;

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
      if (row.status !== 'failed' || classifyBoxFault(row.error)?.key !== fault.key) break;
      matching += 1;
    }
    if (matching < priorCount) return false;

    // cm:guard the level MUST come from the streak length and nothing else — there is no strike counter on the runner row, and adding one would be a second source of truth that `clearRunnerQuarantine` (which only nulls the two columns) would leave stale. The job history IS the counter: one success breaks the run, so a repaired box drops straight back to rung 0.
    const level = matching + 1 - RUNNER_QUARANTINE_STREAK;
    const ttlMs = quarantineTtlMs(level);
    await db
      .update(runners)
      .set({
        quarantinedUntil: new Date(Date.now() + ttlMs),
        quarantineReason: fault.key,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, runnerId));
    logger.warn(
      { runnerId, fault: fault.key, streak: matching + 1, level, ttlMs },
      'runner: quarantined after repeated identical box-scoped failure',
    );
    broadcastRunnerChanged(projectId, runnerId);
    await alarmQuarantine(runnerId, projectId, fault.key, matching + 1, ttlMs);
    return true;
  } catch (err) {
    logger.warn({ err, runnerId }, 'maybeQuarantineRunner failed, continuing');
    return false;
  }
}

/**
 * Tell the project owner one box has been set aside, and why.
 */
// cm:guard the wedge is resolved ONLY where the fault is actually gone — `clearRunnerQuarantine` (a job succeeded on this box, or an admin lifted the exclusion) and `clearRunnerFaultFlags` (the operator repaired it and said so). Expiry must never resolve it: the ladder hands a permanently-broken box one more probe every rung, so clearing on expiry would drop the alarm on a runner that is still broken and re-raise it on the next trip, which teaches an operator the notification means nothing.
// cm:why the streak is what makes this early — three no-acks cost ackMs + killGraceMs each (4.5 min at the defaults) plus retry backoff, so it fires ~15 min into an outage rather than on one WS blip, and pixelight's only alarm in a 4h41m outage was `alarmAgedHolds` at the 6h mark
async function alarmQuarantine(
  runnerId: string,
  projectId: string,
  faultKey: string,
  streak: number,
  ttlMs: number,
): Promise<void> {
  const minutes = Math.round(ttlMs / 60_000);
  await emitPipelineWedge({
    projectId,
    hop: 'dispatch',
    entity: 'runner',
    entityId: runnerId,
    reason: `quarantined:${faultKey}`,
    action: `Dispatch is now routing around this runner. Fix the box, or clear the quarantine once it is repaired; it lifts on its own in ${minutes}m and re-trips for longer if the fault is still there.`,
    title: 'A runner has been set aside after repeated identical failures',
    summary: `The same failure — \`${faultKey}\` — has now happened ${streak} times in a row on this runner, so it has been excluded from dispatch for ${minutes} minutes. Other runners on this project keep taking work.`,
    nextStep:
      'Check the box itself: its daemon, its workspace, and its credentials. The failure text above names which check keeps failing.',
  });
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
      await resolvePipelineWedge(runnerId);
    }
  } catch (err) {
    logger.warn({ err, runnerId }, 'clearRunnerQuarantine failed, continuing');
  }
}
