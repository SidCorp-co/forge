import { apiClient } from '@/lib/api-client';
import type { Agent, AgentSession } from './types';

export const agentApi = {
  getAgents: (projectSlug: string) =>
    apiClient<{ data: Agent[] }>(`/agents?filters[project][slug][$eq]=${projectSlug}`),

  getSessions: (projectSlug: string) =>
    apiClient<{ data: AgentSession[] }>(
      `/agent-sessions?filters[project][slug][$eq]=${projectSlug}&sort=updatedAt:desc&pagination[pageSize]=50`,
    ),

  getSession: (id: string) =>
    apiClient<{ data: AgentSession }>(`/agent-sessions/${id}?populate=*`),

  start: (projectSlug: string, prompt: string, repoPath?: string) =>
    apiClient<{ data: AgentSession }>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, prompt, repoPath }),
    }),

  send: (sessionId: string, message: string, claudeSessionId?: string) =>
    apiClient<{ data: { ok: boolean } }>('/agent-sessions/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, claudeSessionId }),
    }),

  abort: (sessionId: string) =>
    apiClient<{ data: { ok: boolean } }>('/agent-sessions/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),

  desktopStatus: () =>
    apiClient<{ data: { connected: boolean } }>('/agent-sessions/desktop/status'),

  startAgentReview: (projectSlug: string, agentType: string) =>
    apiClient<{ data: AgentSession }>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, type: agentType }),
    }),

  startAgentReindex: (projectSlug: string, agentType: string) =>
    apiClient<{ data: AgentSession }>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, type: `${agentType}-reindex` }),
    }),
};
