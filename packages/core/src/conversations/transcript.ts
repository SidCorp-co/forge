/**
 * What the transcript keeps of a reply a venue was actually shown.
 *
 * One door, because there is one thing to record: the sentence that went out,
 * under the project's own handle, with the receipt its transport returned.
 */

import type { ConversationAdapter } from '../db/schema-conversations.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import { handleForProject } from './participants.js';
import type { DeliveryReceipt } from './ports.js';
import { appendMessage, findConversation } from './store.js';

export interface DeliveredReply {
  conversationId: string;
  projectId: string;
  /** The exact text the venue was shown. */
  text: string;
  /**
   * The id the row takes, where the caller streamed this turn under one.
   */
  messageId?: string | undefined;
  /**
   * The ordered blocks of the turn this reply ended, where the caller accumulated them.
   */
  blocks?: readonly ContentBlock[] | null | undefined;
  receipt: DeliveryReceipt;
  /**
   * The stable key this delivery answers, where the caller has one.
   */
  deliveryKey?: string | undefined;
  /**
   * Which decision this delivery WAS, where it was not an ordinary answer.
   */
  decision?: string | undefined;
}

/**
 * Append what the venue was shown, as the assistant's own row.
 */
export async function recordDeliveredReply(reply: DeliveredReply): Promise<void> {
  try {
    await appendMessage({
      conversationId: reply.conversationId,
      role: 'assistant',
      content: reply.text,
      ...(reply.messageId ? { id: reply.messageId } : {}),
      ...(reply.blocks && reply.blocks.length > 0 ? { blocks: reply.blocks } : {}),
      authorUserId: await handleForProject(reply.conversationId, reply.projectId),
      externalId: reply.receipt.messageId,
      deliveryProof: reply.deliveryKey
        ? {
            ...reply.receipt,
            deliveryKey: reply.deliveryKey,
            ...(reply.decision ? { decision: reply.decision } : {}),
          }
        : reply.receipt,
    });
  } catch (err) {
    logger.warn(
      { err, conversationId: reply.conversationId },
      'conversations: delivered, but the transcript could not record it',
    );
  }
}

/**
 * A turn that chose to say nothing, recorded as the reason rather than as nothing.
 */
export async function recordSilence(args: {
  conversationId: string;
  projectId: string;
  reason: string;
}): Promise<void> {
  try {
    await appendMessage({
      conversationId: args.conversationId,
      role: 'assistant',
      content: '',
      authorUserId: await handleForProject(args.conversationId, args.projectId),
      silenceReason: args.reason,
    });
  } catch (err) {
    logger.warn(
      { err, conversationId: args.conversationId },
      'conversations: a turn declined and the silence could not be recorded',
    );
  }
}

/**
 * The same, for a caller holding a venue's external id rather than a conversation.
 */
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
