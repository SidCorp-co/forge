import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { skillApi } from './api';
import type { Skill } from './types';

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
    refetchInterval: 30_000,
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
