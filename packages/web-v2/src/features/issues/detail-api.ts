
import { apiClient, apiClientCursorAll, apiMultipart } from "@/lib/api/client";
import type {
  ActivityItem,
  AttachmentRow,
  CommentAttachment,
  CommentNode,
  IssueDetail,
  StepDurationRow,
  StepHandoffRow,
  TaskRow,
} from "./types";

interface ActivityEnvelope {
  items: ActivityItem[];
  nextBefore: string | null;
}

export const issueDetailApi = {
  /** `GET /api/issues/:id` — full row incl. pipelineHealth, labels, metadata. */
  get: (id: string) => apiClient<IssueDetail>(`/issues/${id}`),

  listComments: (id: string) => apiClientCursorAll<CommentNode>(`/issues/${id}/comments`),

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
  listActivity: (id: string, limit = 50) =>
    apiClient<ActivityEnvelope>(`/issues/${id}/activity?limit=${limit}`),

  /** `GET /api/issues/:id/tasks` — flat task rows. */
  listTasks: (id: string) => apiClient<TaskRow[]>(`/issues/${id}/tasks`),

  /** `GET /api/issues/:id/attachments` — rows with download `url`. */
  listAttachments: (id: string) => apiClient<AttachmentRow[]>(`/issues/${id}/attachments`),

  listHandoffs: (projectId: string, id: string) =>
    apiClient<{ rows: StepHandoffRow[] }>(
      `/issue-step-contexts?projectId=${projectId}&issueId=${id}&orderDir=asc&limit=200`,
    ),

  stepDurations: (projectId: string) =>
    apiClient<StepDurationRow[]>(`/pipeline/step-durations?projectId=${projectId}&days=90`),
};
