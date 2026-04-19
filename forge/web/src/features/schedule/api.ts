import { apiClient } from '@/lib/api/client';
import type { BaseEntity } from '@/lib/types';

export type ScheduleRunner = 'desktop' | 'antigravity';
export type ScheduleStatus = 'success' | 'failed' | 'running' | 'skipped';

export interface Schedule extends BaseEntity {
  name: string;
  cron: string;
  prompt: string;
  runner: ScheduleRunner;
  enabled: boolean;
  targetProjectSlug: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: ScheduleStatus | null;
  lastSessionId: string | null;
  metadata: Record<string, unknown> | null;
  project?: { documentId: string; slug: string; name: string };
}

export interface ScheduleFormData {
  name: string;
  cron: string;
  prompt: string;
  runner: ScheduleRunner;
  enabled: boolean;
  targetProjectSlug?: string;
  metadata?: Record<string, unknown>;
  project?: string;
}

export const scheduleApi = {
  getAll: (projectSlug: string) =>
    apiClient<{ data: Schedule[]; meta: { pagination: { total: number } } }>(
      `/schedules?filters[project][slug][$eq]=${projectSlug}&sort=createdAt:desc`,
    ),

  get: (id: string) => apiClient<{ data: Schedule }>(`/schedules/${id}`),

  create: (data: ScheduleFormData) =>
    apiClient<{ data: Schedule }>('/schedules', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (id: string, data: Partial<ScheduleFormData>) =>
    apiClient<{ data: Schedule }>(`/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  delete: (id: string) =>
    apiClient<{ data: Schedule }>(`/schedules/${id}`, { method: 'DELETE' }),

  run: (id: string) =>
    apiClient<{ data: { sessionId: string; message: string } }>(`/schedules/${id}/run`, {
      method: 'POST',
    }),
};
