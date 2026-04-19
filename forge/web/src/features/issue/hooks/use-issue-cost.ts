import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

export function useIssueCost(documentId: string | null) {
  return useQuery({
    queryKey: ['issue-cost', documentId],
    queryFn: () => issueApi.getCostSummary(documentId!),
    enabled: !!documentId,
    staleTime: 30_000,
  });
}
