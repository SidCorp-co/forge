// An act refused for an ability the room's grant does not hold is recorded once on the thread it was
// asked in, and nothing is posted: the session reads the refusal and says it in its own words
// (ISS-845, REQ-75 BC-28). Split from `acts.ts`, which calls it after every act.

import { insertAction, type RoomRow } from './store.js';

/** An ability refusal, recorded once per act on the thread it was asked in; nothing is posted. */
export async function recordNotGranted(
  room: RoomRow,
  thread: string,
  action: string,
  out: { ok: false; refusals: { code: string; detail: string }[] },
): Promise<void> {
  const refusal = out.refusals.find((r) => r.code === 'SUPPORT_ABILITY_NOT_GRANTED');
  if (!refusal) return;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: 'refused',
    actorKind: 'core',
    tool: action,
    output: { code: refusal.code, detail: refusal.detail, posted: false },
  });
}
