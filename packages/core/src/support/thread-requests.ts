// What a channel agent's thread owes: whether a request in it has no result yet (REQ-77 BC-8).

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';

/**
 * Whether a thread holds a request its replies have not answered: what a request is, for the one
 * result each gets (REQ-77 BC-8). A request is one handing of the thread's messages: an answer, a
 * note core tells the session and a member's message all count; the session's own checks and posts
 * do not. A message counts from when the session was handed it, never only from when it was
 * recorded: a result note core recorded while the session wrote its last reply, and handed it in the
 * next turn, is a request of its own (ISS-1117). So is one handed into the running turn while that
 * reply was being written, before it was recorded: two handings since the reply before last owe two
 * results, and the last reply was one of them (ISS-1221).
 */
export async function unansweredInThread(roomId: string, thread: string): Promise<boolean> {
  const inThread = and(eq(supportActions.roomId, roomId), eq(supportActions.thread, thread));
  const [last, before] = await db
    .select({ at: supportActions.createdAt })
    .from(supportActions)
    .where(and(inThread, eq(supportActions.kind, 'reply')))
    .orderBy(desc(supportActions.createdAt))
    .limit(2);
  if (!last) return true;
  const handedAt = sql<Date>`greatest(${supportActions.createdAt}, ${supportActions.deliveredAt})`;
  const rows = await db
    .select({
      at: handedAt,
      batch: supportActions.deliveredAt,
      handed: sql<boolean>`COALESCE(${supportActions.output}, '{}'::jsonb) ? 'path'`,
    })
    .from(supportActions)
    .where(
      and(
        inThread,
        eq(supportActions.kind, 'message_in'),
        before ? sql`${handedAt} > ${new Date(before.at).toISOString()}::timestamptz` : undefined,
      ),
    );
  const lastAt = new Date(last.at).getTime();
  if (rows.some((r) => new Date(r.at).getTime() > lastAt)) return true;
  // a handing is one turn's batch: the messages a turn was handed share the moment it took them
  const handings = new Set(
    rows.flatMap((r) => (r.handed && r.batch ? [new Date(r.batch).getTime()] : [])),
  );
  return handings.size >= 2;
}
