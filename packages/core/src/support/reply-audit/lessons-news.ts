// The lessons a room's agent works under (REQ-50 BC-3, ISS-1250): a room's line is a chat reply, so
// its turn carries the map of the project's lessons about chat replies and the whole project, the same
// map every agent's prompt carries. A failed after-send verdict is a room correction; once the
// steward's pass makes a lesson of it, the room's next turn carries it, re-told only when it changed.

import { lessonsMapFor, restLessonDoors } from '../../lessons/index.js';

/** What each room's session was last told of its lessons, so a warm turn hears only a change. */
const toldLessons = new Map<string, string>();

/**
 * The lessons map for this room's turn, or null: always on a cold turn that has one, and on a warm
 * turn only when it changed since the room was last told.
 */
export async function roomLessonsNews(
  room: { id: string; projectId: string },
  cold: boolean,
): Promise<string | null> {
  const map = await lessonsMapFor(
    room.projectId,
    { produces: ['chat'], area: 'any', ...restLessonDoors(room.projectId) },
    2,
  );
  if (!map) return null;
  if (!cold && toldLessons.get(room.id) === map) return null;
  toldLessons.set(room.id, map);
  return map;
}
