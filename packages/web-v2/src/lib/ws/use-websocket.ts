'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { wsClient } from './client';
import { replayOnFirstOpen, replayOnReconnect, routeEvent } from './event-router';
import { userRoom } from './rooms';

export function useWebSocket(): void {
  const qc = useQueryClient();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || !user) return;
    wsClient.connect();
    const room = userRoom(user.id);
    wsClient.subscribe(room);
    const off = wsClient.on((env) => routeEvent(env, qc));
    const offOpen = wsClient.onOpen(({ first, openedAt }) => {
      if (first) replayOnFirstOpen(qc, openedAt);
      else replayOnReconnect(qc);
    });
    return () => {
      wsClient.unsubscribe(room);
      off();
      offOpen();
    };
  }, [qc, user, isLoading]);
}
