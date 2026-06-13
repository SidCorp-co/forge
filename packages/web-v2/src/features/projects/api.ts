// web-v2 feature module: projects — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Routes verified against
// `packages/core/src/projects/routes.ts` for ISS-288.
import { apiClient } from '@/lib/api/client';
import type {
  BootstrapResult,
  CreatedProject,
  CreateProjectInput,
  ProjectDetail,
  ProjectHealthRow,
  ProjectListItem,
} from './types';

export const projectApi = {
  /** `GET /api/projects` — the caller's projects (with membership role).
   *  `includeArchived` adds `?archived=1` to return archived projects too
   *  (ISS-353) — used by Project Settings to keep an archived project
   *  reachable for unarchive. */
  list: (opts?: { includeArchived?: boolean }) =>
    apiClient<ProjectListItem[]>(`/projects${opts?.includeArchived ? '?archived=1' : ''}`),

  /** `POST /api/projects` — create a project (caller becomes owner). 201 on
   *  success; 409 `SLUG_TAKEN` when the slug collides. */
  create: (body: CreateProjectInput) =>
    apiClient<CreatedProject>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `GET /api/projects/health` — per-project pipeline health rollup. */
  health: () => apiClient<ProjectHealthRow[]>('/projects/health'),

  /** `GET /api/projects/:id` — full project detail (members/labels/devices). */
  getById: (id: string) => apiClient<ProjectDetail>(`/projects/${id}`),

  /** `POST /api/projects/:id/skills/bootstrap` — seed the stage-mapped
   *  `forge-*` skills + the Balanced pipeline preset (ISS-453 onboarding).
   *  Idempotent: re-running returns `alreadyBootstrapped: true`. The server
   *  owns `pipelineConfig.states` — never send a partial config from here. */
  bootstrap: (id: string) =>
    apiClient<BootstrapResult>(`/projects/${id}/skills/bootstrap`, { method: 'POST' }),
};
