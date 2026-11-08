// What a door that follows one message through its turn reads of a room (REQ-91): the message a
// sender's own key already wrote, the window that answers a message, and which replies wait on the
// person. Reads only; the rows are written where they always were (`store.ts`, `windows.ts`).

import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { conversationMessages, conversationWindows } from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';
import { type ConversationWindowRow, windowSelection } from './windows.js';

/** A person's earlier message in this room under the same transport key, if one is there. */
export async function earlierUnderKey(
  tx: Executor,
  conversationId: string,
  key: string,
  seq: number,
): Promise<{ id: string; seq: number; content: string } | null> {
  const [row] = await tx
    .select({
      id: conversationMessages.id,
      seq: conversationMessages.seq,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.externalId, key),
        eq(conversationMessages.role, 'user'),
        lt(conversationMessages.seq, seq),
      ),
    )
    .orderBy(asc(conversationMessages.seq))
    .limit(1);
  return row ?? null;
}

/** One message of this room by its id, or null where the room holds none by that id. */
export async function messageInRoom(
  conversationId: string,
  messageId: string,
  tx: Executor = defaultDb,
): Promise<{ id: string; seq: number; role: string } | null> {
  const [row] = await tx
    .select({
      id: conversationMessages.id,
      seq: conversationMessages.seq,
      role: conversationMessages.role,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.id, messageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The window answering the message at `seq`: the newest one whose range holds it, or null. */
export async function windowCovering(
  conversationId: string,
  seq: number,
  tx: Executor = defaultDb,
): Promise<ConversationWindowRow | null> {
  const [row] = await tx
    .select(windowSelection)
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, conversationId),
        lte(conversationWindows.firstSeq, seq),
        gte(conversationWindows.lastSeq, seq),
      ),
    )
    .orderBy(desc(conversationWindows.openedAt))
    .limit(1);
  return (row as ConversationWindowRow | undefined) ?? null;
}

/** Which of these messages are replies that wait on a person's answer (ISS-277's own record). */
export async function awaitingReplies(
  conversationId: string,
  ids: readonly string[],
  tx: Executor = defaultDb,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        inArray(conversationMessages.id, [...ids]),
        eq(conversationMessages.awaitsReply, true),
      ),
    );
  return new Set(rows.map((r) => r.id));
}
