'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useActiveOrg } from '@/features/orgs/active-org';
import { projectApi } from './api';
import { mergeProjects, workspaceTotals } from './derive';
import { usePinnedProjects } from './pins';
import type {
  CreatedProject,
  CreateProjectInput,
  OnboardResult,
  ProjectConsoleItem,
  ProjectListItem,
  WorkspaceTotals,
} from './types';

/** Project console list. Keyed `['projects']` — see the WS contract above. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => projectApi.list(),
  });
}

export interface OrgScopedProjects {
  projects: ProjectListItem[];
  projectIds: Set<string>;
  projectSlugs: Set<string>;
  activeOrgId: string | null;
  isLoading: boolean;
  error: unknown;
}

export function useOrgScopedProjects(): OrgScopedProjects {
  const { activeOrgId } = useActiveOrg();
  const q = useProjects();
  const projects = useMemo(
    () => (q.data ?? []).filter((p) => !activeOrgId || p.orgId === activeOrgId),
    [q.data, activeOrgId],
  );
  const projectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const projectSlugs = useMemo(() => new Set(projects.map((p) => p.slug)), [projects]);
  return { projects, projectIds, projectSlugs, activeOrgId, isLoading: q.isLoading, error: q.error };
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

export const PROJECT_HEALTH_STALE_MS = 300_000;

export function useProjectHealth() {
  return useQuery({
    queryKey: ['projects', 'health'],
    queryFn: () => projectApi.health(),
    staleTime: PROJECT_HEALTH_STALE_MS,
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

export function useOnboardProject(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<OnboardResult, unknown, void>({
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
