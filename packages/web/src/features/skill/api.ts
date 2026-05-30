import { apiClient } from '@/lib/api/client';
import type { Skill, SkillFile, SkillSyncStatus, BulkPushResult, EffectiveSkill, SkillOverride } from './types';

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

  // EPIC 6 (ISS-278/290) — per-project skill override CRUD.
  getEffective: (projectId: string) =>
    apiClient<EffectiveSkill[]>(
      `/projects/${encodeURIComponent(projectId)}/skills/effective`,
    ).then((data) => ({ data })),

  upsertOverride: (
    projectId: string,
    skillId: string,
    skillMdOverride: string,
    files?: SkillFile[],
  ) =>
    apiClient<SkillOverride>(
      `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/override`,
      {
        method: 'PUT',
        // The route forks the whole global folder when `files` is omitted on
        // create; sending the editor's files[] makes the override carry the
        // authored folder (Skill Studio 3).
        body: JSON.stringify(files ? { skillMdOverride, files } : { skillMdOverride }),
      },
    ).then((data) => ({ data })),

  deleteOverride: (projectId: string, skillId: string) =>
    apiClient<null>(
      `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/override`,
      { method: 'DELETE' },
    ),
};

// ISS-109 — per-project skill-registration CRUD (bind a skill to a stage,
// list current bindings, clear a stage binding).
export interface SkillRegistration {
  stage: string;
  skillId: string;
  skillName: string;
  skillScope: 'global' | 'project';
  registeredBy: string;
  createdAt: string;
}

export const skillRegistrationApi = {
  list: (projectId: string) =>
    apiClient<{ registrations: SkillRegistration[] }>(
      `/projects/${encodeURIComponent(projectId)}/skill-registrations`,
    ),

  register: (projectId: string, skillId: string, stage: string | null) =>
    apiClient<{ projectId: string; skillId: string; stage: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/register`,
      { method: 'POST', body: JSON.stringify({ stage }) },
    ),

  unregister: (projectId: string, stage: string) =>
    apiClient<{ deleted: boolean; stage: string }>(
      `/projects/${encodeURIComponent(projectId)}/skills/registrations/${encodeURIComponent(stage)}`,
      { method: 'DELETE' },
    ),
};
