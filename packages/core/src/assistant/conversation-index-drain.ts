import {
  conversationsNeedingIndex,
  indexConversationOnce,
} from '../conversations/transcript-index.js';
import { logger } from '../observability/logger.js';

/** Rooms one tick takes. Each is a bounded pass of its own, so a busy fleet drains over ticks. */
export const TRANSCRIPT_INDEX_ROOMS_PER_TICK = 20;

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
