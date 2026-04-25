import { apiClient } from '@/lib/api/client';
import type { Activity, ActivityType } from '../types';

interface CoreActivity {
  id: string;
  issueId: string;
  action: string;
  actorType: 'user' | 'device';
  actorId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface CoreActivityEnvelope {
  items: CoreActivity[];
  nextBefore: string | null;
}

const KNOWN_TYPES = new Set<ActivityType>([
  'comment',
  'status_change',
  'priority_change',
  'label_added',
  'label_removed',
  'title_change',
  'category_change',
  'created',
  'enriched',
  'agent_session',
  'relation_added',
  'relation_removed',
  'pikachu_decision',
]);

function deriveType(action: string): ActivityType {
  // Core actions are dotted (e.g. "transition.open_to_confirmed", "comment.created").
  const head = action.split('.')[0] ?? action;
  if (head === 'transition') return 'status_change';
  if (head === 'comment') return 'comment';
  if (head === 'pikachu') return 'pikachu_decision';
  if (KNOWN_TYPES.has(head as ActivityType)) return head as ActivityType;
  return 'created';
}

function toLegacy(row: CoreActivity, issueDocumentId: string): Activity {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const body = typeof payload.body === 'string' ? (payload.body as string) : null;
  const field = typeof payload.field === 'string' ? (payload.field as string) : null;
  const fromValue = payload.from != null ? String(payload.from) : null;
  const toValue = payload.to != null ? String(payload.to) : null;
  return {
    id: 0,
    documentId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    type: deriveType(row.action),
    actor: row.actorId,
    body,
    isAI: row.actorType === 'device',
    field,
    fromValue,
    toValue,
    metadata: payload,
    issue: { id: 0, documentId: issueDocumentId },
  } as Activity;
}

export const activityApi = {
  getByIssue: async (issueId: string): Promise<{ data: Activity[] }> => {
    const env = await apiClient<CoreActivityEnvelope>(
      `/issues/${issueId}/activity?limit=200`,
    );
    return { data: env.items.map((r) => toLegacy(r, issueId)) };
  },

  evaluate: (issueId: string, activityId: string, verdict: 'approve' | 'reject', note?: string) =>
    apiClient<CoreActivity>(
      `/issues/${issueId}/activity/${activityId}/evaluate`,
      { method: 'PATCH', body: JSON.stringify({ verdict, note }) },
    ),

  delete: (issueId: string, activityId: string) =>
    apiClient<void>(
      `/issues/${issueId}/activity/${activityId}`,
      { method: 'DELETE' },
    ),
};
