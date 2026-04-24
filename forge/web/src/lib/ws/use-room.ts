'use client';

import { useEffect } from 'react';
import { wsClient } from './client';

/**
 * Subscribe the current component to a WS room for its lifetime. Pass
 * null/undefined to opt out (e.g. while data is still loading).
 */
export function useRoom(room: string | null | undefined): void {
  useEffect(() => {
    if (!room) return;
    wsClient.subscribe(room);
    return () => wsClient.unsubscribe(room);
  }, [room]);
}
