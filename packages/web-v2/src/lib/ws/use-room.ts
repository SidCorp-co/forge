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

export function useRooms(rooms: readonly string[]): void {
  const key = rooms.join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    for (const room of list) wsClient.subscribe(room);
    return () => {
      for (const room of list) wsClient.unsubscribe(room);
    };
  }, [key]);
}
