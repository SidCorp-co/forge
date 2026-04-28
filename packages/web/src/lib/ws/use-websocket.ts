'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { wsClient } from './client';
import { replayOnReconnect, routeEvent } from './event-router';

/**
 * Mount once under the auth provider. The WS client is a singleton, so
 * multiple useWebSocket() calls are safe, but only the first adds the
 * listener pair.
 */
export function useWebSocket(): void {
  const qc = useQueryClient();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || !user) return;
    wsClient.connect();
    const off = wsClient.on((env) => routeEvent(env, qc));
    const offOpen = wsClient.onOpen(() => replayOnReconnect(qc));
    return () => {
      off();
      offOpen();
    };
  }, [qc, user, isLoading]);
}
