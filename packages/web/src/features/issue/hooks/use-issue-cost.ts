'use client';

import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

export function useIssueCost(documentId: string | null | undefined) {
  return useQuery({
    queryKey: ['issue-cost', documentId],
    queryFn: () => issueApi.getCostSummary(documentId as string),
    enabled: !!documentId,
    staleTime: 30_000,
  });
}
