'use client';

// Pinned views/tabs = a (route + filter-state) deep-link the user saves. They
// render as a horizontal pinned-tab bar and as a "Pinned" group in the command
// palette. The `href` carries the encoded filter state, so reopening a pinned
// view restores it (see features/shell/deep-link.ts + the Issues screen).
import { useCallback } from 'react';
import { usePersistedState } from '@/lib/utils/use-persisted-state';
import type { IconName } from '@/design/icons/icon';

export interface PinnedView {
  /** Stable id; callers use `pathname` (one pin per route) or a custom key. */
  id: string;
  label: string;
  icon: IconName;
  /** Route + query deep-link, e.g. `/projects/foo/issues?status=open`. */
  href: string;
}

export interface PinnedViewsState {
  views: PinnedView[];
  isPinned: (id: string) => boolean;
  /** Add if absent (by id), otherwise remove — toggling the same view off. */
  toggle: (view: PinnedView) => void;
  remove: (id: string) => void;
}

export function usePinnedViews(): PinnedViewsState {
  const [views, setViews] = usePersistedState<PinnedView[]>('web-v2:pinned-views', []);

  const isPinned = useCallback((id: string) => views.some((v) => v.id === id), [views]);

  const toggle = useCallback(
    (view: PinnedView) => {
      setViews((prev) =>
        prev.some((v) => v.id === view.id)
          ? prev.filter((v) => v.id !== view.id)
          : [...prev, view],
      );
    },
    [setViews],
  );

  const remove = useCallback(
    (id: string) => setViews((prev) => prev.filter((v) => v.id !== id)),
    [setViews],
  );

  return { views, isPinned, toggle, remove };
}
