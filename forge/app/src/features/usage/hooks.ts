import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { UsageSummary, UsageRecord } from './types';

interface GetAllParams {
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  page?: number;
}

const usageApi = {
  getSummary: (days = 7) =>
    apiClient<{ data: UsageSummary }>(`/usage-records/summary?days=${days}`),

  getAll: (params?: GetAllParams) => {
    const query = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const qs = query.toString();
    return apiClient<{ data: UsageRecord[]; meta: { pagination: { total: number } } }>(
      qs ? `/usage-records?${qs}` : '/usage-records',
    );
  },

  ingestCli: () =>
    apiClient<{ data: { ingested: number; scanned: number } }>('/usage-records/ingest-cli', {
      method: 'POST',
    }),
};

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
