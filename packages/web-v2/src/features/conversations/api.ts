// The conversation REST surface — `/api/conversations`, the rooms the store
// holds rather than the sessions a runner ran.
//
// Routes verified against `packages/core/src/assistant/conversation-routes.ts`
// (ISS-1004 step 5). There is no fork, no rerun, no per-turn edit and no
// regenerate here, and that is the shape of the thing rather than a gap: a
// conversation is an append-only log, and all four rewrite a run's turns.

import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AgentModeOffer,
  ConversationCandidates,
  ConversationDetail,
  ConversationMembership,
  ConversationMode,
  ConversationRow,
} from "./types";

/** What a room is opened with, beside whoever is opening it. */
export interface OpenConversationArgs {
  projectId: string;
  title?: string | null;
  people?: string[];
  // cm:guard the agent id is optional for the same reason it is on `addHandle`: a room may be opened about a project whose agent has never been minted, and the server mints it inside the same transaction that opens the room (ISS-1011).
  handles?: Array<{ userId?: string | null; projectId: string }>;
}

export interface SendResult
  extends Pick<ConversationDetail, "messages" | "windows" | "agentTurns"> {
  conversationId: string;
  windowId: string;
  seq: number;
  /** What the window this message opened settled on, where this call routed it. */
  decision: string | null;
  /** What the room answers in, read back off the row rather than echoed from the request. */
  mode: ConversationMode;
}

export const conversationsApi = {
  // cm:guard `archived` is sent as the string "1" or "0" and never as `String(boolean)`: the route
  // takes a four-value literal by name rather than coercing, and "false" coerced would have asked
  // for the archived side while meaning the live one (ISS-1028).
  /** `GET /api/conversations?projectId=` — the rooms this project's handle speaks in. */
  list: (projectId: string, pageSize = 50, archived = false) =>
    apiClientList<ConversationRow>(
      `/conversations?${new URLSearchParams({
        projectId,
        page: "1",
        pageSize: String(pageSize),
        archived: archived ? "1" : "0",
      })}`,
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
        ...(args.handles?.length
          ? {
              handles: args.handles.map((h) => ({
                projectId: h.projectId,
                ...(h.userId ? { userId: h.userId } : {}),
              })),
            }
          : {}),
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
  // cm:guard the agent id is OMITTED and not sent as null when the project has no handle yet: the route's schema is `.strict()` with `userId` optional, so a literal null is a refused body rather than the mint-on-add path (ISS-1011).
  addHandle: (id: string, userId: string | null, projectId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/handles`, {
      method: "POST",
      body: JSON.stringify({ projectId, ...(userId ? { userId } : {}) }),
    }),

  /** `DELETE /api/conversations/:id/participants/:participantId` — take one member out. */
  removeParticipant: (id: string, participantId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/participants/${participantId}`, {
      method: "DELETE",
    }),

  // cm:guard this call runs an ASSISTANT turn and returns what the room then holds, so it takes as
  // long as an answer takes. An AGENT-mode room answers 202 with no reply in it, and the state of
  // the turn it started is in `agentTurns` — a caller that read the two the same way would show an
  // Agent room as settled with nothing in it (ISS-1039).
  // cm:guard `mode` is sent ONLY when the caller has one, and it is refused by the server on a room
  // that already holds a message. There is no value of it meaning "leave it as it is": absence
  // means that, and sending the room's current mode back on every message would be a request the
  // server is right to refuse.
  /** `POST /api/conversations/:id/messages` — say something, and get the room back. */
  send: (id: string, content: string, mode?: ConversationMode) =>
    apiClient<SendResult>(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, ...(mode ? { mode } : {}) }),
    }),

  // cm:guard a PROJECT-scoped read and not a room's, because the composer of a draft has no room to
  // ask about: it is the only way the pick can be disabled with its reason before a person spends a
  // message finding out (ISS-1039).
  /** `GET /api/conversations/agent-mode` — could a new room here be opened in Agent mode? */
  agentMode: (projectId: string) =>
    apiClient<AgentModeOffer>(`/conversations/agent-mode?projectId=${projectId}`),

  /** `PATCH /api/conversations/:id` — rename. */
  rename: (id: string, title: string | null) =>
    apiClient<ConversationRow>(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  /** `PATCH /api/conversations/:id` — file it away, or bring it back. */
  setArchived: (id: string, archived: boolean) =>
    apiClient<ConversationRow>(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    }),

  /** `DELETE /api/conversations/:id`. */
  remove: (id: string) => apiClient<void>(`/conversations/${id}`, { method: "DELETE" }),
};
