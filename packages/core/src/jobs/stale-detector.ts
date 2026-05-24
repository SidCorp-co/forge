import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { computeHoldUntil } from '../pipeline/hold-policy.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export const STALE_DETECTOR_QUEUE = 'stale-job-detector';
const STALE_THRESHOLD = "interval '5 minutes'";

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
 * Find `running` jobs whose latest job_event is older than 5 minutes (or whose
 * dispatched_at is, if no events). Mark them failed and surface the failure to
 * the operator via setManualHoldBlock — running-with-no-progress is strong
 * evidence the worker is wedged; auto-retry would just spawn another wedged
 * worker against the same state.
 */
export async function runStaleSweep(): Promise<{
  failed: number;
  blocked: number;
  durationMs: number;
}> {
  const t0 = Date.now();
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
    WHERE j.status = 'running'
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
          failure_reason = 'runner stale (no progress for >5min)',
          classifier_version = 1
      WHERE id = '${row.id}' AND status = 'running'
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
            reason: 'runner stale (no progress for >5min)',
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
