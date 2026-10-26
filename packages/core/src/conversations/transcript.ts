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
  /** The draft the reply screen withdrew before this reply went out (ISS-1229 r36). */
  withdrawnDraft?: string | undefined;
  /** Why no draft is kept: it read as a credential, so none of its text is stored (ISS-1229 r43). */
  withdrawnFor?: 'credential' | undefined;
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
      deliveryProof: {
        ...reply.receipt,
        ...(reply.deliveryKey ? { deliveryKey: reply.deliveryKey } : {}),
        ...(reply.deliveryKey && reply.decision ? { decision: reply.decision } : {}),
        ...(reply.withdrawnDraft ? { withdrawnDraft: reply.withdrawnDraft } : {}),
        ...(reply.withdrawnFor ? { withdrawnFor: reply.withdrawnFor } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      { err, conversationId: reply.conversationId },
      'conversations: delivered, but the transcript could not record it',
    );
  }
}

/**
 * A turn that chose to say nothing, recorded as the reason rather than as nothing; answers its seq.
 */
export async function recordSilence(args: {
  conversationId: string;
  projectId: string;
  reason: string;
}): Promise<number | null> {
  try {
    const stored = await appendMessage({
      conversationId: args.conversationId,
      role: 'assistant',
      content: '',
      authorUserId: await handleForProject(args.conversationId, args.projectId),
      silenceReason: args.reason,
    });
    return stored.seq;
  } catch (err) {
    logger.warn(
      { err, conversationId: args.conversationId },
      'conversations: a turn declined and the silence could not be recorded',
    );
    return null;
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
