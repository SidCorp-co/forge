import { apiClient } from '@/lib/api/client';

export type ScheduleRunner = 'desktop' | 'antigravity';
export type ScheduleStatus = 'success' | 'failed' | 'running' | 'skipped';

export interface Schedule {
  id: string;
  projectId: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreatePayload {
  projectId: string;
  name: string;
  cron: string;
  prompt: string;
  runner?: ScheduleRunner;
  enabled?: boolean;
  targetProjectSlug?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type ScheduleUpdatePayload = Partial<Omit<ScheduleCreatePayload, 'projectId'>>;

export const scheduleApi = {
  list: (projectId: string) =>
    apiClient<Schedule[]>(`/schedules?projectId=${encodeURIComponent(projectId)}`),

  get: (id: string) => apiClient<Schedule>(`/schedules/${id}`),

  create: (data: ScheduleCreatePayload) =>
    apiClient<Schedule>('/schedules', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: ScheduleUpdatePayload) =>
    apiClient<Schedule>(`/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) => apiClient<null>(`/schedules/${id}`, { method: 'DELETE' }),

  run: (id: string) =>
    apiClient<{ sessionId: string; jobId: string; message: string }>(`/schedules/${id}/run`, {
      method: 'POST',
    }),
};
