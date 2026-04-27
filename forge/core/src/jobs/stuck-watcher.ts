import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { scheduleRetry } from './retry.js';

export const STUCK_WATCHER_QUEUE = 'job-stuck-watcher';

/**
 * Default grace window before a `dispatched` job with no `started_at` is
 * considered stuck. Tunable via env if a deployment has slow runners.
 */
const STUCK_GRACE_SECONDS = 300; // 5 minutes

export interface StuckSweepResult {
  markedFailed: number;
  retriesScheduled: number;
  durationMs: number;
}

/**
 * Find jobs that the dispatcher published `job.assigned` for but the device
 * runner never acknowledged via `started_at`. Likely causes: device handler
 * silently failed, runner-side spawn hit a bug before posting events, or the
 * device went offline before `agent:start` fired.
 *
 * Mark such jobs as `failed` and let `scheduleRetry` decide whether to enqueue
 * a fresh attempt. The retry path keeps `attempts` honest so a permanently
 * broken job won't loop forever — `maxAttempts` caps it.
 */
export async function runStuckSweep(): Promise<StuckSweepResult> {
  const t0 = Date.now();

  const cutoffSql = sql.raw(`now() - interval '${STUCK_GRACE_SECONDS} seconds'`);
  const stuck = await db
    .update(jobs)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      error: `stuck dispatched > ${STUCK_GRACE_SECONDS}s without start (watchdog)`,
    })
    .where(
      and(
        eq(jobs.status, 'dispatched'),
        isNull(jobs.startedAt),
        lt(jobs.dispatchedAt, cutoffSql as unknown as Date),
      ),
    )
    .returning();

  let retriesScheduled = 0;
  for (const row of stuck) {
    try {
      const outcome = await scheduleRetry(row, 'watchdog: stuck dispatched');
      if (outcome.scheduled) retriesScheduled += 1;
    } catch (err) {
      logger.error(
        { err, jobId: row.id },
        'stuck-watcher: scheduleRetry threw, leaving job failed without retry',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { markedFailed: stuck.length, retriesScheduled },
      'stuck-watcher: swept dispatched jobs with no start',
    );
  }

  return {
    markedFailed: stuck.length,
    retriesScheduled,
    durationMs: Date.now() - t0,
  };
}

let registered = false;

/**
 * Cron: every minute, sweep dispatched jobs older than the grace window.
 * Idempotent across multiple core replicas — UPDATE ... WHERE status='dispatched'
 * guarantees only one writer wins per row.
 */
export async function registerStuckWatcher(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(STUCK_WATCHER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(STUCK_WATCHER_QUEUE, async () => {
    try {
      const result = await runStuckSweep();
      if (result.markedFailed > 0) {
        logger.info(result, 'stuck-watcher: sweep complete');
      }
    } catch (err) {
      logger.error({ err }, 'stuck-watcher: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(STUCK_WATCHER_QUEUE, '* * * * *'); // every minute
  registered = true;
}

export function resetStuckWatcherForTest(): void {
  registered = false;
}
