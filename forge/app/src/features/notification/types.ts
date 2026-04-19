import type { BaseEntity } from '@/lib/types';

export type NotificationType = 'issue_status_changed' | 'comment_added' | 'agent_completed' | 'mention';

export interface Notification extends BaseEntity {
  type: NotificationType;
  title: string;
  body: string | null;
  read: boolean;
  issueDocumentId: string | null;
  agentSessionDocumentId: string | null;
  project: { id: number; documentId: string } | null;
}
