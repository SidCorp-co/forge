// web-v2 feature module: session (detail) — REST surface. All calls go through
// the shared `apiClient` (no raw fetch). Routes verified against
// `packages/core/src/agent-sessions/routes.ts` for ISS-292.
import { apiClient, apiClientList } from "@/lib/api/client";
import type { SessionMetadata, SessionRow } from "@/features/sessions/types";
import type { TurnRow, TurnsResponse } from "./types";

export interface GetTurnsOpts {
  /** Cursor — a turn id; returns turns *after* it. */
  after?: string;
  /** Page size (server clamps to ≤ 500). */
  limit?: number;
}

export interface SendOpts {
  sessionId: string;
  message: string;
  claudeSessionId?: string | null;
}

export interface ForkOpts {
  fromTurnId: string;
  title?: string;
}

export interface EditTurnOpts {
  content: string;
  /** Sent back so the server can 409 on a concurrent edit. */
  expectedEditedAt?: string | null;
}

export interface CreateSessionOpts {
  projectId: string;
  title?: string | null;
  deviceId?: string | null;
  repoPath?: string | null;
  metadata?: SessionMetadata;
}

export const sessionApi = {
  /** `GET /api/agent-sessions/:id` — flat session row. */
  detail: (id: string) => apiClient<SessionRow>(`/agent-sessions/${id}`),

  /** `GET /:id/turns?after=&limit=` — cursor-paginated per-turn rows. */
  getTurns: (id: string, { after, limit = 500 }: GetTurnsOpts = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    return apiClient<TurnsResponse>(`/agent-sessions/${id}/turns?${params}`);
  },

  /** `POST /api/agent-sessions/send` — queue a new user message to the device. */
  send: ({ sessionId, message, claudeSessionId }: SendOpts) =>
    apiClient<SessionRow>("/agent-sessions/send", {
      method: "POST",
      body: JSON.stringify({ sessionId, message, ...(claudeSessionId ? { claudeSessionId } : {}) }),
    }),

  /** `POST /:id/turns/:turnId/regenerate` — truncate after a turn + re-dispatch (409 if running). */
  regenerate: (id: string, turnId: string) =>
    apiClient<{ status: string }>(`/agent-sessions/${id}/turns/${turnId}/regenerate`, {
      method: "POST",
    }),

  /** `POST /:id/fork` — branch a new interactive session at a turn (201 → new row). */
  fork: (id: string, { fromTurnId, title }: ForkOpts) =>
    apiClient<SessionRow>(`/agent-sessions/${id}/fork`, {
      method: "POST",
      body: JSON.stringify({ fromTurnId, ...(title ? { title } : {}) }),
    }),

  /** `PATCH /:id/turns/:turnId` — edit a user turn's content. */
  editTurn: (id: string, turnId: string, { content, expectedEditedAt }: EditTurnOpts) =>
    apiClient<TurnRow>(`/agent-sessions/${id}/turns/${turnId}`, {
      method: "PATCH",
      body: JSON.stringify({ content, ...(expectedEditedAt !== undefined ? { expectedEditedAt } : {}) }),
    }),

  /** `POST /:id/cancel` — stop the in-flight turn. */
  cancel: (id: string) => apiClient<SessionRow>(`/agent-sessions/${id}/cancel`, { method: "POST" }),

  /** `POST /:id/rerun` — clone into a fresh session. */
  rerun: (id: string) => apiClient<{ id: string }>(`/agent-sessions/${id}/rerun`, { method: "POST" }),

  /** `POST /api/agent-sessions` — create an interactive session (Chat bootstrap). */
  create: ({ projectId, title, deviceId, repoPath, metadata }: CreateSessionOpts) =>
    apiClient<SessionRow>("/agent-sessions", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        ...(title !== undefined ? { title } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(repoPath !== undefined ? { repoPath } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }),
    }),

  /** `PATCH /:id` with just `title` — rename a conversation (ISS-465). */
  rename: (id: string, title: string) =>
    apiClient<SessionRow>(`/agent-sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  /**
   * `PATCH /:id` writing `metadata: { ...existing, archived }` — soft-archive
   * a chat (ISS-465). Caller MUST pass the row's current `metadata` so
   * existing keys (type: 'agent', issueId, deviceId, …) are preserved — the
   * server replaces the whole jsonb object.
   */
  setArchived: (id: string, archived: boolean, metadata: SessionMetadata | null) =>
    apiClient<SessionRow>(`/agent-sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata: { ...(metadata ?? {}), archived } }),
    }),

  /** `DELETE /:id` — hard-delete (owner or admin only, ISS-465). */
  remove: (id: string) =>
    apiClient<void>(`/agent-sessions/${id}`, { method: "DELETE" }),

  /**
   * `GET /api/agent-sessions?projectId=&metadataType=agent` — list interactive
   * `agent` sessions for a project (latest first), for the Chat resume-or-create
   * bootstrap. Pass `archived=true` to read the archived set (ISS-465); the
   * default omits the param so the server excludes archived chats.
   */
  listByType: (projectId: string, metadataType: string, pageSize = 1, archived?: boolean) => {
    const params = new URLSearchParams({ projectId, metadataType, pageSize: String(pageSize), page: "1" });
    if (archived === true) params.set("archived", "true");
    return apiClientList<SessionRow>(`/agent-sessions?${params}`);
  },
};
