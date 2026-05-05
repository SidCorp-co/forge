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

export type AgentSessionStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed';

// Synthetic UI-only state derived from heartbeat freshness. Backend
// persists `running`; the `stalled` distinction is presentational only.
export type AgentSessionDisplayStatus = AgentSessionStatus | 'stalled';

export const STALLED_THRESHOLD_MS = 60_000;

export type SessionFailureReason =
  | 'queue_timeout'
  | 'heartbeat_timeout'
  | 'no_worker_online'
  | 'user_cancelled'
  | 'job_failed'
  | 'migration_zombie_cleanup';

export interface AgentSession {
  documentId: string;
  title: string;
  status: AgentSessionStatus;
  messages: any[];
  claudeSessionId?: string;
  repoPath?: string;
  usage?: AgentUsage;
  metadata?: Record<string, unknown>;
  diff?: BranchDiff | null;
  user?: { id: number; documentId: string; username: string };
  // Lifecycle stamps — null on pre-migration rows + interactive sessions.
  dispatchedAt?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  failureReason?: SessionFailureReason | string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentSessionSummary = Omit<AgentSession, 'messages'>;

/**
 * Promote `running` → `stalled` when no heartbeat for STALLED_THRESHOLD_MS.
 * Warning band between "fresh" and the sweeper's heartbeat_timeout cutoff.
 */
export function deriveSessionDisplayStatus(
  session: Pick<
    AgentSession,
    'status' | 'lastHeartbeatAt' | 'startedAt' | 'updatedAt'
  >,
  nowMs: number = Date.now(),
): AgentSessionDisplayStatus {
  if (session.status !== 'running') return session.status;
  const lastSignal =
    session.lastHeartbeatAt ?? session.startedAt ?? session.updatedAt;
  if (!lastSignal) return 'running';
  const lastMs = new Date(lastSignal).getTime();
  if (Number.isNaN(lastMs)) return 'running';
  return nowMs - lastMs > STALLED_THRESHOLD_MS ? 'stalled' : 'running';
}

/**
 * Interactive agent runs (start / send / abort / build-prompt) ship with
 * v0.1.9 (ISS-300). Core publishes `agent:start | agent:send | agent:abort |
 * agent:review | agent:reindex | agent:build-prompt` events to the device's
 * WS room; packages/dev (Tauri) listens for these events and drives the local
 * Claude CLI. Streaming responses come back via the project + session rooms.
 */
export const AGENT_INTERACTIVE_ENABLED = true;

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

  // Core returns the flat agent_sessions row with `id` (uuid). Wrap it in
  // the Strapi envelope `{data: {...documentId}}` so existing callers that
  // read `result.data.documentId` keep working unchanged.
  start: (projectSlug: string, prompt: string, repoPath?: string, preBuilt?: boolean, issueIds?: string[]) =>
    apiClient<Record<string, unknown>>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, prompt, repoPath, preBuilt, issueIds }),
    }).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  send: (sessionId: string, message: string, claudeSessionId?: string) =>
    apiClient<{ ok: boolean }>('/agent-sessions/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, claudeSessionId }),
    }).then((row) => ({ data: row })),

  abort: (sessionId: string) =>
    apiClient<{ ok: boolean }>('/agent-sessions/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }).then((row) => ({ data: row })),

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
    apiClient<{ requestId: string }>('/agent-sessions/build-prompt', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, issueIds }),
    }).then((row) => ({ data: row })),

  startAgentReview: (projectSlug: string, agentType: string) =>
    apiClient<Record<string, unknown>>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, type: agentType }),
    }).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  startAgentReindex: (projectSlug: string, agentType: string) =>
    apiClient<Record<string, unknown>>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectSlug, type: `${agentType}-reindex` }),
    }).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  triggerPipeline: (issueDocumentId: string) =>
    apiClient<{ data: { ok: boolean; status: string; sessionDocumentId: string | null } }>('/agent-sessions/trigger-pipeline', {
      method: 'POST',
      body: JSON.stringify({ issueDocumentId }),
    }),

  cancelSession: (sessionId: string) =>
    apiClient<AgentSession>(`/agent-sessions/${sessionId}/cancel`, { method: 'POST' }),

  retrySession: (sessionId: string) =>
    apiClient<{ ok: boolean; issueId: string }>(`/agent-sessions/${sessionId}/retry`, {
      method: 'POST',
    }),

  queueStats: (projectId: string) =>
    apiClient<{
      devices: { deviceId: string | null; queued: number; running: number }[];
    }>(`/agent-sessions/queue-stats?projectId=${encodeURIComponent(projectId)}`),

  sweepZombies: (projectId: string) =>
    apiClient<{ queueTimedOut: number; heartbeatTimedOut: number }>(
      `/agent-sessions/sweep-zombies?projectId=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
};
