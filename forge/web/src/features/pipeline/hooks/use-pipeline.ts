'use client';

import { useQuery } from '@tanstack/react-query';
import { pipelineApi } from '../api';

export const pipelineKeys = {
  throughput: (days: number, projectId?: string) =>
    ['pipeline', 'throughput', days, projectId ?? 'all'] as const,
  cycleTime: (projectId?: string) => ['pipeline', 'cycle-time', projectId ?? 'all'] as const,
};

export function useThroughput(days: number = 30, projectId?: string) {
  return useQuery({
    queryKey: pipelineKeys.throughput(days, projectId),
    queryFn: () => pipelineApi.throughput({ days, ...(projectId ? { projectId } : {}) }),
  });
}

export function useCycleTime(projectId?: string) {
  return useQuery({
    queryKey: pipelineKeys.cycleTime(projectId),
    queryFn: () => pipelineApi.cycleTime(projectId ? { projectId } : {}),
  });
}
