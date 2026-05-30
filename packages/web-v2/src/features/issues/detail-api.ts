// web-v2 feature module: issues — detail REST surface (Part B). Paths verified
// against core: `issues/routes.ts` (GET /:id), `comments/routes.ts`,
// `issues/activity-routes.ts`, `tasks/routes.ts`, `issues/attachment-routes.ts`.

import { apiClient } from "@/lib/api/client";
import type {
  ActivityItem,
  AttachmentRow,
  CommentNode,
  IssueDetail,
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

  /** `GET /api/issues/:id/activity` — reverse-chron timeline + `nextBefore`. */
  listActivity: (id: string, limit = 50) =>
    apiClient<ActivityEnvelope>(`/issues/${id}/activity?limit=${limit}`),

  /** `GET /api/issues/:id/tasks` — flat task rows. */
  listTasks: (id: string) => apiClient<TaskRow[]>(`/issues/${id}/tasks`),

  /** `GET /api/issues/:id/attachments` — rows with download `url`. */
  listAttachments: (id: string) => apiClient<AttachmentRow[]>(`/issues/${id}/attachments`),
};
