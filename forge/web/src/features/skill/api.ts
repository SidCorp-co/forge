import { apiClient } from '@/lib/api/client';
import type { Skill, SkillSyncStatus, BulkPushResult } from './types';

export const skillApi = {
  getAll: (projectId?: string) => {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '?scope=global';
    return apiClient<Skill[]>(`/skills${qs}`).then((data) => ({ data }));
  },

  getOne: (id: string) =>
    apiClient<Skill>(`/skills/${id}`).then((data) => ({ data })),

  create: (data: {
    name: string;
    description: string;
    skillMd: string;
    target?: 'dev' | 'cloud' | 'all';
    isGlobal?: boolean;
    files?: Array<{ path: string; content: string; encoding: string }>;
    projectId?: string;
  }) =>
    apiClient<Skill>('/skills', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((res) => ({ data: res })),

  update: (
    id: string,
    data: Partial<Pick<Skill, 'name' | 'description' | 'skillMd' | 'target' | 'isGlobal' | 'files' | 'localGuide'>>,
  ) =>
    apiClient<Skill>(`/skills/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }).then((res) => ({ data: res })),

  delete: (id: string) =>
    apiClient<null>(`/skills/${id}`, { method: 'DELETE' }),

  syncStatus: (projectId: string) =>
    apiClient<SkillSyncStatus[]>('/skills/sync-status', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }).then((data) => ({ data })),

  bulkPush: (targets: string[], projectId: string, skillNames?: string[]) =>
    apiClient<{ results: BulkPushResult[] }>('/skills/bulk-push', {
      method: 'POST',
      body: JSON.stringify({ targets, projectId, skillNames }),
    }).then((res) => ({ data: res })),
};
