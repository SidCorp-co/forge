'use client';

// web-v2 feature module: projects — React Query hooks.
//
// Query-key contract (ISS-288): `useProjects` is keyed `['projects']`, which is
// exactly the key `replayOnReconnect()` in `lib/ws/event-router.ts` invalidates
// on every WS reconnect. That makes the project console the "sample query that
// invalidates on a WS event" required by the foundation acceptance — and it is
// the template every later web-v2 feature follows: pick a key the event-router
// already touches, or live updates silently no-op.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { projectApi } from './api';
import { mergeProjects, workspaceTotals } from './derive';
import { usePinnedProjects } from './pins';
import type {
  CreatedProject,
  CreateProjectInput,
  ProjectConsoleItem,
  WorkspaceTotals,
} from './types';

/** Project console list. Keyed `['projects']` — see the WS contract above. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => projectApi.list(),
  });
}

/**
 * ISS-353 — projects list INCLUDING archived (`?archived=1` superset). Keyed
 * `['projects', 'all']`, a child of `['projects']`, so the WS reconnect replay
 * and the archive/unarchive mutations (which invalidate `['projects']`) refresh
 * it too. Used by Project Settings to resolve a slug→id even when the project
 * is archived (the default `['projects']` list excludes archived rows).
 */
export function useProjectsIncludingArchived() {
  return useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectApi.list({ includeArchived: true }),
  });
}

/**
 * Per-project pipeline-health rollup. Keyed `['projects', 'health']`, a child
 * of `['projects']` — so the same reconnect replay invalidates it too.
 */
export function useProjectHealth() {
  return useQuery({
    queryKey: ['projects', 'health'],
    queryFn: () => projectApi.health(),
  });
}

export interface ProjectsConsole {
  items: ProjectConsoleItem[];
  totals: WorkspaceTotals;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  toggle: (id: string) => void;
}

/**
 * Compose the projects console: the `['projects']` list + `['projects','health']`
 * rollup + client-only pins → fully-hydrated `ProjectConsoleItem[]` + workspace
 * totals. Query keys are unchanged, so the WS event-router invalidations drive
 * live updates with no extra wiring.
 */
export function useProjectsConsole(): ProjectsConsole {
  const projects = useProjects();
  const health = useProjectHealth();
  const { pinnedIds, toggle } = usePinnedProjects();

  const items = useMemo(
    () => mergeProjects(projects.data ?? [], health.data, pinnedIds),
    [projects.data, health.data, pinnedIds],
  );
  const totals = useMemo(() => workspaceTotals(items), [items]);

  return {
    items,
    totals,
    // Cold load = the list is still loading. Health hydrates the metrics a beat
    // later but the cards/rows can render from the list alone.
    isLoading: projects.isLoading,
    isError: projects.isError,
    error: projects.error,
    refetch: () => {
      projects.refetch();
      health.refetch();
    },
    toggle,
  };
}

/**
 * Create a project. On success invalidates `['projects']` (and its `health`
 * child) so the new row appears live in the console + rail switcher, then hands
 * the created row back to the caller for navigation. Errors (e.g. 409
 * `SLUG_TAKEN`) surface through the mutation's `error` for the form to render —
 * no toast here, so inline field validation owns the failure path.
 */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation<CreatedProject, unknown, CreateProjectInput>({
    mutationFn: (body) => projectApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** Full detail for one project. Keyed `['project', id]`. */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => projectApi.getById(id as string),
    enabled: !!id,
  });
}
