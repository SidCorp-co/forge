export type NotificationType =
  | 'issue_status_changed'
  | 'comment_added'
  | 'agent_completed'
  | 'mention';

export interface Notification {
  id: string;
  userId: string;
  projectId: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
  read: boolean;
  issueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}
