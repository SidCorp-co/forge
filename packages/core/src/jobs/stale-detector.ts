import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { killGraceMs } from './kill-gate.js';
import { RESULT_QUIET_MINUTES } from './loop-monitor.js';
import { quietJobCandidateQuery } from './progress-signal.js';

/** Extra quiet time past the loop's threshold before this alarm fires —
 *  covers the loop's 1-minute tick cadence with slack. */
const ALARM_MARGIN_MINUTES = 5;

type StaleAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

export function staleAlarmQuery(now: Date = new Date()): SQL {
  return quietJobCandidateQuery({
    columns: sql`j.id, j.project_id, j.issue_id`,
    quietMinutes: RESULT_QUIET_MINUTES + ALARM_MARGIN_MINUTES,
    killGateCutoffIso: new Date(now.getTime() - killGraceMs()).toISOString(),
  });
}

export async function runStaleSweep(now: Date = new Date()): Promise<{
  failed: number;
  durationMs: number;
}> {
  const t0 = Date.now();
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
