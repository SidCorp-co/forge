import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { scheduleRetry } from './retry.js';

export const STALE_DETECTOR_QUEUE = 'stale-job-detector';
const STALE_THRESHOLD = "interval '5 minutes'";

type StaleJobRow = {
  id: string;
  project_id: string;
  attempts: number;
  max_attempts: number;
  status: string;
  payload: unknown;
  type: string;
  created_by: string;
  issue_id: string | null;
  device_id: string | null;
  model_tier: string | null;
  retry_of: string | null;
  cancellation_requested: boolean;
  queued_at: Date;
  dispatched_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  exit_code: number | null;
  error: string | null;
  created_at: Date;
  [key: string]: unknown;
};

export async function runStaleSweep(): Promise<{
  failed: number;
  retried: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  // Find running jobs whose latest signal (event ts or dispatchedAt) is older
  // than the threshold. Signal is `GREATEST(dispatched_at, COALESCE(max event ts, dispatched_at))`.
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
  let retriedCount = 0;

  for (const row of stale) {
    const updated = await db.execute<StaleJobRow>(
      sql.raw(`
      UPDATE jobs
      SET status = 'failed', error = 'stale', finished_at = now()
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

    const retryOutcome = await scheduleRetry(
      {
        id: updatedRow.id,
        projectId: updatedRow.project_id,
        issueId: updatedRow.issue_id,
        deviceId: updatedRow.device_id,
        runnerId: null,
        createdBy: updatedRow.created_by,
        type: updatedRow.type as never,
        payload: updatedRow.payload as never,
        status: 'failed' as never,
        queuedAt: updatedRow.queued_at,
        dispatchedAt: updatedRow.dispatched_at,
        startedAt: updatedRow.started_at,
        finishedAt: updatedRow.finished_at,
        exitCode: updatedRow.exit_code,
        error: 'stale',
        modelTier: updatedRow.model_tier as never,
        attempts: updatedRow.attempts,
        maxAttempts: updatedRow.max_attempts,
        cancellationRequested: updatedRow.cancellation_requested,
        retryOf: updatedRow.retry_of,
        agentSessionId: null,
        // ISS-306: stale-detector flagged failures are transient by definition
        // (the runner went silent — almost always network / device crash, not
        // a deterministic Anthropic policy block). The sweeper later reads
        // this to decide whether to re-fire orchestrator vs. escalate.
        failureKind: 'transient',
        failureReason: 'runner stale (no progress for >5min)',
        failureMeta: null,
        classifierVersion: 1,
        createdAt: updatedRow.created_at,
      },
      'stale',
    );
    if (retryOutcome.scheduled) retriedCount++;
  }

  return { failed: failedCount, retried: retriedCount, durationMs: Date.now() - t0 };
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
