'use client';

import { useCallback } from 'react';
import { usePersistedState, WEB_V2_NS } from '@/lib/utils/use-persisted-state';

// A stored value that is not a string list (hand-edited, older shape) reads as no pins.
const pinList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Pinned-project ids in localStorage, with a `toggle(id)` mutator. */
export function usePinnedProjects(): { pinnedIds: Set<string>; toggle: (id: string) => void } {
  const [stored, setStored] = usePersistedState<unknown>(`${WEB_V2_NS}pinned-projects`, [], {
    syncTabs: false,
  });
  const toggle = useCallback(
    (id: string) =>
      setStored((prev: unknown) => {
        const list = pinList(prev);
        return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      }),
    [setStored],
  );
  return { pinnedIds: new Set(pinList(stored)), toggle };
}
