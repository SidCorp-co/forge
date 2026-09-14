// The conversation REST surface — `/api/conversations`, the rooms the store
// holds rather than the sessions a runner ran.
//
// Routes verified against `packages/core/src/assistant/conversation-routes.ts`
// (ISS-1004 step 5). There is no fork, no rerun, no per-turn edit and no
// regenerate here, and that is the shape of the thing rather than a gap: a
// conversation is an append-only log, and all four rewrite a run's turns.

import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  ConversationCandidates,
  ConversationDetail,
  ConversationMembership,
  ConversationRow,
} from "./types";

/** What a room is opened with, beside whoever is opening it. */
export interface OpenConversationArgs {
  projectId: string;
  title?: string | null;
  people?: string[];
  handles?: Array<{ userId: string; projectId: string }>;
}

export interface SendResult extends Pick<ConversationDetail, "messages" | "windows"> {
  conversationId: string;
  windowId: string;
  seq: number;
  /** What the window this message opened settled on, where this call routed it. */
  decision: string | null;
}

export const conversationsApi = {
  /** `GET /api/conversations?projectId=` — the rooms this project's handle speaks in. */
  list: (projectId: string, pageSize = 50) =>
    apiClientList<ConversationRow>(
      `/conversations?${new URLSearchParams({ projectId, page: "1", pageSize: String(pageSize) })}`,
    ),

  /** `GET /api/conversations/:id` — the room, its people, its messages and its window decisions. */
  detail: (id: string) => apiClient<ConversationDetail>(`/conversations/${id}`),

  /** `POST /api/conversations` — open a room in this project, with whoever it starts with. */
  open: (args: OpenConversationArgs) =>
    apiClient<ConversationRow>("/conversations", {
      method: "POST",
      body: JSON.stringify({
        projectId: args.projectId,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.people?.length ? { people: args.people } : {}),
        ...(args.handles?.length ? { handles: args.handles } : {}),
      }),
    }),

  /** `GET /api/conversations/:id/candidates` — who this caller could still put in this room. */
  candidates: (id: string) =>
    apiClient<ConversationCandidates>(`/conversations/${id}/candidates`),

  /** `GET /api/conversations/candidates?projectId=` — who a room in this project could open with. */
  candidatesForProject: (projectId: string) =>
    apiClient<ConversationCandidates>(
      `/conversations/candidates?${new URLSearchParams({ projectId })}`,
    ),

  // cm:guard two calls and not one taking a kind, because adding a person and adding an agent are two acts with different blast radius: one changes who reads the room, the other changes what the room can see. A single call would make the screen's separation a convention rather than a shape (ISS-1011 criterion 14).
  /** `POST /api/conversations/:id/people` — add a colleague. */
  addPerson: (id: string, userId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/people`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),

  /** `POST /api/conversations/:id/handles` — add an agent, for one of its projects. */
  addHandle: (id: string, userId: string, projectId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/handles`, {
      method: "POST",
      body: JSON.stringify({ userId, projectId }),
    }),

  /** `DELETE /api/conversations/:id/participants/:participantId` — take one member out. */
  removeParticipant: (id: string, participantId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/participants/${participantId}`, {
      method: "DELETE",
    }),

  // cm:guard this call RUNS the turn and returns what the room then holds, so it takes as long as an answer takes: a caller that treats it as a fire-and-forget would show the question and never the reply, because there is no second request that fetches one.
  /** `POST /api/conversations/:id/messages` — say something, and get the room back. */
  send: (id: string, content: string) =>
    apiClient<SendResult>(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  /** `PATCH /api/conversations/:id` — rename. */
  rename: (id: string, title: string | null) =>
    apiClient<ConversationRow>(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  /** `DELETE /api/conversations/:id`. */
  remove: (id: string) => apiClient<void>(`/conversations/${id}`, { method: "DELETE" }),
};
