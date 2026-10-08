import { missingWorkStateKey } from '@forge/contracts/work-state';
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
  health: async () => {
    const rows = await apiClient<ProjectHealthRow[]>('/projects/health');
    for (const row of rows) {
      const missing = missingWorkStateKey(row.work);
      if (missing !== null) {
        throw new Error(
          `GET /projects/health: the row for \`${row.projectSlug}\` has no count for the work state \`${missing}\` in \`work\`, so the server predates the work states and no figure can be drawn from it. Reload once the server has been updated.`,
        );
      }
    }
    return rows;
  },

  /** `GET /api/projects/:id` — full project detail (members/labels/devices). */
  getById: (id: string) => apiClient<ProjectDetail>(`/projects/${id}`),

  onboard: (id: string) =>
    apiClient<OnboardResult>(`/projects/${id}/onboard`, { method: 'POST' }),
};
