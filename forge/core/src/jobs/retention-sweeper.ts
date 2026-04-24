import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const RETENTION_QUEUE = 'job-event-retention';

/**
 * Delete job_events rows older than 30 days for jobs in terminal states.
 * Preserves the parent jobs row for audit; only trims event history.
 */
export async function runRetentionSweep(): Promise<{ deleted: number; durationMs: number }> {
  const t0 = Date.now();
  const result = await db.execute(sql`
    DELETE FROM job_events
    WHERE ts < now() - interval '30 days'
      AND job_id IN (SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled'))
  `);
  // postgres-js returns `count` on the Result; different shapes across versions.
  // biome-ignore lint/suspicious/noExplicitAny: postgres-js result shape varies
  const anyResult = result as any;
  const deleted =
    typeof anyResult?.count === 'number'
      ? anyResult.count
      : typeof anyResult?.rowCount === 'number'
        ? anyResult.rowCount
        : Array.isArray(anyResult)
          ? anyResult.length
          : 0;
  return { deleted, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerRetentionSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RETENTION_QUEUE, '0 3 * * *');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RETENTION_QUEUE, async () => {
    try {
      const result = await runRetentionSweep();
      logger.info(result, 'job-event-retention: sweep complete');
    } catch (err) {
      logger.error({ err }, 'job-event-retention: sweep failed');
      throw err;
    }
  });
  registered = true;
}

export function resetRetentionSweeperForTest(): void {
  registered = false;
}
