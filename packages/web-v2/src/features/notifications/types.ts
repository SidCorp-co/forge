// web-v2 feature module: notifications (header bell). Mirrors the core
// `notifications` row serializer (GET /api/notifications returns raw rows).
// Workspace-global: the bell is NOT scoped to a single project.

export type NotificationType =
  | "issue_status_changed"
  | "comment_added"
  | "agent_completed"
  | "mention"
  | "pipeline_wedge";

export interface NotificationRow {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  issueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}
