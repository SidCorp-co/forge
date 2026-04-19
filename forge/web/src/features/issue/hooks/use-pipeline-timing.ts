import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

export function usePipelineTiming(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['pipeline-timing', params],
    queryFn: () => issueApi.getPipelineTiming(params),
    staleTime: 60_000,
  });
}
