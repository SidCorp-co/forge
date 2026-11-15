// One voice per thread (ISS-1243 item 15, AdminHub-Support 03/11-15/11: 14 times a room agent's reply
// and a master's post landed in one thread within ten minutes, restating or contradicting each other,
// and 7 corrections stacked as new posts). The mechanism is replacement, chosen over handing the
// master's text to the room agent to re-say: a master's result is already final and screened for
// the room, the agent re-wording it is a second chance to drift from it, and a thread with no live
// session would wait on a turn. So:
// - a master's post into an asker's thread whose latest post is the bot's answer to the current
//   request (the agent's reply or the master's own earlier post, made after the asker last wrote and
//   within the edit window) replaces that post in place, and no second post stands beside it; a
//   correction is the same act, so it replaces rather than stacks;
// - a master's post counts as the thread's result, so the room agent's one-result rule (REQ-77 BC-8)
//   refuses it a second post there until the asker writes again (`thread-requests.ts`).
// Images still follow as their own messages: the chat server attaches no file to an edited post.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { SUPPORT_MASTER_POST_EDIT_WINDOW_MS } from '@forge/contracts/support';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { editProvenReply } from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';
import { postInThread, roomAuth } from './thread.js';

/** The tool a master's post is recorded under (`master-post.ts:TOOL`). */
const MASTER_POST = 'master_post';

/**
 * The bot's post answering the thread's current request, which a master's post replaces: the latest
 * post in the thread when nobody has written there since and it is within the edit window; null
 * where a member wrote last, the bot has not answered, or the answer is too old to edit.
 */
export async function answerToReplace(
  room: RoomRow,
  thread: string,
): Promise<{ messageId: string; by: 'agent' | 'master' } | null> {
  const recent = await db
    .select({
      kind: supportActions.kind,
      tool: supportActions.tool,
      actorKind: supportActions.actorKind,
      externalId: supportActions.externalId,
      at: supportActions.createdAt,
    })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, thread),
        inArray(supportActions.kind, ['message_in', 'reply', 'routed']),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(30);
  for (const row of recent) {
    if (row.kind === 'message_in') {
      if (row.actorKind === 'member') return null;
      continue;
    }
    const answer = row.kind === 'reply' ? 'agent' : row.tool === MASTER_POST ? 'master' : null;
    if (!answer || !row.externalId) continue;
    if (Date.now() - row.at.getTime() > SUPPORT_MASTER_POST_EDIT_WINDOW_MS) return null;
    return { messageId: row.externalId, by: answer };
  }
  return null;
}

/** Replace the bot's answer with the master's screened text; why it could not, where it could not. */
export async function replaceAnswer(
  room: RoomRow,
  messageId: string,
  text: string,
  proof: ProvenMessage,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const { auth } = await roomAuth(room);
  return editProvenReply(auth, room.rid, messageId, text, proof);
}

type Placed = {
  messageId: string | null;
  conversationId: string | null;
  replaced: 'agent' | 'master' | null;
};

/**
 * A master's screened post into an asker's thread, in one voice: replacing the bot's answer to the
 * current request where there is one, else posted as the thread's next line. A replacement the chat
 * server refuses is refused by name, posting nothing, so no second voice stands in its place.
 */
export async function postInOneVoice(input: {
  room: RoomRow;
  thread: string;
  conversationId: string | null;
  text: string;
  proof: ProvenMessage;
}): Promise<Outcome<Placed>> {
  const answer = await answerToReplace(input.room, input.thread);
  if (!answer) {
    const posted = await postInThread(input);
    return { ok: true, value: { ...posted, replaced: null } };
  }
  const out = await replaceAnswer(input.room, answer.messageId, input.text, input.proof);
  if (!out.ok) {
    return no(
      'SUPPORT_POST_UNCHANGED',
      '/text',
      `this thread's answer to its current request is message ${answer.messageId}, which a master's post replaces so the asker reads one voice, and the chat server did not change it (${out.why}). Nothing was posted; post again.`,
    );
  }
  return {
    ok: true,
    value: {
      messageId: answer.messageId,
      conversationId: input.conversationId,
      replaced: answer.by,
    },
  };
}
