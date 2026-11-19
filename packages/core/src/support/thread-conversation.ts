// Which conversation a thread of a room is recorded in (ISS-1344, FB-754): its first action that
// carries one. A master post the screen refused is recorded with none, and on 2026-11-19 the oldest
// row of two Forge-Communicate threads was such a refusal, so every act in them read the thread as
// one no member wrote in, after the owner had written there.

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';

/** The conversation one thread is recorded in, read off its first action that carries one. */
export async function threadConversation(roomId: string, thread: string): Promise<string | null> {
  const [row] = await db
    .select({ conversationId: supportActions.conversationId })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        isNotNull(supportActions.conversationId),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row?.conversationId ?? null;
}
