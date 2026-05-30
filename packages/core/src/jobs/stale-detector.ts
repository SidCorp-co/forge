import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { computeHoldUntil } from '../pipeline/hold-policy.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export const STALE_DETECTOR_QUEUE = 'stale-job-detector';
const STALE_THRESHOLD = "interval '60 minutes'";

type StaleJobRow = {
  id: string;
  project_id: string;
  attempts: number;
  status: string;
  type: string;
  issue_id: string | null;
  agent_session_id: string | null;
  dispatched_at: Date | null;
  [key: string]: unknown;
};

/**
 * Find `dispatched`/`running` jobs whose latest job_event is older than 60
 * minutes (or whose dispatched_at is, if no events). Mark them failed and
 * surface the failure to the operator via setManualHoldBlock — no progress
 * is strong evidence the worker is wedged; auto-retry would just spawn
 * another wedged worker against the same state.
 *
 * ISS-258 — `dispatched` is now covered. A runner that crashes between
 * dispatch and emitting `job_events:started` leaves the row in `dispatched`
 * with no events; the old sweeper filtered to `status='running'` and so
 * never reaped these rows. Combined with the cap=1 runner gate this stalled
 * the project queue indefinitely (Forge Dev 2026-05-27).
 *
 * `dispatched` jobs have no `job_events` rows yet, so the GREATEST clause
 * collapses to `j.dispatched_at` for them.
 *
 * Skip jobs that already emitted a `result` event — the runner reported
 * completion but the finalize path failed to flip `jobs.status='done'`.
 * That is a finalize-recovery problem, not a stale-runner problem; marking
 * it failed here is a false positive (Forge Dev 2026-05-27, release job of
 * ISS-258 itself — runner merged the PR, emitted result, then WS dropped
 * mid-finalize). Threshold also bumped from 5min → 60min because legitimate
 * forge-release/forge-code work can run >5min between event emissions on
 * heavy merges + test runs.
 */
export async function runStaleSweep(): Promise<{
  failed: number;
  blocked: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  // ISS-280 — emit a sweep-start trace so a silently-unscheduled detector
  // (the registration is wired at index.ts, but a pg-boss schedule failure
  // would otherwise be invisible) is detectable from logs alone. This is the
  // slow 60-min backstop; the fast path is reconcileOrphanedJobs (sweeper.ts).
  logger.debug('stale-job-detector: sweep start');
  const stale = await db.execute<StaleJobRow>(
    sql.raw(`
    WITH last_event AS (
      SELECT job_id, MAX(ts) AS max_ts
      FROM job_events
      GROUP BY job_id
    )
    SELECT j.*
    FROM jobs j
    LEFT JOIN last_event le ON le.job_id = j.id
    WHERE j.status IN ('dispatched', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM job_events
        WHERE job_id = j.id AND kind = 'result'
      )
      AND GREATEST(COALESCE(le.max_ts, j.dispatched_at), j.dispatched_at) <
          now() - ${STALE_THRESHOLD}
  `),
  );

  let failedCount = 0;
  let blockedCount = 0;

  for (const row of stale) {
    const updated = await db.execute<StaleJobRow>(
      sql.raw(`
      UPDATE jobs
      SET status = 'failed',
          error = 'stale',
          finished_at = now(),
          failure_kind = 'transient',
          failure_reason = 'runner stale (no progress / no started event for >60min)',
          classifier_version = 1
      WHERE id = '${row.id}' AND status IN ('dispatched', 'running')
      RETURNING *
    `),
    );
    const updatedRow = updated[0];
    if (!updatedRow) continue;
    failedCount++;

    roomManager.publish(projectRoom(updatedRow.project_id), {
      event: 'job.failed',
      data: { jobId: updatedRow.id, status: 'failed', error: 'stale', reason: 'stale' },
    });

    if (!updatedRow.issue_id) continue;
    try {
      await setManualHoldBlock({
        issueId: updatedRow.issue_id,
        context: {
          step: updatedRow.type as never,
          trigger: 'session_lost',
          classification: {
            kind: 'unknown',
            reason: 'runner stale (no progress for >60min)',
            evidence: {
              jobId: updatedRow.id,
              sessionId: updatedRow.agent_session_id,
            },
          },
          attempts: updatedRow.attempts,
          lastFailureAt: new Date().toISOString(),
          suggestedActions: ['resume', 'skip-step', 'close'],
          holdUntil: computeHoldUntil({
            classificationKind: 'unknown',
            trigger: 'session_lost',
          }),
        },
      });
      blockedCount++;
    } catch (err) {
      logger.error(
        { err, jobId: updatedRow.id, issueId: updatedRow.issue_id },
        'stale-detector: setManualHoldBlock threw, job stays failed without operator surface',
      );
    }
  }

  return { failed: failedCount, blocked: blockedCount, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerStaleDetector(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(STALE_DETECTOR_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(STALE_DETECTOR_QUEUE, async () => {
    try {
      const result = await runStaleSweep();
      logger.info(result, 'stale-job-detector: sweep complete');
    } catch (err) {
      logger.error({ err }, 'stale-job-detector: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(STALE_DETECTOR_QUEUE, '*/5 * * * *');
  registered = true;
}

export function resetStaleDetectorForTest(): void {
  registered = false;
}
