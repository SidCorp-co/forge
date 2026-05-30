'use client';

// web-v2 feature module: projects — pinned projects (client-only).
//
// There is no backend pin column; pins are a per-browser preference stored in
// localStorage. Kept out of React Query so a pin toggle never refetches.
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'web-v2:pinned-projects';

function readPins(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface PinnedProjects {
  /** Set of pinned project ids (stable identity per render). */
  pinnedIds: Set<string>;
  isPinned: (id: string) => boolean;
  toggle: (id: string) => void;
}

/** Pinned-project ids in localStorage, with a `toggle(id)` mutator. */
export function usePinnedProjects(): PinnedProjects {
  const [ids, setIds] = useState<string[]>([]);

  // Hydrate after mount (localStorage is unavailable during SSR).
  useEffect(() => {
    setIds(readPins());
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore quota / disabled-storage errors — pins are best-effort.
      }
      return next;
    });
  }, []);

  const pinnedIds = new Set(ids);
  const isPinned = useCallback((id: string) => pinnedIds.has(id), [pinnedIds]);

  return { pinnedIds, isPinned, toggle };
}
