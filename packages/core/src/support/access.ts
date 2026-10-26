// Who may act for a support group: only its own session, holding the token core handed its current
// turn. The room's agent account is a member of nothing, so every other route refuses it; these are
// the only ones that admit it, and they admit nothing else (REQ-75, the identity decision in
// `docs/proposals/rocketchat-support-session.md`).

import { chatDoorOfToken } from '../agent-sessions/index.js';
import { refuse } from './refusals.js';
import { type RoomRow, roomOfPrincipal } from './store.js';

export async function sessionCaller(caller: {
  userId: string;
  tokenId: string | null | undefined;
  projectId: string;
}): Promise<RoomRow> {
  const room = await roomOfPrincipal(caller.userId);
  const door = caller.tokenId ? await chatDoorOfToken(caller.tokenId) : null;
  const sameSession = door?.door === 'box-session' && door.sessionId === room?.sessionId;
  if (!room || room.projectId !== caller.projectId || !sameSession) {
    throw refuse(
      'SUPPORT_NOT_THE_ROOM_SESSION',
      "only a support group's own session, under the token its current turn was handed, acts here",
    );
  }
  return room;
}
