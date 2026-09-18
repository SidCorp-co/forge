/**
 * The tick that keeps a room's transcript index caught up (ISS-1090).
 *
 * Indexing is asynchronous and belongs to nobody's turn: a room is indexed
 * because it has retained content nothing has read, not because somebody
 * answered in it. That is the whole of rule 2 expressed as a schedule — a room
 * the guards stayed quiet in gets indexed exactly like one that answered,
 * because this loop cannot tell them apart and never asks.
 *
 * It sits beside `conversation-drain.ts` rather than in `conversations/` for
 * that file's own reason: `index.ts` starts it, and a registration living in
 * the store's directory would make the process entrypoint reach a module it did
 * not already — the fan-out the relations gate holds at six and which this
 * layer exists to absorb (ISS-1004 step 5). The rule itself stays in
 * `conversations/transcript-index.ts`; what is here is only the schedule.
 */

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
    // cm:guard one room's failure does not take the tick with it, and it is LOGGED rather than
    // swallowed: a room whose index throws every tick is a room whose past is quietly unsearchable,
    // and the only thing standing between that and nobody knowing is this line.
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
