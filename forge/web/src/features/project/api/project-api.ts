import { apiClient } from '@/lib/api/client';
import type { Project, ProjectUser, Device, AntigravityRunner, KnowledgeEdge, CloudflareAccount, CloudflareZone, CloudflareDnsRecord } from '../types';

export const projectApi = {
  getAll: () =>
    apiClient<{ data: Project[] }>('/projects?populate=*'),

  getBySlug: (slug: string) =>
    apiClient<{ data: Project[] }>(
      `/projects?filters[slug][$eq]=${slug}&populate=*`
    ).then((res) => ({ data: res.data[0] ?? null })),

  getById: (id: string) =>
    apiClient<{ data: Project }>(`/projects/${id}?populate=*`),

  create: (data: { name: string; slug: string; description?: string }) =>
    apiClient<{ data: Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (id: string, data: Partial<Omit<Project, 'id' | 'slug'>>) =>
    apiClient<{ data: Project }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  addMember: (projectDocId: string, userDocId: string) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { members: { connect: [userDocId] } } }),
    }),

  removeMember: (projectDocId: string, userDocId: string) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { members: { disconnect: [userDocId] } } }),
    }),

  getUsers: (search: string) =>
    apiClient<ProjectUser[]>(
      `/users?filters[username][$containsi]=${encodeURIComponent(search)}`
    ),

  getDevices: () =>
    apiClient<{ data: Device[] }>('/devices'),

  updateDevice: (docId: string, data: Record<string, unknown>) =>
    apiClient<{ data: Device }>(`/devices/${docId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteDevice: (docId: string) =>
    apiClient<{ data: { ok: boolean } }>(`/devices/${docId}`, {
      method: 'DELETE',
    }),

  syncSkillsToDevices: () =>
    apiClient<{ data: { skillCount: number; devices: { deviceId: string; name: string; sent: boolean }[] } }>('/devices/sync-skills', {
      method: 'POST',
    }),

  setDefaultDevice: (projectDocId: string, deviceDocId: string | null) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({
        data: {
          defaultDevice: deviceDocId
            ? { connect: [deviceDocId] }
            : { disconnect: true },
        },
      }),
    }),

  // Antigravity
  antigravityListProjects: () =>
    apiClient<{ data: { total: number; projects?: Array<{ projectId: string; agentId: string }>; projectIds?: string[] } }>('/antigravity/projects'),

  antigravityListAgents: () =>
    apiClient<{ data: Array<{ agentId: string; agentType: string; status: string; projectCount: number; maxProjects: number; offlineSince: string | null }> }>('/antigravity/agents'),

  antigravityCreateProject: (agentId?: string) =>
    apiClient<{ data: any }>(`/antigravity/projects${agentId ? `?agentId=${agentId}` : ''}`, { method: 'POST' }),

  antigravityDeleteProject: (projectId: string) =>
    apiClient<{ data: { ok: boolean } }>(`/antigravity/projects/${projectId}`, { method: 'DELETE' }),

  antigravityTestConnection: (projectId: string) =>
    apiClient<{ data: { ok: boolean; response: string; elapsedSeconds: number } }>(
      `/antigravity/projects/${projectId}/test`,
      { method: 'POST' },
    ),

  antigravitySyncSkills: (projectId: string, projectDocumentId?: string) =>
    apiClient<{ data: { ok: boolean; skillCount: number } }>(
      `/antigravity/projects/${projectId}/sync-skills`,
      {
        method: 'POST',
        body: JSON.stringify({ projectDocumentId }),
      },
    ),

  antigravityInitProject: (repoUrl?: string, projectDocumentId?: string) =>
    apiClient<{ data: { projectId: string } }>(
      '/antigravity/init',
      {
        method: 'POST',
        body: JSON.stringify({ repoUrl, projectDocumentId }),
      },
    ),

  antigravityGetUsage: (projectId: string) =>
    apiClient<{ data: { model: string; refreshLabel: string; segments: number[]; remaining: number; status: 'full' | 'warning' | 'empty' }[] }>(`/antigravity/projects/${projectId}/usage`),

  antigravityGetQuota: () =>
    apiClient<{ data: { models: { model: string; refreshLabel: string; segments: number[]; remaining: number; status: 'full' | 'warning' | 'empty' }[]; fetchedAt: string; error: string | null } }>('/antigravity/quota'),

  antigravityRefreshQuota: () =>
    apiClient<{ data: { models: { model: string; refreshLabel: string; segments: number[]; remaining: number; status: 'full' | 'warning' | 'empty' }[]; fetchedAt: string; error: string | null } }>('/antigravity/quota/refresh', { method: 'POST' }),

  antigravitySyncSkillsToAll: () =>
    apiClient<{ data: { ok: boolean; results: Array<{ projectId: string; antigravityProjectId: string; skillCount: number; error?: string }> } }>(
      '/antigravity/sync-skills-all',
      { method: 'POST' },
    ),

  antigravityInitStatus: (projectId: string) =>
    apiClient<{ data: { status: string; steps: Record<string, string>; errors?: Record<string, string> } }>(
      `/antigravity/init-status/${projectId}`,
    ),

  // Antigravity Runners
  getAntigravityRunners: () =>
    apiClient<{ data: AntigravityRunner[] }>('/antigravity-runners'),

  createAntigravityRunner: (data: { name: string; agentId?: string; endpoint?: string }) =>
    apiClient<{ data: AntigravityRunner }>('/antigravity-runners', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  updateAntigravityRunner: (id: string, data: Partial<{ name: string; agentId: string; endpoint: string }>) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteAntigravityRunner: (id: string) =>
    apiClient<{ data: { ok: boolean } }>(`/antigravity-runners/${id}`, { method: 'DELETE' }),

  antigravityRunnerHealthCheck: (id: string) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}/health-check`, { method: 'POST' }),

  antigravityRunnerRefreshQuota: (id: string) =>
    apiClient<{ data: { models: any[]; fetchedAt: string; error: string | null } }>(`/antigravity-runners/${id}/quota/refresh`, { method: 'POST' }),

  antigravityRunnerListProjects: (id: string) =>
    apiClient<{ data: { total: number; projectIds: string[] } }>(`/antigravity-runners/${id}/projects`),

  excludeAntigravityRunner: (id: string) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}/exclude`, { method: 'POST' }),

  includeAntigravityRunner: (id: string) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}/include`, { method: 'POST' }),

  clearRunnerDepletedModels: (id: string) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}/clear-depleted`, { method: 'POST' }),

  clearRunnerPause: (id: string) =>
    apiClient<{ data: AntigravityRunner }>(`/antigravity-runners/${id}/clear-pause`, { method: 'POST' }),

  antigravitySyncAgents: () =>
    apiClient<{ data: AntigravityRunner[] }>('/antigravity-runners/sync-agents', { method: 'POST' }),

  // Antigravity per-project runner init
  antigravityInitProjectOnRunner: (runnerId: string, repoUrl?: string, projectDocumentId?: string) =>
    apiClient<{ data: { projectId: string; sessionId: string } }>(
      '/antigravity/init',
      {
        method: 'POST',
        body: JSON.stringify({ repoUrl, projectDocumentId, runnerId }),
      },
    ),

  // Knowledge indexing
  indexCodebase: (projectDocumentId: string) =>
    apiClient<{ data: { sessionId: string; alreadyRunning?: boolean } }>(
      '/agent-sessions/index-codebase',
      {
        method: 'POST',
        body: JSON.stringify({ projectDocumentId }),
      },
    ),

  // Knowledge
  getKnowledgeEdges: (projectDocId: string) =>
    apiClient<{ data: KnowledgeEdge[] }>(
      `/knowledge-edges?filters[project][$eq]=${projectDocId}&pagination[pageSize]=1000`
    ),

  // Device init
  deviceInitProject: (deviceDocId: string, projectDocId: string, repoUrl?: string) =>
    apiClient<{ data: { sessionId: string; targetPath: string } }>(`/devices/${deviceDocId}/init-project`, {
      method: 'POST',
      body: JSON.stringify({ projectDocumentId: projectDocId, repoUrl }),
    }),

  deviceInitStatus: (deviceDocId: string, projectSlug: string) =>
    apiClient<{ data: { status: string; steps: Record<string, string>; errors?: Record<string, string>; targetPath?: string } }>(
      `/devices/${deviceDocId}/init-status/${projectSlug}`,
    ),

  // Cloudflare Accounts
  getCloudflareAccounts: () =>
    apiClient<{ data: CloudflareAccount[] }>('/cloudflare-accounts'),

  createCloudflareAccount: (data: { name: string; accountId: string; apiToken: string }) =>
    apiClient<{ data: CloudflareAccount }>('/cloudflare-accounts', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  updateCloudflareAccount: (docId: string, data: Partial<{ name: string; accountId: string; apiToken: string }>) =>
    apiClient<{ data: CloudflareAccount }>(`/cloudflare-accounts/${docId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteCloudflareAccount: (docId: string) =>
    apiClient<{ data: { ok: boolean } }>(`/cloudflare-accounts/${docId}`, {
      method: 'DELETE',
    }),

  validateCloudflareAccount: (docId: string) =>
    apiClient<{ data: { status: string; lastValidated: string; validationError?: string } }>(
      `/cloudflare-accounts/${docId}/validate`,
      { method: 'POST' },
    ),

  // Cloudflare API proxy
  getCloudflareZones: (docId: string) =>
    apiClient<{ data: CloudflareZone[] }>(`/cloudflare-accounts/${docId}/zones`),

  getCloudflareDns: (docId: string, zoneId: string) =>
    apiClient<{ data: CloudflareDnsRecord[] }>(`/cloudflare-accounts/${docId}/zones/${zoneId}/dns`),

  createCloudflareDns: (docId: string, zoneId: string, data: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number }) =>
    apiClient<{ data: { id: string; type: string; name: string; content: string; status: string } }>(
      `/cloudflare-accounts/${docId}/zones/${zoneId}/dns`,
      { method: 'POST', body: JSON.stringify({ data }) },
    ),

  updateCloudflareDns: (docId: string, zoneId: string, recordId: string, data: Partial<{ type: string; name: string; content: string; ttl: number; proxied: boolean; priority: number }>) =>
    apiClient<{ data: { id: string; name: string; status: string } }>(
      `/cloudflare-accounts/${docId}/zones/${zoneId}/dns/${recordId}`,
      { method: 'PUT', body: JSON.stringify({ data }) },
    ),

  deleteCloudflareDns: (docId: string, zoneId: string, recordId: string) =>
    apiClient<{ data: { id: string; status: string } }>(
      `/cloudflare-accounts/${docId}/zones/${zoneId}/dns/${recordId}`,
      { method: 'DELETE' },
    ),

  purgeCloudflareCache: (docId: string, zoneId: string) =>
    apiClient<{ data: { zone: string; status: string } }>(
      `/cloudflare-accounts/${docId}/zones/${zoneId}/purge`,
      { method: 'POST' },
    ),
};
