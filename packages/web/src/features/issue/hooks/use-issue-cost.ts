'use client';

import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

export function useIssueCost(issueId: string | null | undefined) {
  return useQuery({
    queryKey: ['issue-cost', issueId],
    queryFn: () => issueApi.getCostSummary(issueId as string),
    enabled: !!issueId,
    staleTime: 30_000,
  });
}
