import { apiClient } from '@/lib/api/client';
import type { ProjectHealth } from './types';

export type { ProjectHealth };

export const dashboardApi = {
  getProjectHealth: () => apiClient<ProjectHealth[]>('/projects/health'),
};
