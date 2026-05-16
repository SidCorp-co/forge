/**
 * Watchdog for jobs stuck at `status='queued'`.
 *
 * Distinguishes a dead queue from a slow-but-alive one:
 *   - Skip if dispatcher recently recorded a gate skip on the job
 *     (`gate_at` fresh) — dispatcher is actively tracking this job.
 *   - Skip if any other job in the same project shows recent activity —
 *     either a fresh session heartbeat on an in-flight job OR a sibling
 *     job that finished within the last 120s (covers the sub-second
 *     handoff window between two adjacent pipeline jobs, where the
 *     previous job just moved to `done` and the next has not yet been
 *     dispatched).
 *   - Otherwise (no gate signal, no project activity, queued past grace) →
 *     mark failed (transient) and let scheduleRetry decide.
 *
 * Catches: pg-boss losing the dispatch message (e.g. core restart with
 * in-flight messages archived) AND runners stuck in a state where they
 * never claim work despite being online.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { boss } from '../queue/boss.js';

export const QUEUED_WATCHDOG_QUEUE = 'job-queued-watchdog';

/**
 * 10 minutes. Anthropic plan jobs typically dispatch within seconds; a job
 * that has been queued past this without ANY dispatcher attention OR project
 * activity is almost certainly a queue/dispatcher hiccup.
 */
const QUEUED_GRACE_SECONDS = 600;

/**
 * Window during which a gate skip counts as "dispatcher is actively tracking
 * this job". The dispatcher tick runs at least every 60s (pg-boss backstop)
 * so 5 minutes is generous.
 */
const GATE_FRESH_SECONDS = 300;

/**
 * Window during which another running session in the same project counts as
 * "queue is draining". Matches the stuck-watcher heartbeat freshness.
 */
const PROJECT_ACTIVITY_FRESH_SECONDS = 60;

/**
 * Window during which a recently-finished job in the same project counts as
 * activity, covering the sub-second handoff between adjacent pipeline jobs
 * (previous job has just moved to `done`, next job has not yet been
 * dispatched). 120s is generous enough to absorb dispatcher tick latency
 * (60s pg-boss backstop + 1s debounce + L4 evaluation) without holding the
 * watchdog off indefinitely.
 */
const PROJECT_FINISHED_FRESH_SECONDS = 120;

export interface QueuedSweepResult {
  markedFailed: number;
  blocked: number;
  durationMs: number;
}

export async function runQueuedSweep(): Promise<QueuedSweepResult> {
  const t0 = Date.now();
  const errorMessage = `queued > ${QUEUED_GRACE_SECONDS}s with no dispatcher attention (queued-watchdog)`;

  const stuck = (await db.execute<typeof jobs.$inferSelect>(sql`
    UPDATE jobs
    SET status = 'failed',
        finished_at = now(),
        error = ${errorMessage},
        failure_kind = 'transient',
        failure_reason = 'queued without dispatcher attention (pg-boss desync or dispatcher hung)',
        classifier_version = 1
    WHERE status = 'queued'
      AND queued_at < now() - interval '${sql.raw(String(QUEUED_GRACE_SECONDS))} seconds'
      AND (
        gate_at IS NULL
        OR gate_at < now() - interval '${sql.raw(String(GATE_FRESH_SECONDS))} seconds'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs other_j
        LEFT JOIN agent_sessions other_s ON other_s.id = other_j.agent_session_id
        WHERE other_j.project_id = jobs.project_id
          AND other_j.id <> jobs.id
          AND (
            (other_j.status IN ('dispatched','running')
             AND other_s.last_heartbeat_at > now() - interval '${sql.raw(String(PROJECT_ACTIVITY_FRESH_SECONDS))} seconds')
            OR other_j.finished_at > now() - interval '${sql.raw(String(PROJECT_FINISHED_FRESH_SECONDS))} seconds'
          )
      )
    RETURNING *
  `)) as unknown as Array<typeof jobs.$inferSelect>;

  let blocked = 0;
  for (const row of stuck) {
    if (!row.issueId) {
      // PM / non-issue jobs: no operator-facing decision point. Logged
      // failure on the job row is the only signal; PM coordinator decides
      // how to react via its own subscriber.
      continue;
    }
    try {
      await setManualHoldBlock({
        issueId: row.issueId,
        context: {
          step: row.type,
          trigger: 'watchdog_kill',
          classification: {
            kind: 'unknown',
            reason: 'queued without dispatcher attention (pg-boss desync or dispatcher hung)',
            evidence: { jobId: row.id, sessionId: row.agentSessionId },
          },
          attempts: row.attempts,
          lastFailureAt: new Date().toISOString(),
          suggestedActions: ['resume', 'skip-step', 'close'],
        },
      });
      blocked += 1;
    } catch (err) {
      logger.error(
        { err, jobId: row.id, issueId: row.issueId },
        'queued-watchdog: setManualHoldBlock threw, job stays failed without operator surface',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { markedFailed: stuck.length, blocked },
      'queued-watchdog: swept stale queued jobs',
    );
  }

  return {
    markedFailed: stuck.length,
    blocked,
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
