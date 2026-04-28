import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { labelApi } from '../api/label-api';
import type { LabelFormData } from '../types';

export function useLabels(projectDocumentId: string) {
  return useQuery({
    queryKey: ['labels', projectDocumentId],
    queryFn: () => labelApi.getByProject(projectDocumentId),
    enabled: !!projectDocumentId,
  });
}

export function useCreateLabel(projectDocumentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LabelFormData) => labelApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels', projectDocumentId] });
    },
  });
}

export function useUpdateLabel(projectDocumentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, data }: { documentId: string; data: Partial<LabelFormData> }) =>
      labelApi.update(documentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels', projectDocumentId] });
    },
  });
}

export function useDeleteLabel(projectDocumentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => labelApi.delete(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels', projectDocumentId] });
    },
  });
}
