'use client';

import { useQuery } from '@tanstack/react-query';
import { analyticsApi, analyticsKeys } from '../api';

export function useCostTrend(projectId: string | undefined, days = 90) {
  return useQuery({
    queryKey: analyticsKeys.trend(projectId, days),
    queryFn: () => analyticsApi.costTrend(projectId as string, days),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
