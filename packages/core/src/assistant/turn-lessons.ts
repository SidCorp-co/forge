import type { StoredConversationMessage } from '../conversations/index.js';
import { db } from '../db/client.js';
import { recordAppliedFromText } from '../lessons/index.js';
import { emitEvent } from '../outbox/index.js';

/**
 * What a stored turn owes lessons (REQ-50): each person's reply that follows an assistant message is
 * told on the outbox (`chat.replied`), where the lessons module reads it for a correction; and each
 * assistant message's `Lessons applied:` line is kept against that message.
 */
export async function noteTurnLessons(
  projectId: string,
  conversationId: string,
  before: StoredConversationMessage | undefined,
  written: readonly StoredConversationMessage[],
): Promise<void> {
  const replies: Array<{ assistantMessageId: string; personMessageId: string }> = [];
  let previous = before;
  for (const message of written) {
    if (
      message.role === 'user' &&
      message.authorUserId &&
      previous?.role === 'assistant' &&
      previous.silenceReason === null
    ) {
      replies.push({ assistantMessageId: previous.id, personMessageId: message.id });
    }
    previous = message;
  }
  if (replies.length > 0) {
    await db.transaction(async (tx) => {
      for (const reply of replies) {
        await emitEvent(tx, 'chat.replied', { projectId, conversationId, ...reply });
      }
    });
  }
  for (const message of written) {
    if (message.role !== 'assistant' || message.silenceReason !== null) continue;
    await recordAppliedFromText({
      projectId,
      text: message.content,
      output: { kind: 'chat_message', ref: message.id },
      agentUserId: message.authorUserId,
    });
  }
}
