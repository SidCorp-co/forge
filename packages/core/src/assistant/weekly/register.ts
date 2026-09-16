/**
 * ISS-1056 — the schedule: one pg-boss cron entry, every day at 04:00 UTC, in the shape every
 * sweeper in core takes (`memory/consolidation.ts:registerMemoryConsolidation`). The tick body is
 * `runAssistantWeeklyOnce`, which tests call without pg-boss. Monday's tick is the first for a new
 * week; the six that follow name the same window (`window.ts:weekBefore`) and are the retry of a
 * week that failed, skipping in one query when its report is already on the issue.
 */

import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import { runAssistantWeeklyOnce } from './run.js';

export const ASSISTANT_WEEKLY_QUEUE = 'assistant-weekly-report';
export const ASSISTANT_WEEKLY_CRON = '0 4 * * *';

let registered = false;

export async function registerAssistantWeekly(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(ASSISTANT_WEEKLY_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(ASSISTANT_WEEKLY_QUEUE, { batchSize: 1 }, async () => {
    try {
      const outcomes = await runAssistantWeeklyOnce();
      logger.info(
        {
          posted: outcomes.filter((o) => o.outcome === 'posted').length,
          skipped: outcomes.filter((o) => o.outcome === 'skipped').length,
          failed: outcomes.filter((o) => o.outcome === 'failed').length,
        },
        'assistant.weekly: tick complete',
      );
    } catch (err) {
      logger.error({ err }, 'assistant.weekly: tick threw');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(ASSISTANT_WEEKLY_QUEUE, ASSISTANT_WEEKLY_CRON, {});
  registered = true;
}

export async function unregisterAssistantWeekly(): Promise<void> {
  if (!registered) return;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).unschedule(ASSISTANT_WEEKLY_QUEUE);
  } finally {
    registered = false;
  }
}

export function resetAssistantWeeklyForTest(): void {
  registered = false;
}
