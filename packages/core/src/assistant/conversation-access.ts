// Who may look at a room, who may change it, and who may change who is in it.
//
// Three different questions with three different answers, lifted out of
// `conversation-routes.ts` when the membership surface arrived so that both
// routers ask the same ones rather than each keeping a copy (ISS-1011).

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Executor } from '../conversations/db-executor.js';
import { projectsNamed } from '../conversations/membership.js';
import { listParticipants } from '../conversations/participants.js';
import { roomGone, roomRefusal } from '../conversations/room-refusal.js';
import { assertConversationReadable, assertConversationWritable } from '../conversations/scope.js';
import { type ConversationRow, getConversation } from '../conversations/store.js';
import { db as defaultDb } from '../db/client.js';
import { conversations } from '../db/schema-conversations.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';

/**
 * A room is started by somebody holding the member role or above on its project. A viewer is one of
 * the project's members, and is told the role they hold rather than that they are not one (ISS-1229
 * r35, judge-95).
 */
export async function assertMayStartRoom(projectId: string, userId: string): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  if (access.role === 'viewer') {
    const [project] = await projectsNamed([projectId]);
    throw roomRefusal(
      403,
      'FORBIDDEN',
      `You hold the viewer role on ${project?.name ?? 'this project'}; a viewer cannot start a room.`,
      { projectId },
    );
  }
  assertProjectRole(access, 'member', 'not a project member');
}

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
  throw roomRefusal(
    403,
    'NOT_IN_THE_ROOM',
    'This room is a one-to-one room and you are not one of its people, so there is nothing here for you to read',
    { conversationId: row.id },
  );
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
  throw roomRefusal(
    403,
    'NOT_IN_THE_ROOM',
    people.some((p) => p.kind === 'person')
      ? 'This room is changed by the people in it and you are not one of them'
      : `This room records none of its people — it is a ${row.adapter} room, and who is in it is decided where it lives rather than here`,
    { conversationId: row.id },
  );
}

/** What a reader of a room is asked, in one place; its scope where they pass. */
async function readersScope(
  row: ConversationRow,
  userId: string | null | undefined,
): Promise<string[]> {
  const scope = await assertConversationReadable(row.id, userId);
  await assertInTheRoom(row, userId);
  return scope;
}

/** The room, if this caller may look at it. */
export async function readableConversation(
  id: string,
  userId: string | null | undefined,
): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw roomGone(id);
  await readersScope(row, userId);
  return row;
}

/**
 * The room's scope where this caller may open it, else null: the room list asks the read door's own
 * question, so a room the reader can open is a room the list shows (ISS-1229 r33, judge-92).
 */
export async function scopeIfReadable(
  row: ConversationRow,
  userId: string | null | undefined,
): Promise<string[] | null> {
  try {
    return await readersScope(row, userId);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 403) return null;
    throw err;
  }
}

/** Renaming and deleting are writes, and a write takes more than a look. A room about no project is
 *  its opener's and its organization admins' to change, whether or not they are in it (ISS-1229 r23). */
export async function writableConversation(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw roomGone(id);
  const scope = await assertConversationWritable(row.id, userId);
  if (scope.length > 0) await assertInTheRoom(row, userId);
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
    if (!row) throw roomGone(id);
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
