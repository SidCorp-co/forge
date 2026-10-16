// What a visitor's stream hears: one room per widget conversation, which only the session that
// opened it subscribes to. In-process, like every room (`lib/rooms.ts`): a frame that reconnects
// replays what it missed from the room's recent frames, and the history route is the record.

import type { WidgetMessage, WidgetStreamEvent } from '@forge/contracts/widget';
import type { StoredConversationMessage } from '../conversations/index.js';
import { roomManager, widgetConversationRoom } from '../lib/rooms.js';

/** The envelope name a widget frame is published under; the stream writes only its `data`. */
export const WIDGET_STREAM_ENVELOPE = 'widget';

export function publishWidgetEvent(conversationId: string, event: WidgetStreamEvent): void {
  roomManager.publish(widgetConversationRoom(conversationId), {
    event: WIDGET_STREAM_ENVELOPE,
    data: event,
  });
}

/** A conversation row as the frame shows it: the visitor's words, or the assistant's. */
export function widgetMessageOf(
  row: Pick<StoredConversationMessage, 'id' | 'role' | 'content' | 'createdAt'>,
): WidgetMessage {
  return {
    id: row.id,
    role: row.role === 'user' ? 'visitor' : 'assistant',
    text: row.content,
    at: row.createdAt.toISOString(),
  };
}
