/**
 * DEMOTED (ISS-449 / ISS-442 C3) — stale-job ALARM, no longer a reaper.
 *
 * The loop monitor's result hop (`jobs/loop-monitor.ts` `reapResultMisses`)
 * now owns the no-progress timeout: same predicate (dispatched/running, no
 * `result` event, quiet past RESULT_QUIET_MINUTES), evaluated every minute on
 * the pipeline-sweeper tick and reaped through `applyKernelTransition` +
 * `finalizeFailedJob`. This 5-minute schedule remains ONLY as an assertion:
 * a row still matching past the loop threshold PLUS a margin is a loop MISS,
 * logged as `loop-miss` and surfaced as a `pipeline_wedge` — coverage proof
 * during the cutover (deletion happens at the ISS-442 parent integration).
 *
 * The ALARM_MARGIN_MINUTES guard exists because this schedule is independent
 * of the loop tick: a row crossing the 60-min threshold between loop ticks
 * would otherwise race a false alarm. With the margin, only a row the loop
 * has demonstrably had time to handle (and didn't) fires.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { boss } from '../queue/boss.js';
import { RESULT_QUIET_MINUTES } from './loop-monitor.js';

export const STALE_DETECTOR_QUEUE = 'stale-job-detector';

/** Extra quiet time past the loop's threshold before this alarm fires —
 *  covers the loop's 1-minute tick cadence with slack. */
const ALARM_MARGIN_MINUTES = 5;

type StaleAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

/**
 * Detect (do NOT reap) `dispatched`/`running` jobs whose latest job_event is
 * older than the loop's result threshold + margin (or whose dispatched_at is,
 * if no events), excluding jobs that already emitted a `result` event (those
 * are finalize-drops, not stale runners — ISS-258 false-positive guard,
 * preserved verbatim from the reaper era).
 */
export async function runStaleSweep(): Promise<{
  failed: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  // ISS-280 — emit a sweep-start trace so a silently-unscheduled detector
  // (the registration is wired at index.ts, but a pg-boss schedule failure
  // would otherwise be invisible) is detectable from logs alone.
  logger.debug('stale-job-detector: alarm sweep start');
  const thresholdMinutes = RESULT_QUIET_MINUTES + ALARM_MARGIN_MINUTES;
  const stale = await db.execute<StaleAlarmRow>(
    sql.raw(`
    WITH last_event AS (
      SELECT job_id, MAX(ts) AS max_ts
      FROM job_events
      GROUP BY job_id
    )
    SELECT j.id, j.project_id, j.issue_id
    FROM jobs j
    LEFT JOIN last_event le ON le.job_id = j.id
    WHERE j.status IN ('dispatched', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM job_events
        WHERE job_id = j.id AND kind = 'result'
      )
      AND GREATEST(COALESCE(le.max_ts, j.dispatched_at), j.dispatched_at) <
          now() - interval '${thresholdMinutes} minutes'
  `),
  );

  if (stale.length > 0) {
    logger.warn({ hop: 'result', entity: 'job', ids: stale.map((r) => r.id) }, 'loop-miss');
    for (const row of stale) {
      await emitPipelineWedge({
        projectId: row.project_id,
        issueId: row.issue_id,
        hop: 'result',
        entity: 'job',
        entityId: row.id,
        reason: `loop-miss: job quiet for >${thresholdMinutes}min and the result hop did not reap it`,
        action:
          'Inspect core logs for a thrown result-hop handler; if the job is genuinely wedged, use the single-job cancel escape hatch (forge_jobs cancel).',
      });
    }
  }

  // `failed` retains its name for the result-shape consumers (logs/tests) but
  // now counts ALARMED loop misses — this pass performs no terminal writes.
  return { failed: stale.length, durationMs: Date.now() - t0 };
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
