import { apiClient } from '@/lib/api/client';
import type { AttentionResponse, ProjectHealth } from './types';

export type { AttentionResponse, ProjectHealth };

export const dashboardApi = {
  getProjectHealth: () => apiClient<ProjectHealth[]>('/projects/health'),
  getAttention: () => apiClient<AttentionResponse>('/me/attention'),
};
