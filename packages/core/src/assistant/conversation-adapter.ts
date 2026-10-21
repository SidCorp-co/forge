import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { listParticipants } from '../conversations/participants.js';
import type {
  ConversationAdapterPorts,
  ConversationHistoryMessage,
  ConversationVenue,
  DeliveryReceipt,
  ScreenedMessage,
} from '../conversations/ports.js';
import { assertConversationReadable, derivedScope } from '../conversations/scope.js';
import { findConversation } from '../conversations/store.js';
import { db } from '../db/client.js';
import { organizationMembers, projectMembers } from '../db/schema.js';
import type { ConversationShape } from '../db/schema-conversations.js';
import { conversations } from '../db/schema-conversations.js';
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

/** The event that tells a reader a room is gone, so an open list or thread lets go of it. */
export const WEB_CONVERSATION_DELETED_EVENT = 'conversation.deleted';

/**
 * Delete a room through `remove`, then tell everyone who could read it beforehand: once it is
 * gone there is nobody left to ask (ISS-1229 r29, the master's ruling).
 */
export async function deleteAndTellReaders(
  conversationId: string,
  remove: (id: string) => Promise<unknown>,
): Promise<void> {
  const readers = await everyoneWhoCanRead(conversationId);
  await remove(conversationId);
  const envelope = { event: WEB_CONVERSATION_DELETED_EVENT, data: { conversationId } };
  for (const userId of readers) roomManager.publish(userRoom(userId), envelope);
}

/**
 * Everyone who may read this room, its people or not: a group room is read by whoever holds a role on
 * every project it is about (r29 review F1), so the candidates are its people, its organization's
 * members and its projects' members, each held to the room's own read rule.
 */
async function everyoneWhoCanRead(conversationId: string): Promise<string[]> {
  const scope = await derivedScope(conversationId);
  const [room] = await db
    .select({ orgId: conversations.orgId, createdBy: conversations.createdBy })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const candidates = new Set<string>();
  for (const person of await listParticipants(conversationId)) {
    if (person.kind === 'person' && person.userId) candidates.add(person.userId);
  }
  if (room?.createdBy) candidates.add(room.createdBy);
  if (room?.orgId) {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, room.orgId));
    for (const m of members) candidates.add(m.userId);
  }
  if (scope.length > 0) {
    const members = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(inArray(projectMembers.projectId, scope));
    for (const m of members) candidates.add(m.userId);
  }
  const out: string[] = [];
  for (const userId of candidates) {
    try {
      await assertConversationReadable(conversationId, userId);
      out.push(userId);
    } catch {}
  }
  return out;
}

/**
 * Publish to every socket that may currently see this room: everyone who can read it, the people its
 * deletion is told to, and not its people alone (ISS-1229 r30, the master's ruling on judge-86's
 * finding). Returns how many took it.
 */
export async function publishToConversationReaders(
  conversationId: string,
  envelope: { event: string; data: unknown },
): Promise<number> {
  let sockets = 0;
  for (const userId of await everyoneWhoCanRead(conversationId)) {
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
