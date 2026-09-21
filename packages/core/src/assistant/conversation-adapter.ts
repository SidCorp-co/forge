import { randomUUID } from 'node:crypto';
import { listParticipants } from '../conversations/participants.js';
import type {
  ConversationAdapterPorts,
  ConversationHistoryMessage,
  ConversationVenue,
  DeliveryReceipt,
  ScreenedMessage,
} from '../conversations/ports.js';
import { assertConversationReadable } from '../conversations/scope.js';
import { findConversation } from '../conversations/store.js';
import type { ConversationShape } from '../db/schema-conversations.js';
import { roomManager } from '../ws/room-manager.js';
import { userRoom } from '../ws/rooms.js';
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

/** Publish to every socket that may currently see this room. Returns how many took it. */
export async function publishToConversationReaders(
  conversationId: string,
  envelope: { event: string; data: unknown },
): Promise<number> {
  let sockets = 0;
  for (const userId of await readersOf(conversationId)) {
    sockets += roomManager.publish(userRoom(userId), envelope);
  }
  return sockets;
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

  async deliver(venue: ConversationVenue, message: ScreenedMessage): Promise<DeliveryReceipt> {
    const conversation = await findConversation('web', venue.externalId);
    if (!conversation) {
      throw new Error(
        `web conversations: no conversation is open at web venue "${venue.externalId}", so there is no room to deliver into — the conversation was deleted while its turn was running`,
      );
    }
    const messageId = randomUUID();
    const sockets = await publishToConversationReaders(conversation.id, {
      event: WEB_CONVERSATION_EVENT,
      data: {
        conversationId: conversation.id,
        messageId,
        role: 'assistant',
        content: message.text,
        problems: message.problems,
      },
    });
    return { messageId, sockets } as DeliveryReceipt & { sockets: number };
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
