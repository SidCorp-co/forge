'use client';

import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

export function usePipelineTiming(
  projectId: string | null | undefined,
  params?: { from?: string; to?: string },
) {
  return useQuery({
    queryKey: ['pipeline-timing', projectId, params],
    queryFn: () =>
      issueApi.getPipelineTiming({ projectId: projectId as string, ...(params ?? {}) }),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}
