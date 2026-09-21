import { apiClient } from '@/lib/api/client';
import type {
  CreatedProject,
  CreateProjectInput,
  OnboardResult,
  ProjectDetail,
  ProjectHealthRow,
  ProjectListItem,
} from './types';

export const projectApi = {
  list: (opts?: { includeArchived?: boolean }) =>
    apiClient<ProjectListItem[]>(`/projects${opts?.includeArchived ? '?archived=1' : ''}`),

  create: (body: CreateProjectInput) =>
    apiClient<CreatedProject>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `GET /api/projects/health` — per-project pipeline health rollup. */
  health: () => apiClient<ProjectHealthRow[]>('/projects/health'),

  /** `GET /api/projects/:id` — full project detail (members/labels/devices). */
  getById: (id: string) => apiClient<ProjectDetail>(`/projects/${id}`),

  onboard: (id: string) =>
    apiClient<OnboardResult>(`/projects/${id}/onboard`, { method: 'POST' }),
};
