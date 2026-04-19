import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pipelineApi } from './api';
import type { PipelineFilter } from './types';

export function usePipelineSessions(filter: PipelineFilter, autoRefresh: boolean) {
  return useQuery({
    queryKey: ['pipeline-sessions', filter],
    queryFn: () => pipelineApi.getSessions(filter),
    refetchInterval: autoRefresh ? 10_000 : false,
  });
}

export function useCancelSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => pipelineApi.cancelSession(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-sessions'] });
    },
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => pipelineApi.deleteSession(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-sessions'] });
    },
  });
}
