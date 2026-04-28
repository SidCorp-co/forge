import { apiClient } from '@/lib/api/client';
import type { CycleTimePoint, ThroughputPoint } from './types';

export const pipelineApi = {
  throughput: (params: { days?: number; projectId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.days) qs.set('days', String(params.days));
    if (params.projectId) qs.set('projectId', params.projectId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiClient<ThroughputPoint[]>(`/pipeline/throughput${suffix}`);
  },

  cycleTime: (params: { projectId?: string } = {}) => {
    const suffix = params.projectId ? `?projectId=${params.projectId}` : '';
    return apiClient<CycleTimePoint[]>(`/pipeline/cycle-time${suffix}`);
  },
};
