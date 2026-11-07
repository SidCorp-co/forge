// Who a post toward a room's users may name beyond the thread's latest writer and the members the
// channel record lists (ISS-1097): the person who started the thread and anyone the room itself
// holds as a member. Both are read from the room, since core's own record names only the people it
// heard: a thread the binding never answered, one a hand-run assistant answered, has no writer
// core recorded, and a member who never wrote where core saw it is on no list core keeps.

import { fetchMessage, fetchRoomMembers } from '../integrations/rocketchat/index.js';
import { isCoreThread } from './rules.js';
import type { RoomRow } from './store.js';
import { roomAuth, TOP_LEVEL } from './thread.js';
import { threadStarterHeard } from './thread-messages.js';

/** The username that started `thread` in `room`: core's record where it heard it, else the room's. */
export async function threadStarter(room: RoomRow, thread: string): Promise<string | null> {
  if (thread === TOP_LEVEL || isCoreThread(thread)) return null;
  const heard = await threadStarterHeard(room.id, thread);
  if (heard) return heard;
  const { auth } = await roomAuth(room);
  const root = await fetchMessage(auth, thread);
  if (!root || root.rid !== room.rid || root.tmid || root.isSystem) return null;
  return root.username || null;
}

/**
 * Whether `name` (a mention, any case) is the person who started `thread` or a member the room
 * lists. A room the chat server does not list reads as holding nobody, so a stranger stays refused.
 */
export async function inRoomReach(room: RoomRow, thread: string, name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  if ((await threadStarter(room, thread))?.toLowerCase() === lower) return true;
  const { auth } = await roomAuth(room);
  const members = (await fetchRoomMembers(auth, room.rid)) ?? [];
  return members.some(
    (m) => m.username.toLowerCase() === lower || m.userId.toLowerCase() === lower,
  );
}
