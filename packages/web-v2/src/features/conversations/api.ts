
import { apiClient, apiClientList, apiPutBytes } from "@/lib/api/client";
import type {
  AgentModeOffer,
  ConversationCandidates,
  ConversationDetail,
  ConversationMembership,
  ConversationMode,
  ConversationRow,
} from "./types";

export interface OpenConversationArgs {
  projectId: string;
  title?: string | null;
  people?: string[];
  handles?: Array<{ userId?: string | null; projectId: string }>;
}

export interface SendResult
  extends Pick<ConversationDetail, "messages" | "windows" | "agentTurns"> {
  conversationId: string;
  windowId: string;
  seq: number;
  decision: string | null;
  /** What the room answers in, read back off the row rather than echoed from the request. */
  mode: ConversationMode;
}

export interface UploadTicket {
  uploadId: string;
  method: "PUT";
  uploadPath: string;
  maxBytes: number;
  expiresAt: string;
}

/** One stored file, as the PUT answers and as a message then cites it. */
export interface ConversationAttachment {
  id: string;
  conversationId: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export const conversationsApi = {
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

  /** `POST /api/conversations/:id/people` — add a colleague. */
  addPerson: (id: string, userId: string) =>
    apiClient<ConversationMembership>(`/conversations/${id}/people`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),

  /** `POST /api/conversations/:id/handles` — add an agent, for one of its projects. */
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

  /** `POST /api/conversations/:id/messages` — say something, and get the room back. */
  send: (
    id: string,
    content: string,
    mode?: ConversationMode,
    clientToken?: string,
    attachmentIds?: string[],
  ) =>
    apiClient<SendResult>(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(mode ? { mode } : {}),
        ...(clientToken ? { clientToken } : {}),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
      }),
    }),

  /**
   * Mint a ticket, then stream the bytes to the capability URL it names — two
   * calls because the second carries no credential (ISS-1146).
   */
  upload: async (id: string, file: File): Promise<ConversationAttachment> => {
    const ticket = await apiClient<UploadTicket>(`/conversations/${id}/attachments`, {
      method: "POST",
      // A browser naming no type gets a refusal that names one, not a schema error.
      body: JSON.stringify({ name: file.name, mime: file.type || "application/octet-stream" }),
    });
    return apiPutBytes<ConversationAttachment>(`/uploads/${ticket.uploadId}`, file);
  },

  /** `POST /api/conversations/:id/stop` — end the turn this room is answering. */
  stop: (id: string) =>
    apiClient<{ conversationId: string; stopped: number }>(`/conversations/${id}/stop`, {
      method: "POST",
    }),

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
