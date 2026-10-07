'use client';

import { useEffect, useRef } from 'react';
import { isUuid } from '@/lib/api/ref-bridge';
import { wsClient } from './client';

/**
 * Rooms are named by uuid. A project page addresses its project by the URL's slug until the
 * projects list names the uuid, so a slug's room is not subscribed; the uuid's room, once known,
 * asks its replay from when the slug's reads began.
 */
function subscribable(room: string): boolean {
  return !room.startsWith('project:') || isUuid(room.slice('project:'.length));
}

/** When the reads this room covers began: the first time it was wanted, carried over a slug's room. */
function useWantedSince(room: string | null | undefined, carryFromSlug: boolean): number {
  const wanted = useRef<{ room: string | null | undefined; at: number } | null>(null);
  const prior = wanted.current;
  if (prior?.room !== room) {
    const carried = carryFromSlug && prior?.room && !subscribable(prior.room) ? prior.at : performance.now();
    wanted.current = { room, at: carried };
  }
  return (wanted.current as { at: number }).at;
}

/**
 * Subscribe the current component to a WS room for its lifetime. Pass
 * null/undefined to opt out (e.g. while data is still loading).
 */
export function useRoom(room: string | null | undefined): void {
  const since = useWantedSince(room, true);
  useEffect(() => {
    if (!room || !subscribable(room)) return;
    wsClient.subscribe(room, since);
    return () => wsClient.unsubscribe(room);
  }, [room, since]);
}

export function useRooms(rooms: readonly string[]): void {
  const key = rooms.filter(subscribable).join(',');
  const since = useWantedSince(key, false);
  useEffect(() => {
    const list = key ? key.split(',') : [];
    for (const room of list) wsClient.subscribe(room, since);
    return () => {
      for (const room of list) wsClient.unsubscribe(room);
    };
  }, [key, since]);
}
