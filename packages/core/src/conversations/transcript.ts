/**
 * What the transcript keeps of a reply a venue was actually shown.
 *
 * One door, because there is one thing to record: the sentence that went out,
 * under the project's own handle, with the receipt its transport returned.
 */

import type { ConversationAdapter } from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import { handleForProject } from './participants.js';
import type { DeliveryReceipt } from './ports.js';
import { appendMessage, findConversation } from './store.js';

export interface DeliveredReply {
  conversationId: string;
  projectId: string;
  /** The exact text the venue was shown. */
  text: string;
  receipt: DeliveryReceipt;
}

/**
 * Append what the venue was shown, as the assistant's own row.
 */
// cm:guard the row holds the sentence that WENT OUT and not the one the model first wrote: a screened path replaces a failing answer with a retry or a fixed fallback, and a transcript holding the rejected text is a record of a conversation nobody had (ISS-1001 criterion 15).
// cm:guard the row is BY the project's handle and never by nobody — an answer is the assistant speaking, whichever path composed it.
// cm:guard failures here are logged and never thrown: the venue HAS the message by the time this runs, and turning a delivered answer into an error is a lie in the other direction.
export async function recordDeliveredReply(reply: DeliveredReply): Promise<void> {
  try {
    await appendMessage({
      conversationId: reply.conversationId,
      role: 'assistant',
      content: reply.text,
      authorUserId: await handleForProject(reply.conversationId, reply.projectId),
      deliveryProof: reply.receipt,
    });
  } catch (err) {
    logger.warn(
      { err, conversationId: reply.conversationId },
      'conversations: delivered, but the transcript could not record it',
    );
  }
}

/**
 * The same, for a caller holding a venue's external id rather than a conversation.
 */
// cm:guard a venue with no conversation row records NOTHING and opens none: this door is for an answer arriving late to a room that was already talking, and opening a conversation here would file a transcript whose only row is an answer to a question it does not hold.
export async function recordDeliveredReplyToVenue(args: {
  adapter: ConversationAdapter;
  externalId: string;
  projectId: string;
  text: string;
  receipt: DeliveryReceipt;
}): Promise<void> {
  try {
    const conversation = await findConversation(args.adapter, args.externalId);
    if (!conversation) return;
    await recordDeliveredReply({
      conversationId: conversation.id,
      projectId: args.projectId,
      text: args.text,
      receipt: args.receipt,
    });
  } catch (err) {
    logger.warn(
      { err, adapter: args.adapter, externalId: args.externalId },
      'conversations: delivered, but the transcript could not be reached',
    );
  }
}
