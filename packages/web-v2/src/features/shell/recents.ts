'use client';

// Recently-viewed entities (project / issue / session / run), MRU-ordered and
// capped. Detail screens call `push()` from an effect; the command palette
// renders them under a "Recent" group. Stored as a flat namespaced array so a
// future server sync can adopt the same shape per user.
import { useCallback } from 'react';
import { usePersistedState } from '@/lib/utils/use-persisted-state';
import type { IconName } from '@/design/icons/icon';

export type RecentKind = 'project' | 'issue' | 'session' | 'run';

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  label: string;
  href: string;
  icon?: IconName;
  ts: number;
}

const CAP = 8;

export interface RecentsState {
  items: RecentEntry[];
  push: (entry: Omit<RecentEntry, 'ts'>) => void;
  clear: () => void;
}

export function useRecents(): RecentsState {
  const [items, setItems] = usePersistedState<RecentEntry[]>('web-v2:recents', []);

  const push = useCallback(
    (entry: Omit<RecentEntry, 'ts'>) => {
      setItems((prev) => {
        const next = prev.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
        next.unshift({ ...entry, ts: Date.now() });
        return next.slice(0, CAP);
      });
    },
    [setItems],
  );

  const clear = useCallback(() => setItems([]), [setItems]);

  return { items, push, clear };
}
