import { apiClient } from '@/lib/api/client';
import type { AttentionResponse, ProjectHealth, StepDurationRow } from './types';

export type { AttentionResponse, ProjectHealth, StepDurationRow };

export const dashboardApi = {
  getProjectHealth: () => apiClient<ProjectHealth[]>('/projects/health'),
  getAttention: () => apiClient<AttentionResponse>('/me/attention'),
  getStepDurations: (projectId: string, days = 7) =>
    apiClient<StepDurationRow[]>(
      `/pipeline/step-durations?projectId=${encodeURIComponent(projectId)}&days=${days}`,
    ),
};
