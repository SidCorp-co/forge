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

/**
 * Interactive agent runs (start / send / abort) live on the device-runner job
 * queue, which is not yet wired through forge/core's REST surface — the
 * `/agent-sessions/start|send|abort` paths below 404 against the current core.
 * The agent page is read-only for v0.1.0; gate any UI that triggers these
 * endpoints behind this flag. Flip to `true` when the job-queue endpoints land.
 */
export const AGENT_INTERACTIVE_ENABLED = false;

function adaptAgent(row: Record<string, unknown>): Agent {
  // core returns flat rows with `id` (uuid). Existing components read `documentId` —
  // mirror id → documentId so the rest of the agent UI keeps working unchanged.
  // Keep the original uuid string on `id` too so callers that read either field
  // get the canonical identifier instead of `0`.
  const id = row['id'] as string;
  return {
    ...(row as object),
    id: id as unknown as number,
    documentId: id,
  } as unknown as Agent;
}

export const agentApi = {
  // Agent CRUD
  getAgents: (projectId: string) =>
    apiClient<Record<string, unknown>[]>(`/agents?projectId=${encodeURIComponent(projectId)}`)
      .then((rows) => ({ data: rows.map(adaptAgent) })),

  getAgent: (id: string) =>
    apiClient<Record<string, unknown>>(`/agents/${id}`).then((row) => ({
      data: adaptAgent(row),
    })),

  createAgent: (
    data: Partial<Agent> & { projectId: string; name: string; type: string },
  ) =>
    apiClient<Record<string, unknown>>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((row) => ({ data: adaptAgent(row) })),

  updateAgent: (id: string, data: Partial<Agent>) =>
    apiClient<Record<string, unknown>>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }).then((row) => ({ data: adaptAgent(row) })),

  deleteAgent: (id: string) =>
    apiClient<null>(`/agents/${id}`, { method: 'DELETE' }),

  // Agent sessions
  getSessions: (projectId: string, _search?: string) => {
    const params = new URLSearchParams({ projectId, pageSize: '50' });
    return apiClient<Record<string, unknown>[]>(`/agent-sessions?${params}`).then(
      (rows) => ({
        data: rows.map((r) => ({
          ...(r as object),
          documentId: r['id'] as string,
        })) as unknown as AgentSessionSummary[],
      }),
    );
  },

  getSession: (id: string) =>
    apiClient<Record<string, unknown>>(`/agent-sessions/${id}`).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  // TODO(v0.1.x): wire start/send/abort once core exposes these endpoints
  start: (projectSlug: string, prompt: string, repoPath?: string, preBuilt?: boolean, issueIds?: string[]) =>
    apiClient<{ data: AgentSession }>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, prompt, repoPath, preBuilt, issueIds }),
    }),

  // TODO(v0.1.x): wire start/send/abort once core exposes these endpoints
  send: (sessionId: string, message: string, claudeSessionId?: string) =>
    apiClient<{ data: { ok: boolean } }>('/agent-sessions/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, claudeSessionId }),
    }),

  // TODO(v0.1.x): wire start/send/abort once core exposes these endpoints
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
