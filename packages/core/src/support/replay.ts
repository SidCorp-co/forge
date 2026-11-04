// What a room missed while nothing answered it (ISS-933): a person's message written while the room
// had no placement (its binding switched off, or another binding holding it) reached no session and
// was recorded nowhere. When a room is placed, the messages people wrote in its group since Forge last
// recorded one there, within REPLAY_WINDOW_MS, are handed to it through the live inbound path, each
// once, as ordinary messages. Whether the session answers is its own judgement, by its persona (owner
// ruling, forge decision 1592b79d); core picks nothing out but its own bot, apps and system lines.

import { db } from '../db/client.js';
import {
  buildRoutes,
  decideSkip,
  fetchRoomMessagesSince,
  resolveRoomShape,
} from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { handleSupportMessage } from './inbound.js';
import { hasOperation, lastMemberMessageOn, recordedMessageIdsOn } from './replay-store.js';
import { roomIsBound } from './rooms.js';
import { insertAction, type RoomRow, roomsHoldingSessions } from './store.js';
import { roomAuth } from './thread.js';

/**
 * How far back a placed room reads what it missed: one day. It is the project's own review cadence
 * (the daily review reads the day before), so a question a day old has been seen there; one older
 * is stale for a new answer and would flood a session placed on a long-silent group.
 */
export const REPLAY_WINDOW_MS = 24 * 60 * 60_000;

/** At most this many recent messages are read: the window, bounded again by what one turn can carry. */
export const REPLAY_COUNT = 100;

/** The marker a room's one replay leaves, so it is never read twice. */
const REPLAY_TOOL = 'replay_missed';

/**
 * Hand a placed room the messages people wrote in its group since Forge last recorded one there,
 * within REPLAY_WINDOW_MS; once per room. The count handed on comes back.
 */
export async function replayMissed(room: RoomRow, now = new Date()): Promise<number> {
  if (await hasOperation(room.id, REPLAY_TOOL)) return 0;
  const { auth } = await roomAuth(room);
  const windowStart = new Date(now.getTime() - REPLAY_WINDOW_MS);
  const last = await lastMemberMessageOn(room.rid);
  const since = last && last > windowStart ? last : windowStart;
  const read = await fetchRoomMessagesSince(auth, room.rid, {
    count: REPLAY_COUNT,
    oldest: since.toISOString(),
  });
  // a group the bot cannot read now is tried again on the next sweep, the marker not yet taken
  if (!read) return 0;
  // the marker is taken before anything is handed on, under the room's lock: one replay per room
  const claimed = await db.transaction(async (tx) => {
    await lockXact(tx, 'supportRoom', `${room.id}:replay`);
    if (await hasOperation(room.id, REPLAY_TOOL, tx)) return false;
    await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId: null,
        thread: REPLAY_TOOL,
        kind: 'operation',
        actorKind: 'core',
        tool: REPLAY_TOOL,
        input: { since: since.toISOString(), read: read.length },
      },
      tx,
    );
    return true;
  });
  if (!claimed) return 0;
  const person = read.filter((m) => {
    if (m.isBot) return false;
    if (m.ts && new Date(m.ts) <= since) return false;
    // an edit is still the person's message; their own bot, a system line or an empty one is not
    const skip = decideSkip(m, auth.userId);
    return skip === null || skip === 'edited';
  });
  const recorded = await recordedMessageIdsOn(
    room.rid,
    person.map((m) => m.id),
  );
  const missed = person.filter((m) => !recorded.has(m.id));
  if (missed.length === 0) return 0;
  const routed = (await buildRoutes(room.connectionId)).get(room.rid);
  const route = routed
    ? [routed, ...routed.shared].find((r) => r.bindingId === room.bindingId)
    : undefined;
  const shape = await resolveRoomShape(auth, room.rid);
  if (!route || !shape) return 0;
  for (const m of missed) {
    await handleSupportMessage({
      connectionId: room.connectionId,
      ac: { botUserId: auth.userId },
      route,
      m: { ...m, isEdited: false },
      shape,
    });
  }
  logger.info(
    { roomId: room.id, rid: room.rid, handed: missed.length, since: since.toISOString() },
    'support: a placed room was handed the messages it missed',
  );
  return missed.length;
}

/** Every placed room not yet replayed reads what it missed (the sweep and a binding change). */
export async function replayPlacedRooms(projectId?: string): Promise<void> {
  for (const room of await roomsHoldingSessions(projectId)) {
    if (!(await roomIsBound(room))) continue;
    await replayMissed(room).catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: replaying what a room missed failed'),
    );
  }
}
