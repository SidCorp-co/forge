/**
 * The Forge UI as a conversation adapter: four functions, and nothing else.
 *
 * ISS-1002 claimed a second adapter is `resolveVenue`, `resolveSpeaker`,
 * `deliver` and `fetchHistory`. This file is that claim paid: the browser is a
 * venue like any other room, a signed-in reader is a speaker who needs no
 * directory lookup, and the one outbound door is the socket their tab is
 * already holding.
 *
 * It lives beside `conversation-routes.ts` rather than under `integrations/`
 * for the reason that file gives: `transport-free.test.ts` refuses an adapter
 * tree that reads the store, and the Forge UI's own adapter surface is the
 * exception that never had to be carved because it was never put there.
 */

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
// cm:edge contract -> packages/web-v2/src/lib/ws/event-router.ts — the other half is the case that appends this payload to the open thread; a rename here without one there leaves the screen correct only after a reload.
export const WEB_CONVERSATION_EVENT = 'conversation.message';

/**
 * The event that says this room has settled — whatever it settled on.
 */
// cm:guard a SECOND event and not a substitute for the first: the delivery above happens before `recordDeliveredReply` commits, so a tab that refetched on it alone can read the room back without the reply in it and sit on "nobody has answered this yet" until something unrelated refetches. This one is published after the window closes, and it is what makes the answer and every silent decision reach a second tab at all (ISS-1004 step 5, review F2).
export const WEB_CONVERSATION_SETTLED_EVENT = 'conversation.settled';

/**
 * The event a browser draws a turn IN FLIGHT from.
 */
// cm:guard a THIRD event and not a payload on the first two, which keep their names and their shapes
// so a tab running older code is untouched by this: the two above are answered with an invalidation,
// and a frame that arrived per token under either name would refetch the whole room per token. This
// one carries the growing entry and is answered by writing it into the cache (ISS-1078).
// cm:edge contract -> packages/web-v2/src/lib/ws/event-router.ts — the other half is the case that
// writes this frame's entry under `["conversations", id, "progress"]`; the payload is settled in
// `conversation-progress.ts` as `ConversationProgressFrame`, and a rename on either side leaves a
// turn that streams to nowhere.
export const WEB_CONVERSATION_PROGRESS_EVENT = 'conversation.progress';

/**
 * The event that says a typed message is now a durable row.
 */
// cm:guard published BEFORE the turn is routed, which is the whole of its value: the row is committed
// by `collectInboundMessage` and the send route then answers nothing until the answer exists, so
// without this the person who pressed enter watched their own question read "Sending…" for the length
// of a model turn. It carries the client's own token so the tab that sent it can match the row to the
// one it is holding, and every other reader learns a message arrived (ISS-1078).
// cm:edge contract -> packages/web-v2/src/lib/ws/event-router.ts — the other half clears the outbox
// row's label; it does NOT drop the row, because this frame carries ids and not the message, and a
// room whose cache predates the send would have nothing to show in its place.
export const WEB_CONVERSATION_ACCEPTED_EVENT = 'conversation.accepted';

/**
 * Whose sockets may be shown this room, right now.
 */
// cm:guard a participant row is not a permission and must not be used as one: a person keeps their row after losing the project access the room derives its scope from, and the reads refuse them while a push addressed by kind alone would hand them the whole answer. The check is the SAME one `conversation-routes.ts` applies — `assertConversationReadable` — rather than a second, weaker copy of it here (ISS-1004 step 5, review F1).
async function readersOf(conversationId: string): Promise<string[]> {
  const out: string[] = [];
  for (const person of await listParticipants(conversationId)) {
    if (person.kind !== 'person' || !person.userId) continue;
    try {
      await assertConversationReadable(conversationId, person.userId);
      out.push(person.userId);
    } catch {
      // cm:why a refusal here is the ordinary case for a person whose access went, not an error: they are dropped from the fan-out and the room's own rows still refuse them on the next read
    }
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
// cm:guard `web` is already a legal `conversations.adapter` value and has been since ISS-1001, so registering this adapter is one `registerConversationTransport` call and no migration — which is the property `ports.test.ts` asserts and this file is the first real instance of (ISS-1004 step 5).
export const webConversationPorts: ConversationAdapterPorts<WebConversationFrame> = {
  adapter: 'web',
  // cm:guard the Forge UI's rooms move between `direct` and `group` as people come and go: nothing outside Forge holds an opinion about their shape, and the route reads it off the row on every request (ISS-1034 criteria 41-44).
  shapeFollowsMembership: true,

  // cm:guard the venue is built from the room the route already read and its shape is NOT re-decided here: the route authorized the caller against that exact row, and a second read that disagreed would answer under a binding nobody checked.
  async resolveVenue(frame: WebConversationFrame): Promise<ConversationVenue | null> {
    return {
      adapter: 'web',
      externalId: frame.conversation.externalId,
      shape: frame.conversation.shape,
      projectId: frame.projectId,
    };
  },

  // cm:guard no directory lookup, because there is nothing to look up: every other adapter resolves a transport's own account to a Forge user and can fail, and this one is handed the Forge user by the session cookie that authenticated the request. A speaker port that could refuse here would be refusing the person who just signed in.
  async resolveSpeaker(frame: WebConversationFrame): Promise<SpeakerResolution> {
    return { linked: true, userId: frame.userId };
  },

  // cm:guard the push goes to each PERSON's own user room and never to the project room: a `direct` web conversation is one person's chat, `user:` is the one room prefix `ws/server.ts:canSubscribe` grants to that user alone, and a project-room fan-out would hand every member of the project the text of a room they are not in.
  // cm:guard zero open sockets is NOT an undelivered reply and must never be reported as one: the durable row `recordDeliveredReply` writes immediately after this is what the person reads when they next open the room, and the push is only how they see it without reloading. A transport whose delivery can fail is one whose window closes `undetermined`; this one's cannot, and that is a property of the browser being the venue rather than a shortfall being hidden.
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

  // cm:guard the room still EXISTS, which is the whole of what a browser venue can lose: there is no binding to move and no credential to expire, so this is the one thing a later delivery can find changed — the conversation deleted while its turn ran.
  async canDeliver(venue: ConversationVenue): Promise<boolean> {
    return (await findConversation('web', venue.externalId)) !== null;
  },

  // cm:guard the SETTLED event and not the message one: the message already went out through `deliver`, and what a tab watching a runner-hosted turn is waiting for is the state change — the turn is no longer running, and the room's own rows now hold whatever it produced.
  async notifySettled(venue: ConversationVenue): Promise<void> {
    const conversation = await findConversation('web', venue.externalId);
    if (!conversation) return;
    await publishToConversationReaders(conversation.id, {
      event: WEB_CONVERSATION_SETTLED_EVENT,
      data: { conversationId: conversation.id, windowId: null, decision: 'handed-off' },
    });
  },

  // cm:guard EMPTY, and deliberately: every other adapter's history is a backlog the transport holds and the store has never seen, and this transport holds none — the conversation's own rows ARE the browser's history, and `external-chat.ts` already reads them for the turn. Returning anything here would be reading the store twice and showing the model its own transcript a second time.
  async fetchHistory(): Promise<ConversationHistoryMessage[]> {
    return [];
  },
};
