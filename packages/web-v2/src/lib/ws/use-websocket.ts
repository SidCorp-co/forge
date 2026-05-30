'use client';

// Ported verbatim from `packages/web/src/lib/ws/use-websocket.ts` (ISS-288).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { wsClient } from './client';
import { replayOnReconnect, routeEvent } from './event-router';
import { userRoom } from './rooms';

/**
 * Mount once under the auth provider. The WS client is a singleton, so
 * multiple useWebSocket() calls are safe, but only the first adds the
 * listener pair.
 *
 * Subscribes the connection to the current user's user-room so that
 * user-scoped server events (`pat.*`, `notification.*`, …) reach this client.
 * `RoomManager.publish()` only delivers to explicit subscribers, so without
 * this the server's `roomManager.publish(userRoom(userId), …)` calls would
 * be silently dropped on the client.
 */
export function useWebSocket(): void {
  const qc = useQueryClient();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || !user) return;
    wsClient.connect();
    const room = userRoom(user.id);
    wsClient.subscribe(room);
    const off = wsClient.on((env) => routeEvent(env, qc));
    const offOpen = wsClient.onOpen(() => replayOnReconnect(qc));
    return () => {
      wsClient.unsubscribe(room);
      off();
      offOpen();
    };
  }, [qc, user, isLoading]);
}
