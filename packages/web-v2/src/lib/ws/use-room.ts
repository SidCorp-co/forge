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

/**
 * Subscribe to a whole SET of rooms for the component's lifetime. The Operator
 * Ops Console watches every project on the deployment at once, so one hook per
 * room is not available to it — the list arrives from a query and its length
 * changes between renders.
 */
// cm:guard the effect keys on the JOINED room list, not the array identity — a query that re-renders with a fresh array of the same 34 rooms would otherwise unsubscribe and resubscribe all of them on every refetch
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
