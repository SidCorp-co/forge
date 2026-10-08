import { randomUUID } from 'node:crypto';
import type {
  ConversationAdapterPorts,
  ConversationHistoryMessage,
  ConversationVenue,
  DeliveryReceipt,
  ScreenedMessage,
} from '../conversations/index.js';
import {
  appendMessages,
  assertConversationReadable,
  type DeliveryOptions,
  findConversation,
  handleForProject,
  listParticipants,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import type { ConversationShape } from '../db/schema-conversations.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { publishEphemeral } from '../lib/ephemeral.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import type { SpeakerResolution } from './identity/speaker-link.js';

/** What the Forge UI hands the ports: the room it already read, and who is typing in it. */
export interface WebConversationFrame {
  conversation: { id: string; externalId: string; shape: ConversationShape };
  /** The project whose handle answers here — the room's binding, already authorized by the route. */
  projectId: string;
  /** The signed-in reader. */
  userId: string;
}

/**
 * The event a browser learns a reply by.
 */
export const WEB_CONVERSATION_EVENT = 'conversation.message';

/**
 * The event that says this room has settled — whatever it settled on.
 */
export const WEB_CONVERSATION_SETTLED_EVENT = 'conversation.settled';

/**
 * The event a browser draws a turn IN FLIGHT from.
 */
export const WEB_CONVERSATION_PROGRESS_EVENT = 'conversation.progress';

/**
 * The event that says a typed message is now a durable row.
 */
export const WEB_CONVERSATION_ACCEPTED_EVENT = 'conversation.accepted';

/**
 * Whose sockets may be shown this room, right now.
 */
async function readersOf(conversationId: string): Promise<string[]> {
  const out: string[] = [];
  for (const person of await listParticipants(conversationId)) {
    if (person.kind !== 'person' || !person.userId) continue;
    try {
      await assertConversationReadable(conversationId, person.userId);
      out.push(person.userId);
    } catch {}
  }
  return out;
}

/** An ephemeral frame (lib/ephemeral.ts) for every person who may currently see this room. */
export async function publishEphemeralToConversationReaders(
  conversationId: string,
  frame: { event: string; data: unknown },
): Promise<void> {
  const userIds = await readersOf(conversationId);
  if (userIds.length > 0) publishEphemeral({ userIds }, frame);
}

/** Push to every person who may currently see this room, through the outbox. */
export async function publishToConversationReaders(
  conversationId: string,
  envelope: { event: string; data: unknown },
): Promise<void> {
  const userIds = await readersOf(conversationId);
  if (userIds.length === 0) return;
  await emitEvent(db, 'conversation.pushed', {
    conversationId,
    userIds,
    event: envelope.event,
    data: envelope.data,
  });
}

/**
 * Appends one service-written answer to the room — a visual block and its plain-text fallback — as
 * the project's handle, or as the asker where the room has none, and tells its readers.
 */
export async function postServiceAnswer(args: {
  conversationId: string;
  projectId: string;
  askerUserId: string;
  content: string;
  blocks: readonly ContentBlock[];
}): Promise<{ messageId: string }> {
  const { conversationId } = args;
  const author = (await handleForProject(conversationId, args.projectId)) ?? args.askerUserId;
  const [message] = await appendMessages({
    conversationId,
    messages: [
      { role: 'assistant', authorUserId: author, content: args.content, blocks: args.blocks },
    ],
  });
  if (!message) throw new Error(`conversations: the answer to ${conversationId} was not stored`);
  await publishToConversationReaders(conversationId, {
    event: WEB_CONVERSATION_EVENT,
    data: { conversationId, messageId: message.id, role: 'assistant', content: '' },
  }).catch((err: unknown) => {
    logger.warn({ err, conversationId }, 'conversations: the room was not told of the answer');
  });
  return { messageId: message.id };
}

/**
 * The Forge UI's four ports.
 */
export const webConversationPorts: ConversationAdapterPorts<WebConversationFrame> = {
  adapter: 'web',
  shapeFollowsMembership: true,

  async resolveVenue(frame: WebConversationFrame): Promise<ConversationVenue | null> {
    return {
      adapter: 'web',
      externalId: frame.conversation.externalId,
      shape: frame.conversation.shape,
      projectId: frame.projectId,
    };
  },

  async resolveSpeaker(frame: WebConversationFrame): Promise<SpeakerResolution> {
    return { linked: true, userId: frame.userId };
  },

  async deliver(
    venue: ConversationVenue,
    message: ScreenedMessage,
    opts?: DeliveryOptions,
  ): Promise<DeliveryReceipt> {
    const conversation = await findConversation('web', venue.externalId);
    if (!conversation) {
      throw new Error(
        `web conversations: no conversation is open at web venue "${venue.externalId}", so there is no room to deliver into — the conversation was deleted while its turn was running`,
      );
    }
    // the blocks this reply releases go in just above it, and only now that it passed its screen
    for (const held of opts?.blocks ?? []) {
      await postServiceAnswer({
        conversationId: conversation.id,
        projectId: held.projectId,
        askerUserId: held.askerUserId,
        content: held.text,
        blocks: [held.block],
      });
    }
    const messageId = randomUUID();
    await publishToConversationReaders(conversation.id, {
      event: WEB_CONVERSATION_EVENT,
      data: {
        conversationId: conversation.id,
        messageId,
        role: 'assistant',
        content: message.text,
      },
    });
    return { messageId };
  },

  async canDeliver(venue: ConversationVenue): Promise<boolean> {
    return (await findConversation('web', venue.externalId)) !== null;
  },

  async notifySettled(venue: ConversationVenue): Promise<void> {
    const conversation = await findConversation('web', venue.externalId);
    if (!conversation) return;
    await publishToConversationReaders(conversation.id, {
      event: WEB_CONVERSATION_SETTLED_EVENT,
      data: { conversationId: conversation.id, windowId: null, decision: 'handed-off' },
    });
  },

  async fetchHistory(): Promise<ConversationHistoryMessage[]> {
    return [];
  },
};
