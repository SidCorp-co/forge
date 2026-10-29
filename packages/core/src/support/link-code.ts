// A member's `link <code>` in a bound room (REQ-75 r5): the chat account that wrote it linked to the
// Forge user who minted the code, so the room's acts that run as the asker (`deliver`, an
// operations move) can name them. Answered by core in the thread and recorded; the session never
// sees the line, and nothing else happens.

import { redeemSpeakerLinkCode } from '../assistant/index.js';
import { insertAction, type RoomRow } from './store.js';
import { postInThread } from './thread.js';

export async function answerLinkCode(
  room: RoomRow,
  namespace: string,
  thread: string,
  author: { key: string; label: string | null },
  code: string,
): Promise<void> {
  const who = author.label ? `@${author.label}` : `account ${author.key}`;
  const out = await redeemSpeakerLinkCode({
    code,
    projectId: room.projectId,
    source: 'rocketchat',
    namespace,
    externalId: author.key,
    label: author.label,
  });
  const text = out.ok
    ? out.already
      ? `${who} is already linked to the Forge account that made this code. Nothing changed.`
      : `${who} is now linked to the Forge account that made this code. What this room does as you is done as that account, within what it may do.`
    : out.why === 'linked-to-another'
      ? `${who} is already linked to another Forge account, so nothing was linked. Unlink it in Forge first.`
      : 'No link code waits under that code for this project: it is spent, lapsed or of another project. Make a new one in Forge. Nothing was linked.';
  const posted = await postInThread({ room, thread, text });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'member',
    actorKey: author.key,
    actorLabel: author.label,
    tool: 'link',
    output: out.ok ? { linked: true, already: out.already } : { linked: false, why: out.why },
    externalId: posted.messageId,
  });
}
