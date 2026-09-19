// Who may look at a room, who may change it, and who may change who is in it.
//
// Three different questions with three different answers, lifted out of
// `conversation-routes.ts` when the membership surface arrived so that both
// routers ask the same ones rather than each keeping a copy (ISS-1011).

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Executor } from '../conversations/db-executor.js';
import { listParticipants } from '../conversations/participants.js';
import { assertConversationReadable, assertConversationWritable } from '../conversations/scope.js';
import { type ConversationRow, getConversation } from '../conversations/store.js';
import { db as defaultDb } from '../db/client.js';
import { conversations } from '../db/schema-conversations.js';

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

/**
 * A one-to-one room is read by the people IN it, whatever roles its scope would grant.
 */
export async function assertInTheRoom(
  row: ConversationRow,
  userId: string | null | undefined,
  tx: Executor = defaultDb,
): Promise<void> {
  if (row.shape !== 'direct') return;
  const people = await listParticipants(row.id, tx);
  if (people.some((p) => p.kind === 'person' && p.userId === userId)) return;
  throw new HTTPException(403, {
    message: `conversation ${row.id} is a one-to-one room and you are not one of its people, so there is nothing here for you to read`,
    cause: { code: 'NOT_IN_THE_ROOM' },
  });
}

/**
 * Who may change WHO IS IN a room: somebody already in it, whatever its shape.
 */
export async function assertMembershipActor(
  row: ConversationRow,
  userId: string,
  tx: Executor = defaultDb,
): Promise<void> {
  const people = await listParticipants(row.id, tx);
  if (people.some((p) => p.kind === 'person' && p.userId === userId)) return;
  throw new HTTPException(403, {
    message: people.some((p) => p.kind === 'person')
      ? `conversation ${row.id} is changed by the people in it and you are not one of them`
      : `conversation ${row.id} records none of its people — it is a ${row.adapter} room, and who is in it is decided where it lives rather than here`,
    cause: { code: 'NOT_IN_THE_ROOM' },
  });
}

/** The room, if this caller may look at it. */
export async function readableConversation(
  id: string,
  userId: string | null | undefined,
): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationReadable(row.id, userId);
  await assertInTheRoom(row, userId);
  return row;
}

/** Renaming and deleting are writes, and a write takes more than a look. */
export async function writableConversation(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationWritable(row.id, userId);
  await assertInTheRoom(row, userId);
  return row;
}

/**
 * Run one membership change with the room held still underneath it.
 */
export async function withMembershipLock<T>(
  id: string,
  userId: string,
  run: (tx: Executor, room: ConversationRow, scope: string[]) => Promise<T>,
  db: typeof defaultDb = defaultDb,
): Promise<T> {
  return db.transaction(async (handle) => {
    const tx = handle as unknown as Executor;
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, id))
      .for('update')
      .limit(1);
    const row = await getConversation(id, tx);
    if (!row) throw notFound('conversation not found');
    const scope = await assertConversationWritable(row.id, userId, tx);
    await assertMembershipActor(row, userId, tx);
    return run(tx, row, scope);
  });
}

/**
 * Whether this caller may change who is in this room — the same two questions, answered.
 */
export async function mayChangeMembership(row: ConversationRow, userId: string): Promise<boolean> {
  try {
    await assertConversationWritable(row.id, userId);
    await assertMembershipActor(row, userId);
    return true;
  } catch {
    return false;
  }
}
