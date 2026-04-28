import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const RETENTION_QUEUE = 'job-event-retention';

const BATCH_SIZE = 10_000;

function deletedCount(result: unknown): number {
  // postgres-js returns `count`; node-pg returns `rowCount`. Other drivers
  // without RETURNING cannot report a deletion count — treat as 0 and rely
  // on the batch loop terminating when we see a short batch.
  const r = result as { count?: unknown; rowCount?: unknown } | null;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  return 0;
}

/**
 * Delete job_events rows older than 30 days for jobs in terminal states.
 * Preserves the parent jobs row for audit; only trims event history.
 * Runs in 10k-row batches to avoid long locks on large tables.
 */
export async function runRetentionSweep(): Promise<{ deleted: number; durationMs: number }> {
  const t0 = Date.now();
  let total = 0;
  // Cap iterations defensively so a buggy count never spins forever.
  for (let i = 0; i < 1000; i++) {
    const result = await db.execute(sql`
      DELETE FROM job_events
      WHERE id IN (
        SELECT id FROM job_events
        WHERE ts < now() - interval '30 days'
          AND job_id IN (SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled'))
        LIMIT ${BATCH_SIZE}
      )
    `);
    const batch = deletedCount(result);
    total += batch;
    if (batch < BATCH_SIZE) break;
  }
  return { deleted: total, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerRetentionSweeper(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RETENTION_QUEUE);
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
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RETENTION_QUEUE, '0 3 * * *');
  registered = true;
}

export function resetRetentionSweeperForTest(): void {
  registered = false;
}
