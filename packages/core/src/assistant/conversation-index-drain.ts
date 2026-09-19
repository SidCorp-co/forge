import {
  conversationsNeedingIndex,
  indexConversationOnce,
} from '../conversations/transcript-index.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

const TRANSCRIPT_INDEX_QUEUE = 'conversations.transcript-index';
const TRANSCRIPT_INDEX_CRON = '* * * * *';
/** Rooms one tick takes. Each is a bounded pass of its own, so a busy fleet drains over ticks. */
export const TRANSCRIPT_INDEX_ROOMS_PER_TICK = 20;

let registered = false;

/** Index every room that is behind, up to this tick's budget; returns the ones it advanced. */
export async function runTranscriptIndexSweepOnce(): Promise<string[]> {
  const rooms = await conversationsNeedingIndex(TRANSCRIPT_INDEX_ROOMS_PER_TICK);
  const advanced: string[] = [];
  for (const conversationId of rooms) {
    try {
      const pass = await indexConversationOnce(conversationId);
      if (pass.outcome === 'indexed') advanced.push(conversationId);
    } catch (err) {
      logger.error({ err, conversationId }, 'conversations.transcript-index: room failed');
    }
  }
  if (advanced.length > 0) {
    logger.info({ rooms: advanced.length }, 'conversations.transcript-index: indexed');
  }
  return advanced;
}

export async function registerTranscriptIndexSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(TRANSCRIPT_INDEX_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(TRANSCRIPT_INDEX_QUEUE, async () => {
    try {
      await runTranscriptIndexSweepOnce();
    } catch (err) {
      logger.error({ err }, 'conversations.transcript-index: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(TRANSCRIPT_INDEX_QUEUE, TRANSCRIPT_INDEX_CRON, {});
  registered = true;
}

export function _resetTranscriptIndexSweeperForTest(): void {
  registered = false;
}
