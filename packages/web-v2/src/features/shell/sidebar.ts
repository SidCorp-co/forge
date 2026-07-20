'use client';

// Sidebar (NavRail) UI state: icon-only collapse + per-cluster open/closed.
// NavRail itself stays presentational — this hook owns the persisted state and
// the layout passes it down.
import { useCallback } from 'react';
import { usePersistedState } from '@/lib/utils/use-persisted-state';

export interface SidebarState {
  /** Icon-only rail when true. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Idempotent collapse-to-icon-rail (ISS-714 focus mode) — never expands,
   *  so it's safe to call on every pane-open without fighting a manual toggle. */
  collapse: () => void;
  /** Per-cluster open map keyed by cluster key. Missing key ⇒ open. */
  groupOpen: Record<string, boolean>;
  toggleGroup: (key: string) => void;
}

interface Persisted {
  collapsed: boolean;
  groupOpen: Record<string, boolean>;
}

// Compact 76px Rail is the default (Concept C); expand opens the labeled rail.
// Config cluster starts collapsed; other clusters open.
const DEFAULT: Persisted = { collapsed: true, groupOpen: { config: false } };

export function useSidebar(): SidebarState {
  const [state, setState] = usePersistedState<Persisted>('web-v2:sidebar', DEFAULT);

  const toggleCollapsed = useCallback(
    () => setState((s) => ({ ...s, collapsed: !s.collapsed })),
    [setState],
  );

  const collapse = useCallback(
    () => setState((s) => (s.collapsed ? s : { ...s, collapsed: true })),
    [setState],
  );

  const toggleGroup = useCallback(
    (key: string) =>
      setState((s) => ({
        ...s,
        groupOpen: { ...s.groupOpen, [key]: s.groupOpen[key] === false ? true : false },
      })),
    [setState],
  );

  return {
    collapsed: state.collapsed,
    toggleCollapsed,
    collapse,
    groupOpen: state.groupOpen ?? {},
    toggleGroup,
  };
}
