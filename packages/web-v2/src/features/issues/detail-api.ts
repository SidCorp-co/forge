// web-v2 feature module: issues — detail REST surface (Part B). Paths verified
// against core: `issues/routes.ts` (GET /:id), `comments/routes.ts`,
// `issues/activity-routes.ts`, `tasks/routes.ts`, `issues/attachment-routes.ts`.

import { apiClient, apiMultipart } from "@/lib/api/client";
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

  /** `GET /api/issues/:id/comments` — comment TREE (nested via `replies`). */
  listComments: (id: string) => apiClient<CommentNode[]>(`/issues/${id}/comments`),

  /** `POST /api/issues/:id/comments` — create (optional `parentId`). */
  createComment: (id: string, body: string, parentId?: string) =>
    apiClient<CommentNode>(`/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(parentId ? { body, parentId } : { body }),
    }),

  /** `POST /api/comments/:commentId/attachments` — multipart, one file per call.
   *  Comments are created first (body only), then each staged file uploaded. */
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

  /** `GET /api/issue-step-contexts?projectId&issueId` — step-handoff rows
   *  (kind=handoff) for the issue, oldest-first so cards read triage→release.
   *  Mounted at `/api/issue-step-contexts` (NOT under `/api/issues`); shares the
   *  service behind the `forge_step_handoff` MCP tool (ISS-377). */
  listHandoffs: (projectId: string, id: string) =>
    apiClient<{ rows: StepHandoffRow[] }>(
      `/issue-step-contexts?projectId=${projectId}&issueId=${id}&orderDir=asc&limit=200`,
    ),

  /** `GET /api/pipeline/step-durations?projectId&days` — project-window
   *  per-step duration + cost rows; filtered to this issue client-side (the
   *  endpoint has no issueId param). Per-stage cost source (ISS-377 gap E). */
  stepDurations: (projectId: string) =>
    apiClient<StepDurationRow[]>(`/pipeline/step-durations?projectId=${projectId}&days=90`),
};
