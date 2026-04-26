import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { skillApi } from '../api';
import type { Skill } from '../types';

export function useSkills(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['skills', projectDocumentId],
    queryFn: () => skillApi.getAll(projectDocumentId),
    enabled: !!projectDocumentId,
  });
}

export function useSkill(documentId: string) {
  return useQuery({
    queryKey: ['skill', documentId],
    queryFn: () => skillApi.getOne(documentId),
    enabled: !!documentId,
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof skillApi.create>[0]) => skillApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, data }: { documentId: string; data: Partial<Pick<Skill, 'name' | 'description' | 'skillMd' | 'target' | 'isGlobal' | 'files'>> }) =>
      skillApi.update(documentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill'] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => skillApi.delete(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useSkillSyncStatus(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['skill-sync-status', projectDocumentId],
    queryFn: () => skillApi.syncStatus(projectDocumentId!),
    enabled: !!projectDocumentId,
    refetchInterval: 30000,
  });
}

export function useBulkPushSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targets, projectDocumentId, skillNames }: {
      targets: string[];
      projectDocumentId: string;
      skillNames?: string[];
    }) => skillApi.bulkPush(targets, projectDocumentId, skillNames),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-sync-status'] });
    },
  });
}

// EPIC 6 (ISS-278/290) — effective skills + per-project override mutations.
export function useEffectiveSkills(projectId?: string) {
  return useQuery({
    queryKey: ['skills-effective', projectId],
    queryFn: () => skillApi.getEffective(projectId!),
    enabled: !!projectId,
  });
}

export function useUpsertSkillOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, skillId, skillMdOverride }: {
      projectId: string;
      skillId: string;
      skillMdOverride: string;
    }) => skillApi.upsertOverride(projectId, skillId, skillMdOverride),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['skills-effective', vars.projectId] });
    },
  });
}

export function useDeleteSkillOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, skillId }: { projectId: string; skillId: string }) =>
      skillApi.deleteOverride(projectId, skillId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['skills-effective', vars.projectId] });
    },
  });
}
