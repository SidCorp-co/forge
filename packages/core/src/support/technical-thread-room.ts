// Which rooms a room agent may cite a message of (ISS-1359, ISS-1347): its own group, and its
// project's technical channel. Since ISS-1271 every ask of a project's owner is raised in that
// project's thread of the operations room the organization shares, and his reply, pictures included,
// is recorded on that shared room's row, not on the asking agent's. A read of a thread or a message,
// and an act citing his message as his word (`answer_question`, `release_decision`), falls back
// there, to that project's own thread alone; another project's thread or the shared room's top level
// stays out of reach. A reply in a direct message that is the channel is copied into the asking room
// (`owner-answer.ts`), so its own record holds it.

import { memberMessage } from './channel-store.js';
import { sharedRoomOf } from './project-thread.js';
import type { RoomRow } from './store.js';
import { projectThreadOfRoom } from './thread.js';

/** The project's own thread in the shared operations room, or null where none is bound and recorded,
 *  or where the agent's room is that shared room itself (its own record already holds the thread). */
export async function technicalThreadOf(
  room: RoomRow,
): Promise<{ shared: RoomRow; thread: string } | null> {
  const shared = await sharedRoomOf(room.projectId);
  if (!shared || shared.id === room.id) return null;
  const thread = await projectThreadOfRoom(shared, room.projectId);
  return thread ? { shared, thread } : null;
}

/** The room whose record a read of `thread` goes to: the shared operations room where `thread` is
 *  the agent's project's own technical thread there, else the agent's own room. */
export async function roomHoldingThread(room: RoomRow, thread: string): Promise<RoomRow> {
  const technical = await technicalThreadOf(room);
  return technical?.thread === thread ? technical.shared : room;
}

/** Where a cited member message is: the room whose record holds it, and whether it is the technical
 *  channel's; or, refused, whether it sits in the shared room outside this project's own thread. */
export type CitableAt =
  | { ok: true; at: RoomRow; technical: boolean }
  | { ok: false; elsewhere: boolean };

/**
 * The one rule of which rooms a room agent may cite member message `message` from: its own room, or
 * its project's own thread of the shared operations room. Every door reading or acting on a cited
 * message asks it, and reads the message from the room it names.
 */
export async function citableRoomOf(room: RoomRow, message: string): Promise<CitableAt> {
  if (await memberMessage(room.id, message)) return { ok: true, at: room, technical: false };
  const technical = await technicalThreadOf(room);
  const there = technical ? await memberMessage(technical.shared.id, message) : null;
  if (!technical || !there) return { ok: false, elsewhere: false };
  return there.thread === technical.thread
    ? { ok: true, at: technical.shared, technical: true }
    : { ok: false, elsewhere: true };
}
