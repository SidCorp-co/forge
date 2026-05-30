// web-v2 feature module: projects — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Routes verified against
// `packages/core/src/projects/routes.ts` for ISS-288.
import { apiClient } from '@/lib/api/client';
import type { ProjectDetail, ProjectHealthRow, ProjectListItem } from './types';

export const projectApi = {
  /** `GET /api/projects` — the caller's projects (with membership role). */
  list: () => apiClient<ProjectListItem[]>('/projects'),

  /** `GET /api/projects/health` — per-project pipeline health rollup. */
  health: () => apiClient<ProjectHealthRow[]>('/projects/health'),

  /** `GET /api/projects/:id` — full project detail (members/labels/devices). */
  getById: (id: string) => apiClient<ProjectDetail>(`/projects/${id}`),
};
