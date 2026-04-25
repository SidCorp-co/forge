import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { memoryApi } from '../api';

export function useMemories(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['memories', projectDocumentId],
    queryFn: () => memoryApi.list(projectDocumentId!),
    enabled: !!projectDocumentId,
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) => memoryApi.remove(memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
  });
}
