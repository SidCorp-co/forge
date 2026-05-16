import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { boss } from '../queue/boss.js';

export const STUCK_WATCHER_QUEUE = 'job-stuck-watcher';

/**
 * Grace window before a `dispatched` job whose linked agent_session has no
 * recent heartbeat is considered stuck. Tunable via env if a deployment has
 * slow runners.
 */
const STUCK_GRACE_SECONDS = 300; // 5 minutes

/**
 * Heartbeat freshness window. A linked agent_session with last_heartbeat_at
 * inside this window proves the worker is still progressing, so the job is
 * NOT stuck even if it has been dispatched longer than STUCK_GRACE_SECONDS.
 */
const HEARTBEAT_FRESH_SECONDS = 60;

export interface StuckSweepResult {
  markedFailed: number;
  blocked: number;
  durationMs: number;
}

/**
 * Find jobs that have been `dispatched` longer than the grace window AND whose
 * linked agent_session is silent (no heartbeat in the last
 * HEARTBEAT_FRESH_SECONDS, or no linked session at all). Likely causes: device
 * handler silently failed, runner-side spawn hit a bug before posting events,
 * or the device went offline.
 *
 * Mark such jobs as `failed` and call setManualHoldBlock to surface the
 * decision to the operator. The watchdog kill is strong evidence of an
 * underlying problem — auto-retry would just burn another spawn cycle on
 * the same broken state.
 */
export async function runStuckSweep(): Promise<StuckSweepResult> {
  const t0 = Date.now();

  const errorMessage = `dispatched > ${STUCK_GRACE_SECONDS}s without session heartbeat (watchdog)`;
  const stuck = (await db.execute<typeof jobs.$inferSelect>(sql`
    UPDATE jobs
    SET status = 'failed',
        finished_at = now(),
        error = ${errorMessage},
        failure_kind = 'transient',
        failure_reason = 'no session heartbeat — worker likely crashed or never spawned',
        classifier_version = 1
    WHERE status = 'dispatched'
      AND dispatched_at < now() - interval '${sql.raw(String(STUCK_GRACE_SECONDS))} seconds'
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.id = jobs.agent_session_id
          AND s.last_heartbeat_at > now() - interval '${sql.raw(String(HEARTBEAT_FRESH_SECONDS))} seconds'
      )
    RETURNING *
  `)) as unknown as Array<typeof jobs.$inferSelect>;

  let blocked = 0;
  for (const row of stuck) {
    if (!row.issueId) continue;
    try {
      await setManualHoldBlock({
        issueId: row.issueId,
        context: {
          step: row.type,
          trigger: 'watchdog_kill',
          classification: {
            kind: 'unknown',
            reason: 'no session heartbeat — worker likely crashed or never spawned',
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
        'stuck-watcher: setManualHoldBlock threw, job stays failed without operator surface',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { markedFailed: stuck.length, blocked },
      'stuck-watcher: swept dispatched jobs with no heartbeat',
    );
  }

  return {
    markedFailed: stuck.length,
    blocked,
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
