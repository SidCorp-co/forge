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
