import { apiClient } from '@/lib/api/client';
import type { BaseEntity } from '@/lib/types';

export type AgentSchedule = 'off' | 'weekly' | 'biweekly' | 'monthly';
export type AgentApprovalMode = 'preview' | 'auto-create';

export interface AgentDefinition extends BaseEntity {
  name: string;
  type: string;
  description: string | null;
  promptTemplate: string;
  reindexPromptTemplate: string | null;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: AgentSchedule;
  approvalMode: AgentApprovalMode;
  maxProposals: number;
  excludeCategories: string[];
}

export interface Agent extends BaseEntity {
  name: string;
  type: string;
  enabled: boolean;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: AgentSchedule;
  approvalMode: AgentApprovalMode;
  maxProposals: number;
  excludeCategories: string[];
  promptTemplate: string | null;
  reindexPromptTemplate: string | null;
  definition?: AgentDefinition | null;
}

export interface AgentUsage {
  contextUsed: number;   // Last turn's full context (input + cacheRead + cacheWrite)
  inputTotal: number;    // Cumulative non-cached input tokens
  outputTotal: number;   // Cumulative output tokens
  cacheRead: number;     // Cumulative cache-read tokens
  cacheWrite: number;    // Cumulative cache-creation tokens
  turns: number;
}

export interface FileDiff {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: { header: string; lines: { kind: string; content: string }[] }[];
}

export interface BranchDiff {
  branch: string;
  base: string;
  files: FileDiff[];
  total_additions: number;
  total_deletions: number;
}

export interface AgentSession {
  documentId: string;
  title: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  messages: any[];
  claudeSessionId?: string;
  repoPath?: string;
  usage?: AgentUsage;
  metadata?: Record<string, unknown>;
  diff?: BranchDiff | null;
  user?: { id: number; documentId: string; username: string };
  createdAt: string;
  updatedAt: string;
}

export type AgentSessionSummary = Omit<AgentSession, 'messages'>;

export const agentApi = {
  // Agent CRUD
  getAgents: (projectSlug: string) =>
    apiClient<{ data: Agent[] }>(`/agents?filters[project][slug][$eq]=${projectSlug}`),

  getAgent: (id: string) =>
    apiClient<{ data: Agent }>(`/agents/${id}`),

  createAgent: (data: Partial<Agent> & { project: string }) =>
    apiClient<{ data: Agent }>('/agents', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  updateAgent: (id: string, data: Partial<Agent>) =>
    apiClient<{ data: Agent }>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteAgent: (id: string) =>
    apiClient<{ data: Agent }>(`/agents/${id}`, { method: 'DELETE' }),

  // Agent sessions
  getSessions: (projectSlug: string, search?: string) => {
    const params = new URLSearchParams({
      'filters[project][slug][$eq]': projectSlug,
      'sort': 'updatedAt:desc',
      'pagination[pageSize]': '50',
    });
    if (search?.trim()) params.set('search', search.trim());
    return apiClient<{ data: AgentSessionSummary[] }>(`/agent-sessions?${params}`);
  },

  getSession: (id: string) =>
    apiClient<{ data: AgentSession }>(`/agent-sessions/${id}?populate=*`),

  start: (projectSlug: string, prompt: string, repoPath?: string, preBuilt?: boolean, issueIds?: string[]) =>
    apiClient<{ data: AgentSession }>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, prompt, repoPath, preBuilt, issueIds }),
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

  desktopStatus: (opts?: { deviceId?: string; projectSlug?: string }) => {
    const params = new URLSearchParams();
    if (opts?.deviceId) params.set('deviceId', opts.deviceId);
    if (opts?.projectSlug) params.set('projectSlug', opts.projectSlug);
    const qs = params.toString();
    return apiClient<{ data: { connected: boolean } }>(
      `/agent-sessions/desktop/status${qs ? `?${qs}` : ''}`
    );
  },

  buildPrompt: (projectSlug: string, issueIds: string[]) =>
    apiClient<{ data: { requestId: string } }>('/agent-sessions/build-prompt', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, issueIds }),
    }),

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

  triggerPipeline: (issueDocumentId: string) =>
    apiClient<{ data: { ok: boolean; status: string; sessionDocumentId: string | null } }>('/agent-sessions/trigger-pipeline', {
      method: 'POST',
      body: JSON.stringify({ issueDocumentId }),
    }),
};
