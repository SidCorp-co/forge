// A room agent reacts to a message of its own thread (ISS-1475; owner 2026-11-26): the acknowledgement
// that replaces a line saying "I am checking". Core reacts with the received emoji on arrival
// (`inbound.ts`); this is the agent's own act, for a message a member wrote in a thread of its group
// (or its project's technical thread). The emoji is one of a short set the request schema holds, a
// message outside the thread is refused by name, and a repeat of the same reaction on the same message
// is a no-op. Core posts no text and composes nothing: the act is taught by its card and the guide.

import type { SupportReactRequest } from '@forge/contracts/support-react';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { reactToMessage } from '../integrations/rocketchat/index.js';
import { memberMessage } from './channel-store.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { roomHoldingThread } from './technical-thread-room.js';
import { roomAuth } from './thread.js';

export type ReactActInput = { action: 'react' } & SupportReactRequest;

/** The `tool` the reaction is kept under on the room's record. */
export const REACT_TOOL = 'react';

export async function reactAct(
  room: RoomRow,
  input: ReactActInput,
): Promise<Outcome<{ reacted: true; already: boolean }>> {
  const at = await roomHoldingThread(room, input.thread);
  const conversationId = await knownThread(at, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const said = await memberMessage(at.id, input.message);
  if (!said || said.thread !== input.thread) {
    return no(
      'SUPPORT_REACT_MESSAGE_UNKNOWN',
      '/message',
      `${input.message} is no member's message in thread ${input.thread}; react only to one as it carries \`message\` in what you were handed`,
    );
  }
  const earlier = await db
    .select({ output: supportActions.output })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, at.id),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.tool, REACT_TOOL),
        eq(supportActions.externalId, input.message),
      ),
    );
  if (earlier.some((r) => (r.output as { emoji?: string } | null)?.emoji === input.emoji)) {
    return { ok: true, value: { reacted: true, already: true } };
  }
  const { auth } = await roomAuth(at);
  const ok = await reactToMessage(auth, input.message, input.emoji, true);
  if (!ok) {
    return no(
      'SUPPORT_REACT_UNPOSTED',
      '/emoji',
      `the chat server did not take the ${input.emoji} reaction on ${input.message}; nothing was set`,
    );
  }
  await insertAction({
    roomId: at.id,
    projectId: at.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: REACT_TOOL,
    output: { emoji: input.emoji },
    externalId: input.message,
  });
  return { ok: true, value: { reacted: true, already: false } };
}
