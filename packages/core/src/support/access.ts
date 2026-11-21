// Who may act for a support group: only its own session, holding the token core handed its current
// turn. The room's agent account is a member of nothing, so every other route refuses it; these are
// the only ones that admit it, and they admit nothing else (REQ-75, the identity decision in
// `docs/proposals/rocketchat-support-session.md`). A channel agent's session answers every group of
// its binding under one account (REQ-77), so its act names the group it acts in: by the thread or
// the message it answers, or by `rid`.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { boxSessionOfToken } from '../agent-sessions/index.js';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import { fenceReaches } from '../credentials/token-fence.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { refuse } from './refusals.js';
import { type RoomRow, roomsOfPrincipal } from './store.js';
import { technicalThreadOf } from './technical-thread-room.js';

/** What an act names that says which of a channel agent's groups it is in. */
export interface RoomHint {
  rid?: string | undefined;
  thread?: string | undefined;
  message?: string | undefined;
  /** The act reads the same whichever group it is read from (its grant and project are shared). */
  anyRoom?: boolean;
}

export async function sessionCaller(
  caller: {
    userId: string;
    tokenId: string | null | undefined;
    projectId: string;
  },
  hint: RoomHint = {},
): Promise<RoomRow> {
  const rooms = await roomsOfPrincipal(caller.userId);
  // the session a turn token was minted for, chat door or not: an owner-mode channel agent is none
  const tokenSession = caller.tokenId ? await boxSessionOfToken(caller.tokenId) : null;
  const session = rooms[0]?.sessionId ?? null;
  const sameSession = tokenSession !== null && tokenSession === session;
  // the turn's token is fenced to its project: a route naming another project is refused by the fence too
  const fenced = fenceReaches(fencedProjectIds(), caller.projectId);
  if (rooms.length === 0 || rooms[0]?.projectId !== caller.projectId || !sameSession || !fenced) {
    throw refuse(
      'SUPPORT_NOT_THE_ROOM_SESSION',
      "only a support group's own session, under the token its current turn was handed, acts here",
    );
  }
  return roomOf(rooms, hint);
}

/** The one group of the principal's rooms an act is in. */
async function roomOf(rooms: readonly RoomRow[], hint: RoomHint): Promise<RoomRow> {
  const [only] = rooms;
  if (rooms.length === 1 && only) return only;
  const rids = rooms.map((r) => r.rid).join(', ');
  if (hint.rid !== undefined) {
    const named = rooms.find((r) => r.rid === hint.rid) ?? (await roomOfTechnicalRid(rooms, hint));
    if (named) return named;
    throw refuse(
      'SUPPORT_ROOM_AMBIGUOUS',
      `this session answers the groups ${rids}, and not ${hint.rid}: name one of them as \`rid\``,
      '/rid',
    );
  }
  const found = (await roomOfRecord(rooms, hint)) ?? (await roomOfTechnicalThread(rooms, hint));
  if (found) return found;
  if (hint.anyRoom && only) return only;
  throw refuse(
    'SUPPORT_ROOM_AMBIGUOUS',
    hint.thread || hint.message
      ? `no group this session answers (${rids}) holds ${hint.thread ? `the thread ${hint.thread}` : `the message ${hint.message}`}: name the thread you were handed, or the group as \`rid\``
      : `this session answers several groups (${rids}): name the one this act is for as \`rid\``,
    hint.thread ? '/thread' : hint.message ? '/message' : '/rid',
  );
}

/** The room whose record holds the thread or the message the act names. */
async function roomOfRecord(rooms: readonly RoomRow[], hint: RoomHint): Promise<RoomRow | null> {
  if (!hint.thread && !hint.message) return null;
  const ids = rooms.map((r) => r.id);
  const [row] = await db
    .select({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, ids),
        hint.thread
          ? eq(supportActions.thread, hint.thread)
          : eq(supportActions.externalId, hint.message ?? ''),
      ),
    )
    .limit(1);
  return rooms.find((r) => r.id === row?.roomId) ?? null;
}

/**
 * The group whose project's own thread of the shared operations room holds the thread or message the
 * act names (ISS-1359): the owner is asked there since ISS-1271 and answers there, recorded on the
 * shared room's row, so no group of the session holds it. The read then goes to that thread alone.
 */
async function roomOfTechnicalThread(
  rooms: readonly RoomRow[],
  hint: RoomHint,
): Promise<RoomRow | null> {
  if (!hint.thread && !hint.message) return null;
  for (const room of rooms) {
    const technical = await technicalThreadOf(room);
    if (!technical) continue;
    if (hint.thread) {
      if (hint.thread === technical.thread) return room;
      continue;
    }
    const [row] = await db
      .select({ thread: supportActions.thread })
      .from(supportActions)
      .where(
        and(
          eq(supportActions.roomId, technical.shared.id),
          eq(supportActions.externalId, hint.message ?? ''),
        ),
      )
      .limit(1);
    if (row?.thread === technical.thread) return room;
  }
  return null;
}

/**
 * The group whose project's technical channel is the room `rid` names (ISS-1347, FB-794): the shared
 * operations room it raises in, or a direct message it raised in. The owner answers there, so an act
 * citing his message there may name that room; the thread or message it names picks the group.
 */
async function roomOfTechnicalRid(
  rooms: readonly RoomRow[],
  hint: RoomHint,
): Promise<RoomRow | null> {
  const raisedIn = await db
    .select({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(
      and(
        inArray(
          supportActions.roomId,
          rooms.map((r) => r.id),
        ),
        sql`${supportActions.output} ->> 'rid' = ${hint.rid ?? ''}`,
      ),
    );
  const raised = new Set(raisedIn.map((r) => r.roomId));
  const ofChannel: RoomRow[] = [];
  for (const room of rooms) {
    if (raised.has(room.id) || (await technicalThreadOf(room))?.shared.rid === hint.rid) {
      ofChannel.push(room);
    }
  }
  if (ofChannel.length <= 1) return ofChannel[0] ?? null;
  return (
    (await roomOfRecord(ofChannel, hint)) ??
    (await roomOfTechnicalThread(ofChannel, hint)) ??
    (hint.anyRoom ? (ofChannel[0] ?? null) : null)
  );
}
