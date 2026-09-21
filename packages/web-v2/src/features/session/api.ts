
import { apiClient, apiMultipart } from "@/lib/api/client";
import type { SessionRow } from "@/features/sessions/types";
import type { SessionAttachment, TurnRow, TurnsResponse } from "./types";

export interface GetTurnsOpts {
  after?: string;
  limit?: number;
}

export interface SendOpts {
  sessionId: string;
  message: string;
  claudeSessionId?: string | null;
  attachmentIds?: string[];
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
  send: ({ sessionId, message, claudeSessionId, attachmentIds }: SendOpts) =>
    apiClient<SessionRow>("/agent-sessions/send", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        message,
        ...(claudeSessionId ? { claudeSessionId } : {}),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
      }),
    }),

  uploadAttachment: (sessionId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiMultipart<SessionAttachment>(`/agent-sessions/${sessionId}/attachments`, fd);
  },

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

};
