import { safeRecordActivity } from './activity.js';
import type { HooksBus } from './hooks.js';

const MAX_BODY_SNIPPET = 240;
const snippet = (s: string): string => s.slice(0, MAX_BODY_SNIPPET);

/**
 * Register the activity-log subscribers (F5 audit trail) on the given bus.
 * Called once at boot from `src/index.ts`. Handlers use `safeRecordActivity`
 * so a failing insert only logs — the originating mutation still succeeds.
 *
 * NOTE: label add/remove activity is emitted inline via `recordActivityTx`
 * inside the PATCH /issues/:id transaction (see `src/issues/routes.ts`).
 * It must roll back with the label delta on failure, so it does NOT flow
 * through the bus.
 */
export function registerActivitySubscribers(bus: HooksBus): void {
  bus.on('issueCreated', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'issue.created',
      payload: { snapshot: p.snapshot },
    });
  });

  bus.on('issueUpdated', async (p) => {
    const nonAssignee = p.fields.filter((f) => f !== 'assigneeId');
    if (nonAssignee.length > 0) {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const f of nonAssignee) {
        before[f] = p.before[f];
        after[f] = p.after[f];
      }
      await safeRecordActivity({
        issueId: p.issueId,
        actor: p.actor,
        action: 'issue.updated',
        payload: { fields: nonAssignee, before, after },
      });
    }
    if (p.fields.includes('assigneeId')) {
      await safeRecordActivity({
        issueId: p.issueId,
        actor: p.actor,
        action: 'issue.assigned',
        payload: {
          before: p.before.assigneeId ?? null,
          after: p.after.assigneeId ?? null,
        },
      });
    }
  });

  bus.on('transition', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'issue.statusChanged',
      payload: {
        from: p.from,
        to: p.to,
        reopenCount: p.reopenCount,
        ...(p.reason ? { reason: p.reason } : {}),
      },
    });
  });

  bus.on('commentCreated', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'comment.created',
      payload: {
        commentId: p.commentId,
        body: snippet(p.body),
        ...(p.parentId != null ? { parentId: p.parentId } : {}),
      },
    });
  });

  bus.on('commentUpdated', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'comment.updated',
      payload: {
        commentId: p.commentId,
        before: snippet(p.before),
        after: snippet(p.after),
      },
    });
  });

  bus.on('commentDeleted', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'comment.deleted',
      payload: { commentId: p.commentId },
    });
  });

  bus.on('commentMentioned', async (p) => {
    await safeRecordActivity({
      issueId: p.issueId,
      actor: p.actor,
      action: 'comment.mentioned',
      payload: { commentId: p.commentId, mentionedUserIds: p.mentionedUserIds },
    });
  });
}
