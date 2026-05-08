import type { BaseEntity } from '@/lib/types';

export type ActivityType =
  | 'comment'
  | 'status_change'
  | 'priority_change'
  | 'category_change'
  | 'complexity_change'
  | 'title_change'
  | 'assignee_change'
  | 'manual_hold_set'
  | 'manual_hold_cleared'
  | 'label_added'
  | 'label_removed'
  | 'edited'
  | 'created'
  | 'enriched'
  | 'agent_session'
  | 'relation_added'
  | 'relation_removed'
  | 'attachment_added'
  | 'attachment_removed'
  | 'pikachu_decision';

export interface Activity extends BaseEntity {
  type: ActivityType;
  actor: string | null;
  body: string | null;
  isAI: boolean;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  metadata: Record<string, unknown> | null;
  issue: { id: number; documentId: string } | null;
}
