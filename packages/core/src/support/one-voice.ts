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
// A post naming the told result it follows up on (ISS-872 `followsUp`) never erases that message:
// where it is still the thread's latest answer the post adds a line after it, and where the agent
// answered since, the post replaces that newer answer as any other does (ISS-1406, Forge-Feedback
// 2026-11-22: a thread told a result made every master's post a follow-up, and each stood beside
// the agent's answer of ten seconds before, contradicting it).
// A group several bindings hold (ISS-933: one answers, the others speak when named) keeps a line of
// the thread on each binding's room, and each project's master posts through its own; the answer is
// read across all of them, so a master replaces the room agent's reply or another master's post
// whichever room recorded it (ISS-1406: before, a mention-only project's master posting in a thread
// the group's own agent answered stood beside that answer).
// Images still follow as their own messages: the chat server attaches no file to an edited post.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { SUPPORT_MASTER_POST_EDIT_WINDOW_MS } from '@forge/contracts/support';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { replaceSentContent } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { editProvenReply } from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import { type RoomRow, roomsOnRid } from './store.js';
import { postInThread, roomAuth } from './thread.js';

/** The tool a master's post is recorded under (`master-post.ts:TOOL`). */
const MASTER_POST = 'master_post';

/** The bot's answer a master's post replaces, and the room whose record holds it. */
export interface Answer {
  messageId: string;
  by: 'agent' | 'master';
  conversationId: string | null;
  room: RoomRow;
}

/**
 * The bot's post answering the thread's current request, which a master's post replaces: the latest
 * post in the thread, on the record of any binding holding the group, when nobody has written there
 * since and it is within the edit window; null where a member wrote last, the bot has not answered,
 * or the answer is too old to edit.
 */
/** Every room recording the group's threads: the room's own, and each other binding's of its group. */
async function holdersOf(room: RoomRow): Promise<RoomRow[]> {
  const holders = await roomsOnRid(room.rid);
  return holders.some((r) => r.id === room.id) ? holders : [room, ...holders];
}

/**
 * Whether the bot answered in `thread` at or after `since`, on any binding's record of the group:
 * the room agent's reply or a master's post (ISS-1406: a thread so answered is told no offline line).
 */
export async function answeredSince(room: RoomRow, thread: string, since: Date): Promise<boolean> {
  const rooms = await holdersOf(room);
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        inArray(
          supportActions.roomId,
          rooms.map((r) => r.id),
        ),
        eq(supportActions.thread, thread),
        gte(supportActions.createdAt, since),
        or(
          and(eq(supportActions.kind, 'reply'), eq(supportActions.actorKind, 'session')),
          and(eq(supportActions.kind, 'routed'), eq(supportActions.tool, MASTER_POST)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function answerToReplace(room: RoomRow, thread: string): Promise<Answer | null> {
  const rooms = await holdersOf(room);
  const recent = await db
    .select({
      roomId: supportActions.roomId,
      kind: supportActions.kind,
      tool: supportActions.tool,
      actorKind: supportActions.actorKind,
      externalId: supportActions.externalId,
      conversationId: supportActions.conversationId,
      at: supportActions.createdAt,
    })
    .from(supportActions)
    .where(
      and(
        inArray(
          supportActions.roomId,
          rooms.map((r) => r.id),
        ),
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
    const holder = rooms.find((r) => r.id === row.roomId) ?? room;
    return {
      messageId: row.externalId,
      by: answer,
      conversationId: row.conversationId,
      room: holder,
    };
  }
  return null;
}

/**
 * Replace the bot's answer with the master's screened text, in the chat and in the thread's stored
 * line, so a cold replay or a lookup by message reads what the asker reads; why it could not, where
 * it could not. Edited through the bot of the room that posted it.
 */
export async function replaceAnswer(
  answer: Pick<Answer, 'messageId' | 'conversationId' | 'room'>,
  text: string,
  proof: ProvenMessage,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const room = answer.room;
  const { auth } = await roomAuth(room);
  const out = await editProvenReply(auth, room.rid, answer.messageId, text, proof);
  if (out.ok && answer.conversationId) {
    await replaceSentContent({
      conversationId: answer.conversationId,
      externalId: answer.messageId,
      content: text,
    });
  }
  return out;
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
  /** A post naming the told result it follows up on adds to it, never erasing it (ISS-872). */
  followsUp?: string | undefined;
}): Promise<Outcome<Placed>> {
  const latest = await answerToReplace(input.room, input.thread);
  const answer = latest && latest.messageId !== input.followsUp ? latest : null;
  if (!answer) {
    const posted = await postInThread(input);
    return { ok: true, value: { ...posted, replaced: null } };
  }
  // the answer's own record names the conversation its line is stored in; the thread's, where it is this room's
  const own = answer.room.id === input.room.id ? input.conversationId : null;
  const stored = { ...answer, conversationId: answer.conversationId ?? own };
  const out = await replaceAnswer(stored, input.text, input.proof);
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
