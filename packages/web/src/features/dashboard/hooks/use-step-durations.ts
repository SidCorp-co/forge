'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api';

export function useStepDurations(projectId: string | undefined, days = 7) {
  return useQuery({
    queryKey: ['pipeline', 'step-durations', projectId, days],
    queryFn: () => dashboardApi.getStepDurations(projectId as string, days),
    enabled: !!projectId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
