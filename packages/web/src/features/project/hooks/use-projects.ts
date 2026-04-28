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
    queryFn: projectApi.list,
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

export function useAddProjectMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      userId,
      role,
    }: {
      projectId: string;
      userId: string;
      role?: 'member' | 'owner';
    }) => projectApi.addMember(projectId, { userId, ...(role ? { role } : {}) }),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
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

export function useAddDeviceToPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, deviceId }: { projectId: string; deviceId: string }) =>
      projectApi.addDevice(projectId, deviceId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

export function useRemoveDeviceFromPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, deviceId }: { projectId: string; deviceId: string }) =>
      projectApi.removeDevice(projectId, deviceId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
