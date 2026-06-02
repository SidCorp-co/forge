import type {
  BindRunnerResponse,
  CreateProjectInput,
  Project,
  ProjectMember,
  UpdateProjectInput,
} from '@forge/contracts';
import { apiClient } from '@/lib/api/client';

/**
 * Core's project detail response shape. The server returns the project row
 * plus embedded members + labels + devicePool arrays. We re-type here because
 * `@forge/contracts` only exposes raw row types — not the hand-rolled
 * detail projection.
 */
export interface ProjectDetail extends Project {
  members: Array<Pick<ProjectMember, 'userId' | 'role'>>;
  labels: Array<{ id: string; name: string; color: string | null }>;
  devicePool: Array<{
    id: string;
    name: string;
    platform: string;
    status: string;
    lastSeenAt: string | null;
    runnerId: string;
  }>;
}

/**
 * Mirrors the response of `GET /api/projects/health` (see
 * `packages/core/src/projects/health-routes.ts`).
 */
export interface ProjectHealthRow {
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
}

export const projectApi = {
  // `includeArchived` adds `?archived=1` so the Archived view can list
  // soft-archived projects; the default call omits them (ISS-353).
  list: (opts?: { includeArchived?: boolean }) =>
    apiClient<Project[]>(`/projects${opts?.includeArchived ? '?archived=1' : ''}`),

  health: () => apiClient<ProjectHealthRow[]>('/projects/health'),

  getById: (id: string) => apiClient<ProjectDetail>(`/projects/${id}`),

  create: (input: CreateProjectInput) =>
    apiClient<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: UpdateProjectInput) =>
    apiClient<Project>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  remove: (id: string) =>
    apiClient<void>(`/projects/${id}`, { method: 'DELETE' }),

  // ISS-353 — soft archive / unarchive. Owner-only on the server (403 for
  // non-owners). Non-destructive; the returned row carries the new
  // `archivedAt` state.
  archive: (id: string) =>
    apiClient<Project>(`/projects/${id}/archive`, { method: 'POST' }),

  unarchive: (id: string) =>
    apiClient<Project>(`/projects/${id}/unarchive`, { method: 'POST' }),

  removeMember: (projectId: string, userId: string) =>
    apiClient<void>(`/projects/${projectId}/members/${userId}`, {
      method: 'DELETE',
    }),

  inviteMember: (
    projectId: string,
    body: { email: string; role?: 'admin' | 'member' },
  ) =>
    apiClient<{ token: string; expiresAt: string }>(
      `/projects/${projectId}/members/invite`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  bindRunner: (
    projectId: string,
    body: {
      deviceId: string;
      capabilities?: Record<string, unknown>;
      repoPath?: string | null;
      branch?: string | null;
    },
  ) =>
    apiClient<BindRunnerResponse>(`/projects/${projectId}/runners`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ISS-271 — set/clear the per-device repo path + branch on a runner row.
  // ISS-273 (web UX) wires this into the project settings form.
  patchRunner: (
    projectId: string,
    runnerId: string,
    body: {
      repoPath?: string | null;
      branch?: string | null;
      capabilities?: Record<string, unknown>;
    },
  ) =>
    apiClient<BindRunnerResponse>(
      `/projects/${projectId}/runners/${runnerId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  unbindRunner: (projectId: string, runnerId: string) =>
    apiClient<void>(`/projects/${projectId}/runners/${runnerId}`, {
      method: 'DELETE',
    }),
};
