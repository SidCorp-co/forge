// web-v2 feature module: session (detail) — REST surface for the RUN thread.
// All calls go through the shared `apiClient` (no raw fetch). Routes verified
// against `packages/core/src/agent-sessions/routes.ts` for ISS-292.
//
// cm:guard what is here is run-shaped and stays that way: reading a run's turns, sending into one, truncating and re-dispatching it, forking it, cancelling it. The chat bootstrap that used to sit beside them — create, the interactive list, the runner pin, rename, archive and delete — left with the chat surface at ISS-1004 step 5, because each named a session a person's chat was STORED in rather than a run, and a conversation is stored in `/api/conversations` now.

import { apiClient, apiMultipart } from "@/lib/api/client";
import type { SessionRow } from "@/features/sessions/types";
import type { SessionAttachment, TurnRow, TurnsResponse } from "./types";

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
  /** ISS-499 — ids of already-uploaded session attachments to attach to this turn. */
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

  /**
   * `POST /:sessionId/attachments` — multipart upload of one chat attachment
   * (ISS-499). Returns the persisted attachment metadata; its `id` is then sent
   * in the next `send` as `attachmentIds`.
   */
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
