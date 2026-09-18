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
// cm:guard the scope check alone is the wrong rule for a `direct` room and became a live hole the moment a screen read this router: `derivedScope` answers what the room is ABOUT, so every member of the project passed it and one person's private chat was readable by all of them. `agent_sessions` has had this fence since ISS-522 (`eq(agentSessions.userId, userId)` on the interactive list) and the conversation store never needed one because nothing read it (ISS-1004 step 5).
// cm:guard it refuses a `direct` room whose people were never recorded — a Rocket.Chat DM, where the collector opens the venue and adds no person — rather than falling back to the scope check. Nobody reading such a room in the Forge UI is the safe half of the trade and the visible one; the other half would be handing Bob the transcript of Alice's DM with the bot.
// cm:guard `userId` is nullable here for the same reason `assertConversationRole` takes one: a caller that named nobody is a caller, and a door reached without an authority must be refusable rather than untypable. Nothing about the answer moved — a null was already not in any room, and `assertConversationReadable` refuses it first on every path that composes the two (ISS-1090).
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
// cm:guard this is NOT `assertInTheRoom` with the shape test dropped, and the difference is the whole point: reading a group room is a scope question, and CHANGING one is not. Reusing the read rule here would let anybody holding roles on a group room's projects add an agent to it, take a colleague out of it, and widen what it can see — none of which they are in the room to have a view about (ISS-1011 criterion 37).
// cm:guard a room that records NO people is therefore not changeable from Forge at all, and that is the truthful answer rather than a gap: a Rocket.Chat room's membership is its channel's, and the refusal says so instead of letting the Forge UI write a membership the channel will never show.
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
// cm:guard the checks are INSIDE the transaction and behind a `FOR UPDATE` on the conversation, because every one of them is a read the write then depends on: two requests that each read a scope of one project — one adding a second project's agent, one adding a colleague who holds no role on that second project — both pass and both commit, leaving a person listed in a room they are refused on opening. Serializing on the row is the same fence `removeParticipant` already takes for its last-handle count, for the same reason (ISS-1011, review F5).
// cm:guard the writable door AND the membership actor check, in that order, because they refuse different people and both refusals are owed: the first is "you hold no member role on a project this room is about", the second is "you are not in this room". A caller failing both is told about the role first, which is the one they can do something about.
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
// cm:guard answered by the SERVER and handed to the screen rather than derived on the client from a project role: group readability admits a project member who is not in the room, and a screen deciding on the role alone shows them an Add agent button every press of which is refused. A capability the server computes is the only one that agrees with the door (ISS-1011, review F6).
export async function mayChangeMembership(row: ConversationRow, userId: string): Promise<boolean> {
  try {
    await assertConversationWritable(row.id, userId);
    await assertMembershipActor(row, userId);
    return true;
  } catch {
    return false;
  }
}
