// What a channel agent's thread owes: whether a request in it has no result yet (REQ-77 BC-8).

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { answersThread } from './thread-answer.js';

/**
 * Whether a thread holds a request its replies have not answered: what a request is, for the one
 * result each gets (REQ-77 BC-8). A request is one handing of the thread's messages: an answer, a
 * note core tells the session and a member's message all count; the session's own checks and posts
 * do not, and a master's post there is a result as a reply is (ISS-1243). A message counts from when the session was handed it, never only from when it was
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
    // what answers a thread is one definition every reader shares (ISS-1422, `thread-answer.ts`)
    .where(and(inThread, answersThread))
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

/** A request a reply names as the one it answers: its thread and its message (ISS-1314). */
export interface NamedRequest {
  thread: string;
  message: string;
}

/**
 * Whether a channel agent's post in `thread` is a result a request is owed (REQ-77 BC-8): its own
 * thread holds a request no result answered, or the request it names, asked in another thread of
 * the room, does (ISS-1314: an owner keeps each matter in one thread, so its answer goes there).
 * Answers the request it answers elsewhere, or where and why it is no result owed.
 */
export async function resultOwed(
  roomId: string,
  thread: string,
  request: NamedRequest | undefined,
): Promise<
  | { ok: true; elsewhere: NamedRequest | null }
  | { ok: false; pointer: string; why: 'answered' | 'unknown' }
> {
  if (request) {
    const [named] = await db
      .select({ id: supportActions.id })
      .from(supportActions)
      .where(
        and(
          eq(supportActions.roomId, roomId),
          eq(supportActions.thread, request.thread),
          eq(supportActions.kind, 'message_in'),
          eq(supportActions.externalId, request.message),
        ),
      )
      .limit(1);
    if (!named) return { ok: false, pointer: '/request/message', why: 'unknown' };
  }
  const asked = request?.thread ?? thread;
  if (!(await unansweredInThread(roomId, asked))) {
    return { ok: false, pointer: request ? '/request' : '/thread', why: 'answered' };
  }
  return { ok: true, elsewhere: request && request.thread !== thread ? request : null };
}
