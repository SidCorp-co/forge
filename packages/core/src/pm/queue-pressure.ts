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
  const fired: string[] = [];
  // drizzle-orm's `db.execute` shape varies across drivers — handle both
  // `{ rows }` (pg) and direct array results so tests and prod align.
  const rows: Array<{ project_id: string; queued: number }> = Array.isArray(result)
    ? (result as Array<{ project_id: string; queued: number }>)
    : ((result as { rows?: Array<{ project_id: string; queued: number }> }).rows ?? []);
  for (const r of rows) {
    const out = await spawnPmSession({
      projectId: r.project_id,
      cause: 'queue-pressure',
      eventRef: { queued: r.queued, threshold: QUEUE_PRESSURE_THRESHOLD },
    });
    if (out.ok) fired.push(r.project_id);
  }
  if (fired.length > 0) logger.info({ projectIds: fired }, 'pm.queue-pressure: fired');
  return fired;
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
