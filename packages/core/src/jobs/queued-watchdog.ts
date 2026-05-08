/**
 * Watchdog for jobs stuck at `status='queued'` (Phase H, ISS-306).
 *
 * The dispatcher consumes pg-boss messages, but pg-boss queue state can
 * desync from the `jobs` table — most commonly when core restarts and
 * pg-boss in-flight jobs land in archive while the `jobs` row stays
 * `queued`. Without a watchdog those rows would sit forever, the issue
 * stays in pipeline status, and (until the new sweeper) nobody recovers.
 *
 * This sweep finds jobs that have been `queued` longer than the grace
 * window without ever leaving — same shape as stuck-watcher, just on a
 * different state.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { scheduleRetry } from './retry.js';

export const QUEUED_WATCHDOG_QUEUE = 'job-queued-watchdog';

/**
 * 10 minutes. Anthropic plan jobs typically dispatch within seconds; if a
 * job has been queued for 10+ minutes the dispatcher (or pg-boss) lost
 * the message and a fresh enqueue is the only escape.
 */
const QUEUED_GRACE_SECONDS = 600;

export interface QueuedSweepResult {
  markedFailed: number;
  retriesScheduled: number;
  durationMs: number;
}

export async function runQueuedSweep(): Promise<QueuedSweepResult> {
  const t0 = Date.now();
  const errorMessage = `queued > ${QUEUED_GRACE_SECONDS}s without dispatch (queued-watchdog)`;

  // Classify as transient — a queued-but-not-dispatched job is almost always
  // a queue/dispatcher hiccup, not a deterministic upstream rejection.
  //
  // ISS-66: skip jobs gated by L1 manual_hold. That reason is sticky — only
  // human action clears it — so sweeping the row would burn the recovery
  // budget and eventually push the issue to pipeline_failed. Other gate
  // reasons (waiting_on_dep, project_full, runner_full) self-clear and stay
  // safe under the existing sweep.
  const stuck = (await db.execute<typeof jobs.$inferSelect>(sql`
    UPDATE jobs
    SET status = 'failed',
        finished_at = now(),
        error = ${errorMessage},
        failure_kind = 'transient',
        failure_reason = 'queued without dispatch (likely pg-boss desync after core restart)',
        classifier_version = 1
    WHERE status = 'queued'
      AND queued_at < now() - interval '${sql.raw(String(QUEUED_GRACE_SECONDS))} seconds'
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.id = jobs.agent_session_id
          AND s.failure_reason = 'manual_hold'
      )
    RETURNING *
  `)) as unknown as Array<typeof jobs.$inferSelect>;

  let retriesScheduled = 0;
  for (const row of stuck) {
    try {
      const outcome = await scheduleRetry(row, 'queued-watchdog: never dispatched');
      if (outcome.scheduled) retriesScheduled += 1;
    } catch (err) {
      logger.error(
        { err, jobId: row.id },
        'queued-watchdog: scheduleRetry threw, leaving job failed without retry',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { markedFailed: stuck.length, retriesScheduled },
      'queued-watchdog: swept stale queued jobs',
    );
  }

  return {
    markedFailed: stuck.length,
    retriesScheduled,
    durationMs: Date.now() - t0,
  };
}

let registered = false;

export async function registerQueuedWatchdog(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(QUEUED_WATCHDOG_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(QUEUED_WATCHDOG_QUEUE, async () => {
    try {
      const result = await runQueuedSweep();
      if (result.markedFailed > 0) {
        logger.info(result, 'queued-watchdog: sweep complete');
      }
    } catch (err) {
      logger.error({ err }, 'queued-watchdog: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(QUEUED_WATCHDOG_QUEUE, '* * * * *'); // every minute
  registered = true;
}

export function resetQueuedWatchdogForTest(): void {
  registered = false;
}
