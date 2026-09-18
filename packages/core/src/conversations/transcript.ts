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
  // cm:guard handed in rather than left to the column default, so the frames a browser drew the turn
  // from and the row it settles as share ONE identity and a client reduces them to a single turn.
  // `store.ts`'s `id?` carries the same rule and the measurement behind it (ISS-1078, ISS-1029 F1).
  messageId?: string | undefined;
  /**
   * The ordered blocks of the turn this reply ended, where the caller accumulated them.
   */
  // cm:guard what a caller passes here must already be the blocks of the text in `text` and never a
  // refused draft's — `conversation-progress.ts:blocksForRecord` is what decides that, and it is
  // named here because this row is the boundary the draft must not cross (ISS-1078).
  blocks?: readonly ContentBlock[] | null | undefined;
  receipt: DeliveryReceipt;
  /**
   * The stable key this delivery answers, where the caller has one.
   */
  // cm:guard stored INSIDE the proof rather than beside it, because the proof is what a reader trusts: a key recorded on a row whose delivery failed would tell the next attempt the room already has an answer it never saw (ISS-1004 rule 2).
  deliveryKey?: string | undefined;
  /**
   * Which decision this delivery WAS, where it was not an ordinary answer.
   */
  // cm:guard it travels with the proof because the proof is what a later claimant reads: a core that delivered an authority refusal and died before closing its window left the next one able to see that something was sent, and nothing to say what — so it wrote `answered` over a room that had been refused (ISS-1004 rule 4).
  decision?: string | undefined;
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
      ...(reply.messageId ? { id: reply.messageId } : {}),
      ...(reply.blocks && reply.blocks.length > 0 ? { blocks: reply.blocks } : {}),
      authorUserId: await handleForProject(reply.conversationId, reply.projectId),
      // cm:guard the transport's id for the REPLY goes on the row as `externalId`, and not only inside the proof: a person who later quotes or replies to this message names it by that id, and the address check reads it back through an index the proof's jsonb cannot carry. Rows written before ISS-1087 are backfilled from the proof by migration 0272.
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
// cm:guard written HERE and nowhere else for a declined turn, and never for an empty or errored one: `external-chat.ts` already files those with their own reason, and two writers would give one silence two rows saying different things (ISS-1004 rule 4).
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
