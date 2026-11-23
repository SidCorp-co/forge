
import { RULING_ENVIRONMENT_FIELD } from "@forge/contracts/record-events";
import { apiClient, apiClientCursorAll, apiMultipart } from "@/lib/api/client";
import type {
  ActivityItem,
  AttachmentRow,
  CommentAttachment,
  CommentNode,
  IssueDetail,
  IssueParkResponse,
} from "./types";

/** One standing record as `GET /api/issues/:id/events` serves it. */
export interface DecisionRecord {
  id: string;
  kind: string;
  fields: { key: string; value: string }[];
  actorType: string;
  actorId: string;
  createdAt: string;
}

/** A project admin's ruling for a production act (REQ-80 BC-11): what to do, and on which environment. */
export interface ProductionRulingDraft {
  act: string;
  environment: string;
}

interface ActivityEnvelope {
  items: ActivityItem[];
  nextBefore: string | null;
}

// ISS-1160 — `id` may be the display key, which resolves only with `projectId`.
function withProject(path: string, projectId?: string): string {
  if (!projectId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
}

export const issueDetailApi = {
  /** `GET /api/issues/:id` — full row incl. pipelineHealth, labels, metadata. */
  get: (id: string, projectId?: string) =>
    apiClient<IssueDetail>(withProject(`/issues/${id}`, projectId)),

  /** `GET /api/issues/:id/park` — what a person owes this issue, or `{ park: null }` (ISS-1310). */
  getPark: (id: string, projectId?: string) =>
    apiClient<IssueParkResponse>(withProject(`/issues/${id}/park`, projectId)),

  listComments: (id: string, projectId?: string) =>
    apiClientCursorAll<CommentNode>(withProject(`/issues/${id}/comments`, projectId)),

  /**
   * `POST /api/issues/:id/comments` — create (optional `parentId`), naming what it is: a `question`
   * the agent working the issue owes a reply to, or a `note` for the record.
   */
  createComment: (id: string, body: string, intent: "question" | "note", parentId?: string) =>
    apiClient<CommentNode>(`/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(parentId ? { body, intent, parentId } : { body, intent }),
    }),

  /**
   * A ruling recorded as a decision: core writes the body from the fields, so every reader of the
   * thread reads it. Sent `keepalive`, so a page closed while core is still answering does not take
   * the request with it.
   */
  recordDecision: (id: string, decision: { decision: string; reason: string }) =>
    apiClient<CommentNode>(`/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ intent: "decision", decision }),
      keepalive: true,
    }),

  /** `PATCH /api/comments/:id` — the same comment, for another purpose (ISS-585). */
  correctIntent: (commentId: string, intent: CommentNode["intent"]) =>
    apiClient<CommentNode>(`/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ intent }),
    }),

  /** `GET /api/issues/:id/events?kind=decision` — the decisions standing on the issue, withdrawn ones left out. */
  listDecisions: (id: string) =>
    apiClient<{ items: DecisionRecord[] }>(`/issues/${id}/events?kind=decision`),

  /**
   * `POST /api/issues/:id/events` — a production ruling, the issue's decision naming the act and the
   * production-tier environment in `production`; a run working the open issue then reads that
   * environment's protected variables (ISS-1431).
   */
  giveRuling: (id: string, ruling: ProductionRulingDraft) =>
    apiClient<DecisionRecord>(`/issues/${id}/events`, {
      method: "POST",
      body: JSON.stringify({
        kind: "decision",
        contract: 1,
        fields: [
          { key: "decision", value: ruling.act },
          { key: RULING_ENVIRONMENT_FIELD, value: ruling.environment },
        ],
      }),
    }),

  /** `POST /api/issues/:id/events/:eventId/withdraw` — a decision kept on record, no longer standing. */
  withdrawDecision: (id: string, eventId: string, reason: string) =>
    apiClient<unknown>(`/issues/${id}/events/${eventId}/withdraw`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  uploadCommentAttachment: (commentId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiMultipart<CommentAttachment>(`/comments/${commentId}/attachments`, fd);
  },

  /** `GET /api/issues/:id/activity` — reverse-chron timeline + `nextBefore`. */
  listActivity: (id: string, limit = 50, projectId?: string) =>
    apiClient<ActivityEnvelope>(withProject(`/issues/${id}/activity?limit=${limit}`, projectId)),

  /** `POST /api/issues/:id/attachments` — one file onto the issue, by its uuid. */
  uploadAttachment: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiMultipart<AttachmentRow>(`/issues/${id}/attachments`, fd);
  },

  /** `GET /api/issues/:id/attachments` — rows with download `url`. */
  listAttachments: (id: string, projectId?: string) =>
    apiClient<AttachmentRow[]>(withProject(`/issues/${id}/attachments`, projectId)),
};
