// What a room missed while nothing answered it (ISS-933): a person's message written while the room
// had no placement (its binding switched off, or another binding holding it) reached no session and
// was recorded nowhere. When a room is placed, the messages people wrote in its group since Forge last
// recorded one there, within REPLAY_WINDOW_MS, are handed to it through the live inbound path, each
// once, as ordinary messages. Whether the session answers is its own judgement, by its persona (owner
// ruling, forge decision 1592b79d); core picks nothing out but its own bot, apps and system lines.
// Those posts of the same window travel with the messages as context notes (ISS-952): a bot answer
// written under the binding that held the group before is the session's only way to see a question
// was already answered, since a session reads the group through nothing but what it is handed.

import { db } from '../db/client.js';
import {
  buildRoutes,
  decideSkip,
  fetchRoomMessagesSince,
  type RocketChatIncomingMessage,
  resolveRoomShape,
} from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { handleSupportMessage } from './inbound.js';
import {
  hasOperation,
  lastMemberMessageOn,
  recordedInRoom,
  recordedMessageIdsOn,
} from './replay-store.js';
import { roomIsBound } from './rooms.js';
import { threadOf } from './rules.js';
import { insertAction, type RoomRow, roomsHoldingSessions } from './store.js';
import { roomAuth, threadConversationOf } from './thread.js';

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
  const { auth, namespace } = await roomAuth(room);
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
  const inWindow = (m: RocketChatIncomingMessage) => !(m.ts && new Date(m.ts) <= since);
  const person = read.filter((m) => {
    if (m.isBot || !inWindow(m)) return false;
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
  // what the bot or an app posted in the window, and this room did not post itself, goes first as
  // context, so the turn that carries the people's messages carries what was already said to them
  const posted = read.filter(
    (m) =>
      inWindow(m) &&
      (m.isBot || m.userId === auth.userId) &&
      !m.isSystem &&
      (m.text.trim().length > 0 || m.images.length > 0),
  );
  const own = await recordedInRoom(
    room.id,
    posted.map((m) => m.id),
  );
  for (const m of posted.filter((p) => !own.has(p.id))) {
    await noteEarlierPost(room, namespace, m, m.userId === auth.userId);
  }
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

/**
 * A bot's or an app's post of the replayed window, recorded as a note the session reads in the same
 * turn as the people's messages, in its own thread: context it owes no answer to (ISS-952). A note
 * is no member's message, so it counts toward no member's limit and is read for no correction.
 */
async function noteEarlierPost(
  room: RoomRow,
  namespace: string,
  m: RocketChatIncomingMessage,
  ourBot: boolean,
): Promise<void> {
  const thread = threadOf(m);
  const conversation = await threadConversationOf(room, namespace, thread);
  const who = `@${m.username ?? m.userId}`;
  const what = ourBot
    ? 'this bot, under the binding that held the group before this room'
    : 'an app or another bot';
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: conversation.id,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: `Already posted in this group${m.ts ? ` at ${m.ts}` : ''} by ${who} (${what}), while nothing here answered it. It is context for the messages handed with it: it owes no answer, and a question it already answered may need none.\n${markUntrusted(m.text, { source: 'support group, posted before this room was placed' })}`,
    },
    externalId: `replay-context:${m.id}`,
  });
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
