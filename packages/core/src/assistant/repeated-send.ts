import { and, eq, gte, lte } from 'drizzle-orm';
import {
  effectiveConversationMode,
  findMessageByClientToken,
  getConversation,
} from '../conversations/store.js';
import { db } from '../db/client.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { isUniqueViolation, pgConstraintName } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_ACCEPTED_EVENT,
} from './conversation-adapter.js';
import type { WebSendResult } from './conversation-send.js';

/** The index that holds one message per sender and client token in a room (migration 0389). */
const CLIENT_TOKEN_INDEX = 'conversation_messages_client_token_uq';

/** Whether a write failed because another send under the same token was written first. */
export function lostTokenRace(err: unknown): boolean {
  return isUniqueViolation(err) && pgConstraintName(err) === CLIENT_TOKEN_INDEX;
}

/**
 * A send repeating a client token its sender already used in this room is answered with the first
 * message, as that send was answered, and writes nothing (ISS-1236): the web composer's Retry resends
 * under the same token, and a send that was written but whose answer was lost would otherwise be
 * written twice. A route asks before its refusals and again before refusing a room as settled, since
 * the first send may land between the two reads. `null` where the token is new or absent.
 */
export async function repeatedWebSend(args: {
  conversationId: string;
  userId: string;
  clientToken: string | undefined;
}): Promise<WebSendResult | null> {
  if (!args.clientToken) return null;
  const first = await findMessageByClientToken({
    conversationId: args.conversationId,
    authorUserId: args.userId,
    clientToken: args.clientToken,
  });
  if (!first) return null;
  const [window] = await db
    .select({ id: conversationWindows.id })
    .from(conversationWindows)
    .where(
      and(
        eq(conversationWindows.conversationId, args.conversationId),
        lte(conversationWindows.firstSeq, first.seq),
        gte(conversationWindows.lastSeq, first.seq),
      ),
    )
    .limit(1);
  if (!window) {
    throw new Error(
      `web conversations: message ${first.id} (seq ${first.seq}) is in no window of conversation ${args.conversationId}`,
    );
  }
  await publishToConversationReaders(args.conversationId, {
    event: WEB_CONVERSATION_ACCEPTED_EVENT,
    data: {
      conversationId: args.conversationId,
      messageId: first.id,
      seq: first.seq,
      clientToken: args.clientToken,
    },
  }).catch((err: unknown) =>
    logger.warn(
      { err, conversationId: args.conversationId },
      'web conversations: the accepted event of a repeated send was not published',
    ),
  );
  const answered: WebSendResult = {
    conversationId: args.conversationId,
    windowId: window.id,
    seq: first.seq,
    decision: null,
    mode: effectiveConversationMode((await getConversation(args.conversationId)) ?? { mode: null }),
  };
  repeats.add(answered);
  return answered;
}

const repeats = new WeakSet<WebSendResult>();

/** Whether a send's result answers an earlier message rather than one this send wrote. */
export const isRepeat = (sent: WebSendResult): boolean => repeats.has(sent);
