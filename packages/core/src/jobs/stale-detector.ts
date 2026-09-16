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
 *
 * ISS-1013 — the pass stays an INDEPENDENT query on its own schedule, and
 * that independence is the whole of what it buys: a pass fed from the loop's
 * own recorded counts is silent exactly when the loop has stopped running,
 * which is the one thing this alarm exists to catch. What it no longer is, is
 * a SECOND predicate. It takes `quietJobCandidateQuery` — the result hop's own
 * builder — so the two cannot drift; until ISS-1013 it carried a copy that had
 * drifted four ways at once, and every one of them was a wrong answer:
 *
 *   - no phase term, so every autonomous driver declaring phases and emitting
 *     no job_events wedged an operator alert every five minutes for working;
 *   - no park exemption, so every human park quiet past 65 minutes did too;
 *   - no kill-gate exclusion, so a job the gate is deliberately holding read
 *     as a loop that had missed it — the exact term `sweeper.ts`'s two job
 *     alarms already carry, and for the same stated reason;
 *   - the raw `NOT EXISTS result` guard rather than `RESULT_GUARD`, so a
 *     duplex session's job went permanently invisible to this alarm after its
 *     first turn wrote a `result` — the one case where a genuine loop miss
 *     matters most, and the only one of the four that made the alarm see LESS.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { boss } from '../queue/boss.js';
import { killGraceMs } from './kill-gate.js';
import { RESULT_QUIET_MINUTES } from './loop-monitor.js';
import { quietJobCandidateQuery } from './progress-signal.js';

export const STALE_DETECTOR_QUEUE = 'stale-job-detector';

/** Extra quiet time past the loop's threshold before this alarm fires —
 *  covers the loop's 1-minute tick cadence with slack. */
const ALARM_MARGIN_MINUTES = 5;

type StaleAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

/** The alarm's candidate query: the loop's own, at threshold plus margin, and
 *  with the kill-gate grace excluded. Exported so a plan is read off the
 *  subject rather than off a likeness of it. */
export function staleAlarmQuery(now: Date = new Date()): SQL {
  return quietJobCandidateQuery({
    columns: sql`j.id, j.project_id, j.issue_id`,
    quietMinutes: RESULT_QUIET_MINUTES + ALARM_MARGIN_MINUTES,
    killGateCutoffIso: new Date(now.getTime() - killGraceMs()).toISOString(),
  });
}

/**
 * Detect (do NOT reap) `dispatched`/`running` jobs the result hop should have
 * acted on and did not: quiet past the loop's threshold plus the margin, by
 * the loop's own definition of quiet, and not held by the kill gate.
 */
export async function runStaleSweep(now: Date = new Date()): Promise<{
  failed: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  // ISS-280 — emit a sweep-start trace so a silently-unscheduled detector
  // (the registration is wired at index.ts, but a pg-boss schedule failure
  // would otherwise be invisible) is detectable from logs alone.
  logger.debug('stale-job-detector: alarm sweep start');
  const thresholdMinutes = RESULT_QUIET_MINUTES + ALARM_MARGIN_MINUTES;
  const stale = await db.execute<StaleAlarmRow>(staleAlarmQuery(now));

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
