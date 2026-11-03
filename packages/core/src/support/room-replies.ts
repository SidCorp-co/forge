// What a member's stored room message owes lessons (REQ-50 BC-1, room source; ISS-867): where it
// follows the bot's answer in its thread, it is told on the outbox in the transaction that stored it,
// through the same reply rule a project chat's turn uses.

import { noteRoomReplies } from '../assistant/index.js';
import { readMessagesInRange, type StoredConversationMessage } from '../conversations/index.js';
import type { TxOnly } from '../db/client.js';
import type { RoomRow } from './store.js';

/** How far back a reply looks past Forge's own notes for the line it follows. */
const SPOKEN_LOOKBACK = 20;

export async function noteRoomMessage(
  tx: TxOnly,
  room: RoomRow,
  conversationId: string,
  written: readonly StoredConversationMessage[],
): Promise<void> {
  await noteRoomReplies(tx, {
    projectId: room.projectId,
    conversationId,
    room: { id: room.id, rid: room.rid },
    before: await spokenBefore(tx, conversationId, written[0]?.seq),
    written,
  });
}

/** The last message said in the thread before `seq`: a `system` note is Forge's, never said there. */
async function spokenBefore(tx: TxOnly, conversationId: string, seq: number | undefined) {
  if (!seq) return undefined;
  const earlier = await readMessagesInRange(
    conversationId,
    { firstSeq: 0, lastSeq: seq - 1, limit: SPOKEN_LOOKBACK },
    tx,
  );
  return earlier.filter((message) => message.role !== 'system').at(-1);
}
