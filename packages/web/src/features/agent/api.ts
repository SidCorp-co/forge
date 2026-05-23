import { apiClient, apiClientList } from '@/lib/api/client';
import type { BaseEntity } from '@/lib/types';

export const AGENT_SESSIONS_PAGE_SIZE = 50;

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

/**
 * Page-scoped context auto-injected by the project chat bubble. Core prepends
 * a `[Context: …]` line to the user message and stores the same shape under
 * `metadata.pageContext` so the agent grounds replies without the user typing
 * `ISS-XX` by hand. Keep in sync with `pageContextSchema` in
 * `packages/core/src/agent-sessions/routes.ts`.
 */
export interface PageContext {
  page: string;
  issueId?: string;
  issueDisplayId?: string;
  issueTitle?: string;
  issueStatus?: string;
}

// ISS-197 — `completed_via_recovery` / `cancelled_stale` are non-failure
// terminal markers written by the recovery-by-verification path. UI filters
// treat them as success states, NOT failures.
export type AgentSessionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'completed_via_recovery'
  | 'cancelled_stale';

// ISS-197 — populated by the retry engine on every failure. Drives the
// sessions-panel badge: "Failed 3x (2 transient, 1 timeout)".
export type FailureKind =
  | 'transient'
  | 'permission'
  | 'permanent'
  | 'timeout'
  | 'unknown';

export interface RecoveryStats {
  totalFailures: number;
  byKind: {
    transient: number;
    permission: number;
    permanent: number;
    timeout: number;
  };
  lastFailureAt: string;
  lastFailureKind: FailureKind;
  autoRetries: number;
}

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
  | 'migration_zombie_cleanup'
  // ISS-40 PR-E dispatcher gating skip-reasons. Sessions with these stay
  // queued (they're not terminal) — only the surface signal flips so the
  // UI can render a useful tooltip.
  | 'issue_busy'
  | 'waiting_on_dep'
  | 'project_full'
  | 'runner_full';

export interface PipelineHealth {
  retryCount: number;
  recoveryStats: RecoveryStats;
  lastError: { message: string; ts: string; jobId: string | null } | null;
  updatedAt: string;
}

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
  // ISS-197 — recovery counters populated by the retry engine on every
  // failure. Null on rows that haven't failed yet.
  pipelineHealth?: PipelineHealth | null;
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

  // Offset-paginated variant used by the sidebar's infinite-scroll. Reads
  // `X-Total-Count` via apiClientList so the hook can stop requesting pages.
  getSessionsPage: (
    projectId: string,
    { page, pageSize }: { page: number; pageSize: number },
  ): Promise<{
    items: AgentSessionSummary[];
    total: number;
    nextPage: number | null;
  }> => {
    const params = new URLSearchParams({
      projectId,
      page: String(page),
      pageSize: String(pageSize),
    });
    return apiClientList<Record<string, unknown>>(`/agent-sessions?${params}`).then(
      ({ items, totalCount }) => {
        const mapped = items.map((r) => ({
          ...(r as object),
          documentId: r['id'] as string,
        })) as unknown as AgentSessionSummary[];
        const hasMore = mapped.length === pageSize && page * pageSize < totalCount;
        return {
          items: mapped,
          total: totalCount,
          nextPage: hasMore ? page + 1 : null,
        };
      },
    );
  },

  getSession: (id: string) =>
    apiClient<Record<string, unknown>>(`/agent-sessions/${id}`).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  // Core returns the flat agent_sessions row with `id` (uuid). Wrap it in
  // the Strapi envelope `{data: {...documentId}}` so existing callers that
  // read `result.data.documentId` keep working unchanged.
  start: (opts: {
    projectSlug: string;
    prompt: string;
    repoPath?: string;
    preBuilt?: boolean;
    issueIds?: string[];
    pageContext?: PageContext;
  }) =>
    apiClient<Record<string, unknown>>('/agent-sessions/start', {
      method: 'POST',
      body: JSON.stringify(opts),
    }).then((row) => ({
      data: { ...(row as object), documentId: row['id'] as string } as unknown as AgentSession,
    })),

  send: (opts: {
    sessionId: string;
    message: string;
    claudeSessionId?: string;
    pageContext?: PageContext;
  }) =>
    apiClient<{ ok: boolean }>('/agent-sessions/send', {
      method: 'POST',
      body: JSON.stringify(opts),
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

  getTurns: (sessionId: string, opts?: { after?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.after) params.set('after', opts.after);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiClient<{ turns: AgentSessionTurn[]; nextCursor: string | null }>(
      `/agent-sessions/${sessionId}/turns${qs ? `?${qs}` : ''}`,
    );
  },

  editTurn: (sessionId: string, turnId: string, body: { content: string; expectedEditedAt?: string }) =>
    apiClient<AgentSessionTurn>(`/agent-sessions/${sessionId}/turns/${turnId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  regenerateTurn: (sessionId: string, turnId: string) =>
    apiClient<{ status: string }>(`/agent-sessions/${sessionId}/turns/${turnId}/regenerate`, {
      method: 'POST',
    }),

  forkSession: (sessionId: string, fromTurnId: string, title?: string) =>
    apiClient<NewSessionResponse>(`/agent-sessions/${sessionId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ fromTurnId, ...(title ? { title } : {}) }),
    }).then((row) => ({ documentId: row.id })),

  rerunSession: (sessionId: string) =>
    apiClient<NewSessionResponse>(`/agent-sessions/${sessionId}/rerun`, {
      method: 'POST',
    }).then((row) => ({ documentId: row.id })),
};

/** Minimal shape returned by /fork and /rerun — flat row from core, not the
 * AgentSession contract. Only the id is used by the web hook to navigate. */
interface NewSessionResponse {
  id: string;
}

/** Materialized turn row served by GET /:id/turns. Mirror of agent_session_turns. */
export interface AgentSessionTurn {
  id: string;
  agentSessionId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  content: { value: unknown };
  parentTurnId: string | null;
  createdAt: string;
  editedAt: string | null;
}
