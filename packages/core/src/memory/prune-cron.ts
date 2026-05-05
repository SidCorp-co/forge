import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { runMemoryPrune } from './prune.js';

export const MEMORY_PRUNE_QUEUE = 'memory-prune';

let registered = false;

/**
 * Idempotent registration of the daily memory-prune sweeper. Schedules
 * `runMemoryPrune` at 04:00 UTC (one hour after the job-event retention
 * sweeper) so the two don't compete for locks.
 */
export async function registerMemoryPruneSweeper(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_PRUNE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MEMORY_PRUNE_QUEUE, async () => {
    try {
      const result = await runMemoryPrune();
      logger.info(result, 'memory-prune: sweep complete');
    } catch (err) {
      logger.error({ err }, 'memory-prune: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(MEMORY_PRUNE_QUEUE, '0 4 * * *');
  registered = true;
}

export function resetMemoryPruneSweeperForTest(): void {
  registered = false;
}
