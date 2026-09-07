// web-v2 feature module: issues — detail REST surface (Part B). Paths verified
// against core: `issues/routes.ts` (GET /:id), `comments/routes.ts`,
// `issues/activity-routes.ts`, `tasks/routes.ts`, `issues/attachment-routes.ts`.

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

  /** `GET /api/issues/:id/comments` — comment TREE (nested via `replies`),
   *  every page of it, with `totalCount` = every comment on the issue. */
  // cm:edge contract -> packages/core/src/comments/routes.ts — the route answers `cursorList`, so the body is `{ items, total, nextCursor, … }` and `items` is the TREE for THIS PAGE while `total` counts every comment flat. Read as a bare array it is an object that passes every truthiness guard and throws `is not iterable` in the first walk of it (ISS-893: every issue-detail page on the deploy). `apiClientCursorAll` is the one place that knows the envelope — do not hand-unwrap `{ items }` here.
  // cm:guard the screen renders the WHOLE thread, so this walks every page rather than showing the first one — a first page rendered as the thread is a silent truncation, and the route pages at 50 roots where it used to cap at 1000 comments (ISS-956). A load-more control instead of the walk is a screen change and owes the UX contract.
  listComments: (id: string) => apiClientCursorAll<CommentNode>(`/issues/${id}/comments`),

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
