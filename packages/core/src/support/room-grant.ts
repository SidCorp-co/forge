// What a room's agent account holds on its room's project (ISS-1394): `boxes.drive` alone, so a look
// (`look-act.ts`) opens, acts on and closes a box there. The account holds no role, so it reads and
// writes nothing else, and on any other project it holds nothing; the box doors still declare
// `project.write`, so only the look's own guards (`look-act.ts:stepRefusal`) drive a box as it.

import type { ProjectPermission } from '@forge/contracts/permissions';
import { roomsOfPrincipal } from './store.js';

export const ROOM_ACCOUNT_GRANT: readonly ProjectPermission[] = ['boxes.drive'];

/** The grant a room's account holds on `projectId`: its room's, or none. */
export async function roomAccountGrant(
  userId: string,
  projectId: string,
): Promise<readonly ProjectPermission[]> {
  const rooms = await roomsOfPrincipal(userId);
  return rooms.some((r) => r.projectId === projectId) ? ROOM_ACCOUNT_GRANT : [];
}
