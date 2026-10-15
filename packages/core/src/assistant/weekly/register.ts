import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import { runAssistantWeeklyOnce } from './run.js';

export const ASSISTANT_WEEKLY_QUEUE = 'assistant-weekly-report';
export const ASSISTANT_WEEKLY_CRON = '0 4 * * *';

let registered = false;

export async function registerAssistantWeekly(): Promise<void> {
  if (registered) return;
  await boss.createQueue(ASSISTANT_WEEKLY_QUEUE);
  await boss.work(ASSISTANT_WEEKLY_QUEUE, { batchSize: 1 }, async () => {
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
  await boss.schedule(ASSISTANT_WEEKLY_QUEUE, ASSISTANT_WEEKLY_CRON, {});
  registered = true;
}

export async function unregisterAssistantWeekly(): Promise<void> {
  if (!registered) return;
  try {
    await boss.unschedule(ASSISTANT_WEEKLY_QUEUE);
  } finally {
    registered = false;
  }
}

export function resetAssistantWeeklyForTest(): void {
  registered = false;
}
