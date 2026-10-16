// The widget as a conversation adapter: a venue is one visitor session's conversation, its speaker
// is the visitor, who is never linked to a Forge user, and a delivery is a frame on the session's
// stream. The transcript row is written by the caller (`recordDeliveredReply`) under the id the
// frame was shown, so the stream and the history name the same message.

import { randomUUID } from 'node:crypto';
import {
  type ConversationAdapterPorts,
  type ConversationHistoryMessage,
  type ConversationVenue,
  type DeliveryReceipt,
  findConversation,
  registerConversationTransport,
  type ScreenedMessage,
  type SpeakerResolution,
} from '../conversations/index.js';
import { publishWidgetEvent } from './events.js';

/** What a widget message arrives as: the session it was sent on. */
export interface WidgetFrame {
  session: { id: string; projectId: string };
}

/** The venue id of a session's conversation. */
export const widgetVenueId = (sessionId: string) => `widget:${sessionId}`;

/** The venue a session talks in: one direct room per session, about the binding's project. */
export function widgetVenueOf(session: WidgetFrame['session']): ConversationVenue {
  return {
    adapter: 'widget',
    externalId: widgetVenueId(session.id),
    shape: 'direct',
    projectId: session.projectId,
    title: 'Feedback widget visitor',
  };
}

export const widgetConversationPorts: ConversationAdapterPorts<WidgetFrame> = {
  adapter: 'widget',

  async resolveVenue(frame: WidgetFrame): Promise<ConversationVenue> {
    return widgetVenueOf(frame.session);
  },

  // a visitor is never a Forge user, and never becomes one by linking: the session is who they are
  async resolveSpeaker(): Promise<SpeakerResolution> {
    return {
      linked: false,
      refusal: {
        code: 'SPEAKER_UNLINKED',
        message:
          'a widget visitor is a person on a client site, identified by their session, and is never linked to a Forge account',
      },
    };
  },

  async deliver(venue: ConversationVenue, message: ScreenedMessage): Promise<DeliveryReceipt> {
    const conversation = await findConversation('widget', venue.externalId);
    if (!conversation) {
      throw new Error(
        `widget: no conversation is open at venue "${venue.externalId}", so there is no stream to deliver into`,
      );
    }
    const messageId = randomUUID();
    publishWidgetEvent(conversation.id, {
      type: 'message',
      message: {
        id: messageId,
        role: 'assistant',
        text: message.text,
        at: new Date().toISOString(),
      },
    });
    return { messageId };
  },

  async canDeliver(venue: ConversationVenue): Promise<boolean> {
    return (await findConversation('widget', venue.externalId)) !== null;
  },

  async fetchHistory(): Promise<ConversationHistoryMessage[]> {
    return [];
  },
};

/** Make the widget an adapter the store can reach. Its recovery drain is a process timer. */
export function registerWidgetConversationAdapter(): void {
  registerConversationTransport(widgetConversationPorts);
}
