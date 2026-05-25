'use client';

import { useQuery } from '@tanstack/react-query';
import { analyticsApi, analyticsKeys } from '../api';

export function useOutliers(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: analyticsKeys.outliers(projectId, days),
    queryFn: () => analyticsApi.outliers(projectId as string, days),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
