import { apiClient } from '@/lib/api/client';
import type { CostSummary, CostTrend, Outliers } from './types';

export const analyticsApi = {
  costSummary: (projectId: string, days: number) =>
    apiClient<CostSummary>(
      `/projects/${projectId}/analytics/cost-summary?days=${days}`,
    ),
  costTrend: (projectId: string, days: number) =>
    apiClient<CostTrend>(
      `/projects/${projectId}/analytics/cost-trend?days=${days}`,
    ),
  outliers: (projectId: string, days: number) =>
    apiClient<Outliers>(
      `/projects/${projectId}/analytics/outliers?days=${days}`,
    ),
};

export const analyticsKeys = {
  summary: (id?: string, days?: number) =>
    ['analytics', 'cost-summary', id, days] as const,
  trend: (id?: string, days?: number) =>
    ['analytics', 'cost-trend', id, days] as const,
  outliers: (id?: string, days?: number) =>
    ['analytics', 'outliers', id, days] as const,
};
