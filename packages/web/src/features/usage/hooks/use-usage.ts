import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usageApi } from '../api/usage-api';
import type { UsageRecord } from '../types';

export function useUsageSummary(projectId: string | undefined, days = 7) {
  return useQuery({
    queryKey: ['usage-summary', projectId, days],
    queryFn: () => usageApi.getSummary(projectId!, days),
    enabled: !!projectId,
    select: (res) => res.data,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useIngestCliUsage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      records,
    }: {
      projectId: string;
      records: Array<Partial<UsageRecord> & { recordedAt: string; model: string; source: string }>;
    }) => usageApi.ingestCli(projectId, records),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage-summary'] });
    },
    onError: (error) => {
      console.error('[usage] CLI ingest failed:', error);
    },
  });
}
