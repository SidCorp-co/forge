import type {
  CreateProjectInput,
  Project,
  ProjectMember,
  UpdateProjectInput,
} from '@forge/contracts';
import { apiClient } from '@/lib/api/client';

/**
 * Core's project detail response shape. The server returns the project row
 * plus embedded members + labels arrays. We re-type here because
 * `@forge/contracts` only exposes raw row types — not the hand-rolled
 * detail projection.
 */
export interface ProjectDetail extends Project {
  members: Array<Pick<ProjectMember, 'userId' | 'role'>>;
  labels: Array<{ id: string; name: string; color: string | null }>;
}

export const projectApi = {
  list: () => apiClient<Project[]>('/projects'),

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

  addMember: (
    projectId: string,
    body: { userId: string; role?: 'member' | 'owner' },
  ) =>
    apiClient<ProjectMember>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeMember: (projectId: string, userId: string) =>
    apiClient<void>(`/projects/${projectId}/members/${userId}`, {
      method: 'DELETE',
    }),
};
