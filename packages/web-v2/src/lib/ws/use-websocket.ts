'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { wsClient } from './client';
import { replayEverything, routeEvent } from './event-router';
import { userRoom } from './rooms';

export function useWebSocket(): void {
  const qc = useQueryClient();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || !user) return;
    wsClient.connect();
    const room = userRoom(user.id);
    wsClient.subscribe(room, 0);
    const off = wsClient.on((env) => routeEvent(env, qc));
    const offGap = wsClient.onReplayGap(() => replayEverything(qc));
    return () => {
      wsClient.unsubscribe(room);
      off();
      offGap();
    };
  }, [qc, user, isLoading]);
}
