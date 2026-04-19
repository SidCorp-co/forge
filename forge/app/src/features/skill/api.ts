import { apiClient } from '@/lib/api-client';
import type { Skill, SkillSyncStatus, BulkPushResult } from './types';

export const skillApi = {
  getAll: async (projectDocumentId?: string) => {
    const res = await apiClient<{ data: Skill[] }>('/skills?populate=project&pagination[pageSize]=100');
    if (!projectDocumentId) return res;
    return {
      data: res.data.filter(
        (s) => s.isGlobal || s.project?.documentId === projectDocumentId,
      ),
    };
  },

  getOne: (documentId: string) =>
    apiClient<{ data: Skill }>(`/skills/${documentId}?populate=project`),

  create: (data: {
    name: string;
    description: string;
    skillMd: string;
    target?: 'dev' | 'cloud' | 'all';
    isGlobal?: boolean;
    files?: Array<{ path: string; content: string; encoding: string }>;
    project?: { documentId: string };
  }) =>
    apiClient<{ data: Skill }>('/skills', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (documentId: string, data: Partial<Pick<Skill, 'name' | 'description' | 'skillMd' | 'target' | 'isGlobal' | 'files'>>) =>
    apiClient<{ data: Skill }>(`/skills/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  delete: (documentId: string) =>
    apiClient(`/skills/${documentId}`, { method: 'DELETE' }),

  syncStatus: (projectDocumentId: string) =>
    apiClient<{ data: SkillSyncStatus[] }>('/skills/sync-status', {
      method: 'POST',
      body: JSON.stringify({ projectDocumentId }),
    }),

  bulkPush: (targets: string[], projectDocumentId: string, skillNames?: string[]) =>
    apiClient<{ data: { results: BulkPushResult[] } }>('/skills/bulk-push', {
      method: 'POST',
      body: JSON.stringify({ targets, projectDocumentId, skillNames }),
    }),
};
