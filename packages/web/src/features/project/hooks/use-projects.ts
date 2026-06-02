'use client';

import type { CreateProjectInput, Project, UpdateProjectInput } from '@forge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { projectApi } from '../api/project-api';

/**
 * Stable React Query keys — F3's WS event router assumes this exact shape
 * when invalidating on project/issue events. Do not rename without also
 * updating the corresponding event router in `src/lib/ws/event-router.ts`.
 */
export const projectKeys = {
  all: ['projects'] as const,
  detail: (id: string | undefined) => ['project', id] as const,
  health: ['projects', 'health'] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: projectKeys.all,
    queryFn: () => projectApi.list(),
  });
}

/**
 * ISS-353 — projects list INCLUDING archived (`?archived=1` superset). Keyed
 * `['projects','all']`, a child of `projectKeys.all`, so the archive/unarchive
 * mutations (which invalidate `projectKeys.all`) refresh it too.
 *
 * This is ALWAYS enabled and has its OWN key — it must NOT be gated by a
 * caller-supplied `enabled` flag. An earlier fix toggled a shared
 * `['projects','archived']` key on/off via `useProjectBySlug({includeArchived})`;
 * the project layout also mounts `useProjectBySlug(slug)` (no opts), registering
 * a DISABLED observer on that same key, which left the query idle so the
 * settings page never fetched the superset and got stuck "Loading project…"
 * (AC3 live-E2E failure). A dedicated always-on query avoids that hazard.
 */
export function useProjectsIncludingArchived() {
  return useQuery({
    queryKey: [...projectKeys.all, 'all'] as const,
    queryFn: () => projectApi.list({ includeArchived: true }),
  });
}

export function useProjectsHealth() {
  return useQuery({
    queryKey: projectKeys.health,
    queryFn: projectApi.health,
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => projectApi.getById(projectId as string),
    enabled: !!projectId,
  });
}

export function useProjectBySlug(slug: string | undefined | null): Project | null {
  const { data: projects } = useProjects();
  return useMemo(() => {
    if (!slug || !projects) return null;
    return projects.find((p) => p.slug === slug) ?? null;
  }, [projects, slug]);
}

/**
 * ISS-353 — resolve a slug→project against the archived-INCLUSIVE list so an
 * archived project's settings page (and its Unarchive action) stays reachable.
 * The default `useProjectBySlug` resolves against the archived-excluded list,
 * which drops the project the moment it is archived. Uses the dedicated
 * always-on `useProjectsIncludingArchived` query (see its note for why a shared
 * toggled key broke this on live).
 */
export function useProjectBySlugIncludingArchived(
  slug: string | undefined | null,
): Project | null {
  const { data: projects } = useProjectsIncludingArchived();
  return useMemo(() => {
    if (!slug || !projects) return null;
    return projects.find((p) => p.slug === slug) ?? null;
  }, [projects, slug]);
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => projectApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProjectInput }) =>
      projectApi.update(id, patch),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(id) });
    },
  });
}

/**
 * ISS-353 — archive (soft) a project. Owner-only on the server. Invalidates
 * the project list (so it drops out) + the archived list + the detail.
 */
export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectApi.archive(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(id) });
    },
  });
}

/**
 * ISS-353 — unarchive a project; it reappears in the default list.
 */
export function useUnarchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectApi.unarchive(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(id) });
    },
  });
}

export function useRemoveProjectMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, userId }: { projectId: string; userId: string }) =>
      projectApi.removeMember(projectId, userId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

export function useInviteProjectMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      email,
      role,
    }: {
      projectId: string;
      email: string;
      role?: 'admin' | 'member';
    }) => projectApi.inviteMember(projectId, { email, ...(role ? { role } : {}) }),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/**
 * Per-project board WIP limits live under `agentConfig.boardConfig.wipLimits`.
 * Last-write-wins across concurrent tabs — WIP edits are infrequent enough
 * that the race is acceptable for v1.
 */
export function useUpdateProjectBoardConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      wipLimits,
    }: {
      projectId: string;
      wipLimits: Record<string, number | null>;
    }) => {
      const projects = qc.getQueryData<Project[]>(projectKeys.all);
      const current = projects?.find((p) => p.id === projectId) ?? null;
      const agentConfig =
        (current?.agentConfig as Record<string, unknown> | null | undefined) ?? {};
      const boardConfig =
        ((agentConfig.boardConfig as Record<string, unknown> | undefined) ?? {});
      const existingLimits =
        ((boardConfig.wipLimits as Record<string, number> | undefined) ?? {});
      const merged: Record<string, number> = { ...existingLimits };
      for (const [status, value] of Object.entries(wipLimits)) {
        if (value == null) delete merged[status];
        else merged[status] = value;
      }
      const nextAgentConfig = {
        ...agentConfig,
        boardConfig: { ...boardConfig, wipLimits: merged },
      };
      return projectApi.update(projectId, { agentConfig: nextAgentConfig } as never);
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/**
 * ISS-174 — bind a device to a project as a `claude-code` runner. Idempotent
 * on the server via `ON CONFLICT (project_id, device_id, type) DO UPDATE`.
 */
export function useBindRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      body,
    }: {
      projectId: string;
      // ISS-273 — the device-management page binds with a manually-typed
      // repoPath/branch, so the body widens beyond the bare deviceId.
      body: {
        deviceId: string;
        capabilities?: Record<string, unknown>;
        repoPath?: string | null;
        branch?: string | null;
      };
    }) => projectApi.bindRunner(projectId, body),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      // Device-management page lists runners under ['devices', id, 'runners'].
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/**
 * ISS-273 — update a runner's per-device repo path/branch via
 * `PATCH /api/projects/:id/runners/:runnerId`. Used by the device-management
 * page and the project-setup Device step.
 */
export function usePatchRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      runnerId,
      body,
    }: {
      projectId: string;
      runnerId: string;
      body: { repoPath?: string | null; branch?: string | null };
    }) => projectApi.patchRunner(projectId, runnerId, body),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/**
 * ISS-174 — drop a specific runner row (by runner UUID, NOT device UUID). The
 * runnerId comes from `project.devicePool[].runnerId`.
 */
export function useUnbindRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, runnerId }: { projectId: string; runnerId: string }) =>
      projectApi.unbindRunner(projectId, runnerId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
