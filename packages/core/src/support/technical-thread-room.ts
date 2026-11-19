// Where a room agent's reads find what its owner wrote in its technical channel (ISS-1359). Since
// ISS-1271 every ask of a project's owner is raised in that project's thread of the operations room
// the organization shares, and his reply, pictures included, is recorded on that shared room's row,
// not on the asking agent's. A read of a thread or a message falls back there, to that project's own
// thread alone; another project's thread or the shared room's top level stays out of reach.

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
