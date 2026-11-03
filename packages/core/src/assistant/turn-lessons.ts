import type { StoredConversationMessage } from '../conversations/index.js';
import { db, type Tx } from '../db/client.js';
import { recordAppliedFromText } from '../lessons/index.js';
import { emitEvent } from '../outbox/index.js';

/**
 * What a stored turn owes lessons (REQ-50), in a project chat and in a bound room's thread alike:
 * each person's message that follows an answered assistant message is told on the outbox, where the
 * lessons module reads it for a correction (`chat.replied`, `room.replied`); and each answered
 * assistant message's `Lessons applied:` line is kept against that message.
 */

interface Reply {
  assistantMessageId: string;
  personMessageId: string;
}

/**
 * An assistant message the agent said: not a silence, and not a line core wrote in the agent's
 * place (a room's limit or last-resort line), whose reply corrects core rather than the agent.
 */
const answered = (m: StoredConversationMessage | undefined): m is StoredConversationMessage =>
  m?.role === 'assistant' &&
  m.silenceReason === null &&
  (m.deliveryProof as { door?: unknown } | null)?.door !== 'code-authored';

/** Each message of `written` a person said right after an answered assistant message. */
export function repliesOf(
  before: StoredConversationMessage | undefined,
  written: readonly StoredConversationMessage[],
  isPerson: (m: StoredConversationMessage) => boolean,
): Reply[] {
  const replies: Reply[] = [];
  let previous = before;
  for (const message of written) {
    if (message.role === 'user' && isPerson(message) && answered(previous)) {
      replies.push({ assistantMessageId: previous.id, personMessageId: message.id });
    }
    previous = message;
  }
  return replies;
}

/** Each answered assistant message's `Lessons applied:` line, kept against that message. */
export async function noteAppliedLessons(
  projectId: string,
  written: readonly StoredConversationMessage[],
): Promise<void> {
  for (const message of written) {
    if (!answered(message)) continue;
    await recordAppliedFromText({
      projectId,
      text: message.content,
      output: { kind: 'chat_message', ref: message.id },
      agentUserId: message.authorUserId,
    });
  }
}

/** A project chat's stored turn: its replies by a Forge user, and its applied lessons. */
export async function noteTurnLessons(
  projectId: string,
  conversationId: string,
  before: StoredConversationMessage | undefined,
  written: readonly StoredConversationMessage[],
): Promise<void> {
  const replies = repliesOf(before, written, (m) => m.authorUserId !== null);
  if (replies.length > 0) {
    await db.transaction(async (tx) => {
      for (const reply of replies) {
        await emitEvent(tx, 'chat.replied', { projectId, conversationId, ...reply });
      }
    });
  }
  await noteAppliedLessons(projectId, written);
}

/**
 * A member's message stored on a room thread's conversation, in the transaction that stored it: told
 * when it follows the bot's answer. Its writer is a chat account (`authorKey`), a Forge user or not;
 * the lessons module resolves which. The room is the one the message's route resolved, so the
 * project is the room's, never guessed.
 */
export async function noteRoomReplies(
  tx: Tx,
  p: {
    projectId: string;
    conversationId: string;
    room: { id: string; rid: string };
    before: StoredConversationMessage | undefined;
    written: readonly StoredConversationMessage[];
  },
): Promise<void> {
  for (const reply of repliesOf(p.before, p.written, (m) => m.authorKey !== null)) {
    await emitEvent(tx, 'room.replied', {
      projectId: p.projectId,
      conversationId: p.conversationId,
      room: p.room,
      ...reply,
    });
  }
}
