import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { runScheduleTickOnce } from './routes.js';

const TICK_QUEUE_NAME = 'schedule.tick';
const TICK_CRON = '* * * * *';

let workerId: string | null = null;

export async function registerScheduleTicker(): Promise<void> {
  if (workerId) return;
  await boss.createQueue(TICK_QUEUE_NAME);
  const id = await boss.work(TICK_QUEUE_NAME, { batchSize: 1 }, async (arg: unknown) => {
    const entries = Array.isArray(arg) ? arg : [arg];
    for (const _entry of entries) {
      try {
        const dispatched = await runScheduleTickOnce();
        if (dispatched.length > 0) {
          logger.info({ scheduleIds: dispatched }, 'schedule.tick: dispatched');
        }
      } catch (err) {
        logger.error({ err }, 'schedule.tick: handler threw');
        throw err;
      }
    }
  });
  workerId = id;
  // Schedule the tick to fire every minute.
  await boss.schedule(TICK_QUEUE_NAME, TICK_CRON, {});
}

export async function unregisterScheduleTicker(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  try {
    await boss.unschedule(TICK_QUEUE_NAME);
  } catch (err) {
    logger.warn({ err }, 'schedule.tick: unschedule failed');
  }
  await boss.offWork(TICK_QUEUE_NAME, { id });
}

export function isScheduleTickerRegistered(): boolean {
  return workerId !== null;
}
