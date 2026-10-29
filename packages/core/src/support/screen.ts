// The screen every line the session writes passes before it is posted (REQ-75): `support-reply` for
// readers who hold no role, where developer detail is refused, and `operations-reply` for the team
// a room was bound for. A refused line is recorded and nothing is posted.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { screened } from '../conversations/index.js';
import { refusalsOf } from '../messaging/contract.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type SessionDoor = 'support-reply' | 'operations-reply';

export async function screenForThread(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  door: SessionDoor,
  tool: string,
): Promise<Outcome<{ text: string; proof: ProvenMessage }>> {
  const verdict = await screenReplyAtDoor(door, {
    projectId: room.projectId,
    segments: [text],
    toolCalls: [],
    progress: null,
  });
  const admitted = screened(text, door, verdict);
  if (admitted?.proof) return { ok: true, value: { text, proof: admitted.proof } };
  const why = refusalsOf(verdict).map(
    (r) => `${r.rule}: ${r.why}${r.quote ? ` ("${r.quote}")` : ''} — ${r.shape}`,
  );
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'refused',
    actorKind: 'session',
    tool,
    input: { text, door },
    output: { screen: why },
  });
  return no(
    'SUPPORT_REPLY_REFUSED',
    '/text',
    `nothing was posted: ${why.join('; ') || 'the screen refused the reply'}. Rewrite it and reply again.`,
  );
}
