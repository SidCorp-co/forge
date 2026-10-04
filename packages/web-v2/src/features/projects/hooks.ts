'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useActiveOrg } from '@/features/orgs/active-org';
import { projectApi } from './api';
import { inActiveOrg, mergeProjects, workspaceTotals } from './derive';
import { usePinnedProjects } from './pins';

/** Project console list. Keyed `['projects']` — see the WS contract above. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => projectApi.list(),
  });
}

export function useOrgScopedProjects() {
  const { activeOrgId } = useActiveOrg();
  const q = useProjects();
  const projects = useMemo(
    () => (q.data ?? []).filter((p) => inActiveOrg(p, activeOrgId)),
    [q.data, activeOrgId],
  );
  const projectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const projectSlugs = useMemo(() => new Set(projects.map((p) => p.slug)), [projects]);
  return { projects, projectIds, projectSlugs, isLoading: q.isLoading, error: q.error };
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

export function useProjectHealth() {
  return useQuery({
    queryKey: ['projects', 'health'],
    queryFn: projectApi.health,
    staleTime: 300_000,
  });
}

/**
 * Compose the projects console: the `['projects']` list + `['projects','health']`
 * rollup + client-only pins → fully-hydrated `ProjectConsoleItem[]` + workspace
 * totals. Query keys are unchanged, so the WS event-router invalidations drive
 * live updates with no extra wiring.
 */
export function useProjectsConsole() {
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
  return useMutation({
    mutationFn: projectApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useOnboardProject(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => projectApi.onboard(projectId as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
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
