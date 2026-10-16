// A visitor session's event stream: server-sent events, one JSON `WidgetStreamEvent` per event,
// read with fetch streaming because the token rides in `Authorization`. It subscribes to the
// session's conversation room, replays what the room kept from just before it opened, beats every
// few seconds so a proxy does not close it, and ends when the visitor leaves or the session expires.

import type { WidgetStreamEvent } from '@forge/contracts/widget';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { logger } from '../lib/logger.js';
import { roomManager, widgetConversationRoom } from '../lib/rooms.js';
import type { SessionRow } from './store.js';

/** How far back a stream that opens replays: the gap between reading the history and subscribing. */
const REPLAY_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const OPEN = 1;
const CLOSED = 3;

export function widgetStream(c: Context, session: SessionRow): Response {
  return streamSSE(c, async (stream) => {
    const room = widgetConversationRoom(session.conversationId);
    const subscriber = {
      readyState: OPEN,
      send(payload: string) {
        const { data } = JSON.parse(payload) as { data: WidgetStreamEvent };
        void stream.writeSSE({ data: JSON.stringify(data) });
      },
    };
    roomManager.subscribe(subscriber, room);
    roomManager.replay(subscriber, room, REPLAY_MS);
    const beat = setInterval(() => void stream.write(': beat\n\n'), HEARTBEAT_MS);
    beat.unref?.();
    try {
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        const expiry = setTimeout(resolve, Math.max(0, session.expiresAt.getTime() - Date.now()));
        expiry.unref?.();
        stream.onAbort(() => clearTimeout(expiry));
      });
    } finally {
      clearInterval(beat);
      subscriber.readyState = CLOSED;
      roomManager.removeAll(subscriber);
      logger.debug({ conversationId: session.conversationId }, 'widget: a stream closed');
    }
  });
}
