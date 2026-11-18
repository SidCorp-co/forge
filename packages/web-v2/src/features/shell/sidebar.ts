
import { useCallback } from 'react';
import { usePersistedState } from '@/lib/utils/use-persisted-state';

export interface SidebarState {
  /** Icon-only rail when true. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Idempotent collapse-to-icon-rail (ISS-714 focus mode) — never expands,
   *  so it's safe to call on every pane-open without fighting a manual toggle. */
  collapse: () => void;
  /** The reader's open/closed choice per rail group; a group with no entry takes its own default. */
  groupOpen: Record<string, boolean>;
  /** Merges the rail's choices: opening a group writes it open and the rest of its tier closed (ISS-1331). */
  chooseGroups: (patch: Record<string, boolean>) => void;
}

interface Persisted {
  collapsed: boolean;
  groupOpen: Record<string, boolean>;
}

// Compact 88px Rail is the default (Concept C); expand opens the labeled rail.
const DEFAULT: Persisted = { collapsed: true, groupOpen: {} };

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

  const chooseGroups = useCallback(
    (patch: Record<string, boolean>) => setState((s) => ({ ...s, groupOpen: { ...s.groupOpen, ...patch } })),
    [setState],
  );

  return {
    collapsed: state.collapsed,
    toggleCollapsed,
    collapse,
    groupOpen: state.groupOpen ?? {},
    chooseGroups,
  };
}
