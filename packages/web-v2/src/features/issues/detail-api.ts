
import { apiClient, apiClientCursorAll, apiMultipart } from "@/lib/api/client";
import type {
  ActivityItem,
  AttachmentRow,
  CommentAttachment,
  CommentNode,
  IssueDetail,
  IssueParkResponse,
} from "./types";

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
  getPark: (id: string) => apiClient<IssueParkResponse>(`/issues/${id}/park`),

  listComments: (id: string, projectId?: string) =>
    apiClientCursorAll<CommentNode>(withProject(`/issues/${id}/comments`, projectId)),

  /** `POST /api/issues/:id/comments` — create (optional `parentId`). */
  createComment: (id: string, body: string, parentId?: string) =>
    apiClient<CommentNode>(`/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(parentId ? { body, parentId } : { body }),
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
