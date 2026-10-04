import { issueUpdatedPayload } from '@forge/contracts/field-changes';
import { type RecordActivityInput, recordActivityTx } from '../issues/index.js';
import { consume, type Delivery } from '../outbox/index.js';

const MAX_BODY_SNIPPET = 240;
const snippet = (s: string): string => s.slice(0, MAX_BODY_SNIPPET);

/** Writes the delivery's feed rows in its inbox transaction, so a redelivery writes none again. */
function recordOnce(
  delivery: Delivery,
  ...inputs: Omit<RecordActivityInput, 'dedupeKey'>[]
): Promise<void> {
  if (inputs.length === 0) return Promise.resolve();
  return delivery.inbox(async (tx) => {
    for (const input of inputs) {
      await recordActivityTx(tx, { ...input, at: input.at ?? delivery.createdAt });
    }
  });
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
    handle: (p, d) => {
      const nonAssignee = p.fields.filter((f) => f !== 'assigneeId');
      const payload = issueUpdatedPayload(nonAssignee, p.before, p.after);
      const rows: Omit<RecordActivityInput, 'dedupeKey'>[] = [];
      if (payload) {
        rows.push({
          issueId: p.issueId,
          actor: p.actor,
          action: 'issue.updated',
          payload: { ...payload },
        });
      }
      if (p.fields.includes('assigneeId')) {
        rows.push({
          issueId: p.issueId,
          actor: p.actor,
          action: 'issue.assigned',
          payload: {
            before: p.before.assigneeId ?? null,
            after: p.after.assigneeId ?? null,
          },
        });
      }
      return recordOnce(d, ...rows);
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
