import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { finalizeFailedJob } from './finalize-failure.js';

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
 * route through the shared finalize tail (ISS-393) — verify-first retry
 * (device-rotated onto a fresh runner) or, when exhausted, park the issue at
 * `waiting` + reap the run. No progress is strong evidence the worker is
 * wedged; the retry engine's device rotation gives the next attempt a clean
 * runner rather than re-pinning the dead one.
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

  for (const row of stale) {
    // CAS-flip to failed, then re-select the camelCase Drizzle row so the
    // shared finalize tail (verify-first retry / park-to-waiting) runs against
    // a typed JobRow rather than the raw snake_case sweep row.
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
      RETURNING id
    `),
    );
    if (!updated[0]) continue;
    failedCount++;

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, row.id)).limit(1);
    if (!jobRow) continue;

    roomManager.publish(projectRoom(jobRow.projectId), {
      event: 'job.failed',
      data: { jobId: jobRow.id, status: 'failed', error: 'stale', reason: 'stale' },
    });

    try {
      await finalizeFailedJob(jobRow, {
        error: 'runner stale (no progress / no started event for >60min)',
      });
    } catch (err) {
      logger.error(
        { err, jobId: jobRow.id, issueId: jobRow.issueId },
        'stale-detector: finalizeFailedJob threw, job stays failed',
      );
    }
  }

  return { failed: failedCount, durationMs: Date.now() - t0 };
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
