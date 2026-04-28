import type { BaseEntity } from '@/lib/types';

export type ActivityType =
  | 'comment'
  | 'status_change'
  | 'priority_change'
  | 'label_added'
  | 'label_removed'
  | 'title_change'
  | 'category_change'
  | 'created'
  | 'enriched'
  | 'agent_session'
  | 'relation_added'
  | 'relation_removed'
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
