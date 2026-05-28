import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memoryApi } from '../api';
import type { MemorySource } from '../types';

interface UseMemoriesParams {
  projectId?: string;
  source?: MemorySource;
}

/** Paginated list of memories (one page; see ISS-263 plan re: full paging). */
export function useMemories({ projectId, source }: UseMemoriesParams) {
  return useQuery({
    queryKey: ['memories', projectId, source ?? 'all'],
    queryFn: () => memoryApi.list({ projectId: projectId!, source }),
    enabled: !!projectId,
  });
}

interface UseMemorySearchParams {
  projectId?: string;
  /** Caller passes the already-debounced query. */
  query: string;
  sourceFilter?: MemorySource[];
}

/** Semantic search; disabled until the (debounced) query is non-empty. */
export function useMemorySearch({ projectId, query, sourceFilter }: UseMemorySearchParams) {
  return useQuery({
    queryKey: ['memory-search', projectId, query, sourceFilter ?? null],
    queryFn: () => memoryApi.search({ projectId: projectId!, query, sourceFilter }),
    enabled: !!projectId && query.trim().length > 0,
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) => memoryApi.remove(memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: ['memory-search'] });
    },
  });
}
