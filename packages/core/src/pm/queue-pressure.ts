import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { spawnPmSession } from './spawner.js';

const PM_QUEUE_PRESSURE_QUEUE = 'pm.queue-pressure';
const PM_QUEUE_PRESSURE_CRON = '* * * * *';
// v1: hardcoded threshold per ISS-20 acceptance criteria. A configurable
// `pm_config.queue_pressure_threshold` is explicitly out of scope.
const QUEUE_PRESSURE_THRESHOLD = 5;

let registered = false;

/**
 * Run one queue-pressure sweep: spawn a PM session for each project whose
 * non-PM queued backlog exceeds the threshold. Excludes `type='pm'` from
 * the count so a PM backlog cannot self-trigger.
 */
export async function runPmQueuePressureSweepOnce(): Promise<string[]> {
  const result = await db.execute<{ project_id: string; queued: number }>(sql`
    SELECT project_id, count(*)::int AS queued
    FROM jobs
    WHERE status = 'queued' AND type <> 'pm'
    GROUP BY project_id
    HAVING count(*) > ${QUEUE_PRESSURE_THRESHOLD}
  `);
  // drizzle-orm's `db.execute` shape varies across drivers — handle both
  // `{ rows }` (pg) and direct array results so tests and prod align.
  const rows: Array<{ project_id: string; queued: number }> = Array.isArray(result)
    ? (result as Array<{ project_id: string; queued: number }>)
    : ((result as { rows?: Array<{ project_id: string; queued: number }> }).rows ?? []);

  // ISS-104 — enrich the PM session eventRef with in-flight run pressure so
  // the PM agent can reason about pipeline depth, not just queue backlog. A
  // separate query keeps the existing pressure SQL untouched.
  const pressureByProject = await loadInFlightRunPressure();

  const fired: string[] = [];
  for (const r of rows) {
    const pressure = pressureByProject.get(r.project_id) ?? {
      inFlightRuns: 0,
      oldestRunAgeSeconds: 0,
    };
    const out = await spawnPmSession({
      projectId: r.project_id,
      cause: 'queue-pressure',
      eventRef: {
        queued: r.queued,
        threshold: QUEUE_PRESSURE_THRESHOLD,
        inFlightRuns: pressure.inFlightRuns,
        oldestRunAgeSeconds: pressure.oldestRunAgeSeconds,
      },
    });
    if (out.ok) fired.push(r.project_id);
  }
  if (fired.length > 0) logger.info({ projectIds: fired }, 'pm.queue-pressure: fired');
  return fired;
}

async function loadInFlightRunPressure(): Promise<
  Map<string, { inFlightRuns: number; oldestRunAgeSeconds: number }>
> {
  const result = await db.execute<{
    project_id: string;
    in_flight_runs: number;
    oldest_run_age_seconds: number;
  }>(sql`
    SELECT
      project_id,
      count(*)::int AS in_flight_runs,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(started_at)))::int, 0)
        AS oldest_run_age_seconds
    FROM pipeline_runs
    WHERE status IN ('running','paused')
      AND finished_at IS NULL
    GROUP BY project_id
  `);
  const rows: Array<{
    project_id: string;
    in_flight_runs: number;
    oldest_run_age_seconds: number;
  }> = Array.isArray(result)
    ? (result as Array<{
        project_id: string;
        in_flight_runs: number;
        oldest_run_age_seconds: number;
      }>)
    : ((result as {
        rows?: Array<{
          project_id: string;
          in_flight_runs: number;
          oldest_run_age_seconds: number;
        }>;
      }).rows ?? []);
  const map = new Map<string, { inFlightRuns: number; oldestRunAgeSeconds: number }>();
  for (const r of rows) {
    map.set(r.project_id, {
      inFlightRuns: Number(r.in_flight_runs),
      oldestRunAgeSeconds: Number(r.oldest_run_age_seconds),
    });
  }
  return map;
}

export async function registerPmQueuePressureSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(PM_QUEUE_PRESSURE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(PM_QUEUE_PRESSURE_QUEUE, async () => {
    try {
      await runPmQueuePressureSweepOnce();
    } catch (err) {
      logger.error({ err }, 'pm.queue-pressure: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(PM_QUEUE_PRESSURE_QUEUE, PM_QUEUE_PRESSURE_CRON, {});
  registered = true;
}

export function _resetPmQueuePressureForTest(): void {
  registered = false;
}
