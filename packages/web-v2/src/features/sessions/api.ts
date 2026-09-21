import { apiClient, apiClientList } from "@/lib/api/client";
import type { QueueStats, SessionCost, SessionRow } from "./types";

export const SESSIONS_PAGE_SIZE = 50;

export interface ListSessionsOpts {
  projectId?: string;
  status?: string;
  metadataType?: string;
  page?: number;
  pageSize?: number;
}

export const sessionsApi = {
  list: ({
    projectId,
    status,
    metadataType,
    page = 1,
    pageSize = SESSIONS_PAGE_SIZE,
  }: ListSessionsOpts) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (projectId) params.set("projectId", projectId);
    if (status) params.set("status", status);
    if (metadataType) params.set("metadataType", metadataType);
    return apiClientList<SessionRow>(`/agent-sessions?${params}`);
  },

  queueStats: (projectId: string) =>
    apiClient<QueueStats>(`/agent-sessions/queue-stats?projectId=${encodeURIComponent(projectId)}`),

  /** `POST /api/agent-sessions/sweep-zombies?projectId=` — owner/admin only. */
  sweepZombies: (projectId: string) =>
    apiClient<{ queueTimedOut: number; heartbeatTimedOut: number }>(
      `/agent-sessions/sweep-zombies?projectId=${encodeURIComponent(projectId)}`,
      { method: "POST" },
    ),

  /** `GET /:id/cost` — per-session usage_records rollup (ISS-378 AC#6). */
  cost: (id: string) => apiClient<SessionCost>(`/agent-sessions/${id}/cost`),

  /** `POST /:id/cancel` — queued/running/idle → failed (user_cancelled). */
  cancel: (id: string) =>
    apiClient<SessionRow>(`/agent-sessions/${id}/cancel`, { method: "POST" }),

  /** `POST /:id/retry` — pipeline/pm sessions only; else 400. */
  retry: (id: string) =>
    apiClient<{ ok: boolean; issueId: string }>(`/agent-sessions/${id}/retry`, { method: "POST" }),

  /** `POST /:id/rerun` — clones into a fresh session. */
  rerun: (id: string) =>
    apiClient<{ id: string }>(`/agent-sessions/${id}/rerun`, { method: "POST" }),

  /** `POST /abort` — body { sessionId } → status idle. */
  abort: (sessionId: string) =>
    apiClient<{ ok: boolean }>("/agent-sessions/abort", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
};
