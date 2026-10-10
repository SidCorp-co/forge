'use client';

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
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
// Read in a layout effect: layout effects run before the passive ones in which the commit's queries
// subscribe and start fetching, so the instant is taken before any read it covers begins.
function useWantedSince(room: string | null | undefined, carryFromSlug: boolean): RefObject<{ room: string | null | undefined; at: number } | null> {
  const wantedRef = useRef<{ room: string | null | undefined; at: number } | null>(null);
  useLayoutEffect(() => {
    const prior = wantedRef.current;
    if (prior?.room === room) return;
    const carried = carryFromSlug && prior?.room && !subscribable(prior.room) ? prior.at : performance.now();
    wantedRef.current = { room, at: carried };
  }, [room, carryFromSlug]);
  return wantedRef;
}

/**
 * Subscribe the current component to a WS room for its lifetime. Pass
 * null/undefined to opt out (e.g. while data is still loading).
 */
export function useRoom(room: string | null | undefined): void {
  const wantedRef = useWantedSince(room, true);
  useEffect(() => {
    if (!room || !subscribable(room)) return;
    wsClient.subscribe(room, wantedRef.current?.at ?? performance.now());
    return () => wsClient.unsubscribe(room);
  }, [room, wantedRef]);
}

export function useRooms(rooms: readonly string[]): void {
  const key = rooms.filter(subscribable).join(',');
  const wantedRef = useWantedSince(key, false);
  useEffect(() => {
    const list = key ? key.split(',') : [];
    const since = wantedRef.current?.at ?? performance.now();
    for (const room of list) wsClient.subscribe(room, since);
    return () => {
      for (const room of list) wsClient.unsubscribe(room);
    };
  }, [key, wantedRef]);
}
