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

export interface ActivityPage {
  items: Activity[];
  nextBefore: string | null;
}

const warned = new Set<string>();
function warnUnknownAction(action: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (warned.has(action)) return;
  warned.add(action);
  // eslint-disable-next-line no-console
  console.debug(`[activity] unknown action -> 'created' fallback: ${action}`);
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

interface MapResult {
  type: ActivityType;
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

function mapAction(action: string, payload: Record<string, unknown>): MapResult {
  const head = action.split('.')[0] ?? action;

  if (action === 'issue.created') return { type: 'created' };

  if (action === 'issue.statusChanged') {
    return {
      type: 'status_change',
      fromValue: asString(payload.from),
      toValue: asString(payload.to),
    };
  }

  if (action === 'issue.updated') {
    const fields = Array.isArray(payload.fields) ? (payload.fields as string[]) : [];
    const before = (payload.before ?? {}) as Record<string, unknown>;
    const after = (payload.after ?? {}) as Record<string, unknown>;
    const primary = fields[0];
    if (fields.length > 1) {
      return { type: 'edited', field: 'multiple' };
    }
    if (primary === 'priority') {
      return {
        type: 'priority_change',
        field: 'priority',
        fromValue: asString(before.priority),
        toValue: asString(after.priority),
      };
    }
    if (primary === 'category') {
      return {
        type: 'category_change',
        field: 'category',
        fromValue: asString(before.category),
        toValue: asString(after.category),
      };
    }
    if (primary === 'complexity') {
      return {
        type: 'complexity_change',
        field: 'complexity',
        fromValue: asString(before.complexity),
        toValue: asString(after.complexity),
      };
    }
    if (primary === 'title') {
      return {
        type: 'title_change',
        field: 'title',
        fromValue: asString(before.title),
        toValue: asString(after.title),
      };
    }
    return { type: 'edited', field: primary ?? null };
  }

  if (action === 'issue.assigned') {
    return {
      type: 'assignee_change',
      field: 'assignee',
      fromValue: asString(payload.before),
      toValue: asString(payload.after),
    };
  }

  if (action === 'issue.labeled') {
    const labelId = asString(payload.labelId);
    return {
      type: 'label_added',
      field: 'label',
      toValue: labelId,
      metadata: labelId ? { labelId } : undefined,
    };
  }

  if (action === 'issue.unlabeled') {
    const labelId = asString(payload.labelId);
    return {
      type: 'label_removed',
      field: 'label',
      fromValue: labelId,
      metadata: labelId ? { labelId } : undefined,
    };
  }

  if (action === 'issue.dependency.added') {
    return {
      type: 'relation_added',
      fromValue: asString(payload.fromIssueId),
      toValue: asString(payload.toIssueId),
    };
  }
  if (action === 'issue.dependency.removed') {
    return {
      type: 'relation_removed',
      fromValue: asString(payload.fromIssueId),
      toValue: asString(payload.toIssueId),
    };
  }

  if (head === 'comment') {
    if (action === 'comment.created') {
      return { type: 'comment', body: asString(payload.body) };
    }
    if (action === 'comment.updated') {
      return {
        type: 'comment',
        body: asString(payload.after) ?? asString(payload.before),
        metadata: {
          before: payload.before ?? null,
          after: payload.after ?? null,
          edited: true,
        },
      };
    }
    if (action === 'comment.deleted') {
      return { type: 'comment', body: null, metadata: { deleted: true } };
    }
    return { type: 'comment', body: asString(payload.body) };
  }

  if (action === 'agent-session.created') {
    return {
      type: 'agent_session',
      body: 'started an agent session',
      metadata: payload.sessionId ? { sessionId: payload.sessionId, title: payload.title ?? null } : undefined,
    };
  }
  if (action === 'agent-session.pipelineControl.changed') {
    return {
      type: 'agent_session',
      body: 'updated agent session pipeline control',
      metadata: payload,
    };
  }

  if (action === 'issue.attachment.uploaded') {
    return {
      type: 'attachment_added',
      toValue: asString(payload.name),
      metadata: payload,
    };
  }
  if (action === 'issue.attachment.deleted') {
    return {
      type: 'attachment_removed',
      fromValue: asString(payload.name),
      metadata: payload,
    };
  }

  if (head === 'pikachu') return { type: 'pikachu_decision' };

  if (head === 'transition') {
    return {
      type: 'status_change',
      fromValue: asString(payload.from),
      toValue: asString(payload.to),
    };
  }

  warnUnknownAction(action);
  return { type: 'created' };
}

function toLegacy(row: CoreActivity, issueDocumentId: string): Activity {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const mapped = mapAction(row.action, payload);
  const metadata = mapped.metadata ? { ...payload, ...mapped.metadata } : payload;
  return {
    id: 0,
    documentId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    type: mapped.type,
    actor: row.actorId,
    body: mapped.body ?? null,
    isAI: row.actorType === 'device',
    field: mapped.field ?? null,
    fromValue: mapped.fromValue ?? null,
    toValue: mapped.toValue ?? null,
    metadata,
    issue: { id: 0, documentId: issueDocumentId },
  } as Activity;
}

export const activityApi = {
  getByIssue: async (
    issueId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<ActivityPage> => {
    const limit = opts.limit ?? 50;
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (opts.before) params.set('before', opts.before);
    const env = await apiClient<CoreActivityEnvelope>(
      `/issues/${issueId}/activity?${params.toString()}`,
    );
    return {
      items: env.items.map((r) => toLegacy(r, issueId)),
      nextBefore: env.nextBefore,
    };
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

export const __testing = { mapAction, toLegacy };
