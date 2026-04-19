import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usageApi } from '../api/usage-api';

export function useUsageSummary(days = 7) {
  return useQuery({
    queryKey: ['usage-summary', days],
    queryFn: () => usageApi.getSummary(days),
    select: (res) => res.data,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useIngestCliUsage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: usageApi.ingestCli,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    },
    onError: (error) => {
      console.error('[usage] CLI ingest failed:', error);
    },
  });
}
