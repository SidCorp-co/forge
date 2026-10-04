import { issueUpdatedPayload } from '@forge/contracts/field-changes';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog } from '../db/schema.js';
import { consume, type Delivery } from '../outbox/index.js';
import { type RecordActivityInput, recordActivity } from './activity.js';

const MAX_BODY_SNIPPET = 240;
const snippet = (s: string): string => s.slice(0, MAX_BODY_SNIPPET);

/** True when this delivery's row is already written: a redelivery after a crash between the write
 *  and the outbox recording it, which writes nothing again. */
async function alreadyRecorded(dedupeKey: string, action: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.dedupeKey, dedupeKey), eq(activityLog.action, action)))
    .limit(1);
  return Boolean(existing);
}

async function recordOnce(
  delivery: Delivery,
  input: Omit<RecordActivityInput, 'dedupeKey'>,
): Promise<void> {
  const dedupeKey = `outbox:${delivery.eventId}`;
  if (await alreadyRecorded(dedupeKey, input.action)) return;
  await recordActivity({ ...input, dedupeKey, at: input.at ?? delivery.createdAt });
}

const NAME = 'activity-feed';

/**
 * The issue activity feed, a consumer of the outbox: each row is written once per event, at the
 * time the act committed. Label add and remove are written inside the PATCH transaction instead
 * (`issues/routes.ts`), because they roll back with the label delta.
 */
export function registerActivitySubscribers(): void {
  consume('issue.created', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.issueId,
        actor: p.actor,
        action: 'issue.created',
        payload: { snapshot: p.snapshot },
      }),
  });

  // cm:guard an `issue.updated` row records the changes a write made (`@forge/contracts`
  // `issueUpdatedPayload`), never a snapshot of the fields it touched, and a write that moved
  // nothing records nothing
  consume('issue.updated', {
    name: NAME,
    handle: async (p, d) => {
      const nonAssignee = p.fields.filter((f) => f !== 'assigneeId');
      const payload = issueUpdatedPayload(nonAssignee, p.before, p.after);
      if (payload) {
        await recordOnce(d, {
          issueId: p.issueId,
          actor: p.actor,
          action: 'issue.updated',
          payload: { ...payload },
        });
      }
      if (p.fields.includes('assigneeId')) {
        await recordOnce(d, {
          issueId: p.issueId,
          actor: p.actor,
          action: 'issue.assigned',
          payload: {
            before: p.before.assigneeId ?? null,
            after: p.after.assigneeId ?? null,
          },
        });
      }
    },
  });

  // The feed's and the charts' line for a move; its audit row is `kernel_transitions`.
  consume('issue.transitioned', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.id,
        actor: p.actor,
        action: 'issue.statusChanged',
        payload: { from: p.from, to: p.to, ...(p.reason ? { reason: p.reason } : {}) },
        at: new Date(p.at),
      }),
  });

  consume('comment.created', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.issueId,
        actor: p.actor,
        action: 'comment.created',
        payload: {
          commentId: p.commentId,
          body: snippet(p.body),
          ...(p.parentId != null ? { parentId: p.parentId } : {}),
        },
      }),
  });

  consume('comment.updated', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.issueId,
        actor: p.actor,
        action: 'comment.updated',
        payload: { commentId: p.commentId, before: snippet(p.before), after: snippet(p.after) },
      }),
  });

  consume('comment.deleted', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.issueId,
        actor: p.actor,
        action: 'comment.deleted',
        payload: { commentId: p.commentId },
      }),
  });

  consume('comment.mentioned', {
    name: NAME,
    handle: (p, d) =>
      recordOnce(d, {
        issueId: p.issueId,
        actor: p.actor,
        action: 'comment.mentioned',
        payload: { commentId: p.commentId, mentionedUserIds: p.mentionedUserIds },
      }),
  });
}
