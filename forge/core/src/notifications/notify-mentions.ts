import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { createNotification } from './routes.js';

/**
 * Wire mention fan-out: when `commentMentioned` fires, insert one
 * `notifications` row per mentioned user (excluding the actor — already
 * filtered by the route, defended again here). Each insert emits
 * `notificationCreated` so the WS broadcaster delivers `notification.created`
 * (type=`mention`) to the user's room.
 *
 * Failures are logged, never thrown — the originating comment must succeed
 * even if a single notification insert blows up.
 */
export function registerNotifyMentionsSubscriber(bus: HooksBus): void {
  bus.on('commentMentioned', async (p) => {
    const actorId = p.actor.type === 'user' ? p.actor.id : null;

    // Resolve the issue title once for the notification card. Fall back to
    // a generic title if the issue lookup fails.
    let issueTitle = 'an issue';
    try {
      const [row] = await db
        .select({ title: issues.title })
        .from(issues)
        .where(eq(issues.id, p.issueId))
        .limit(1);
      if (row?.title) issueTitle = row.title;
    } catch (err) {
      logger.error({ err, issueId: p.issueId }, 'notify-mentions: issue lookup failed');
    }

    // Resolve the actor's email-local-part once for the title.
    let actorHandle = 'someone';
    if (actorId) {
      try {
        const [row] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, actorId))
          .limit(1);
        const local = row?.email.split('@', 1)[0];
        if (local) actorHandle = `@${local}`;
      } catch (err) {
        logger.error({ err, actorId }, 'notify-mentions: actor lookup failed');
      }
    }

    for (const userId of p.mentionedUserIds) {
      if (userId === actorId) continue;
      try {
        await createNotification({
          userId,
          projectId: p.projectId,
          type: 'mention',
          title: `${actorHandle} mentioned you in "${issueTitle}"`,
          issueId: p.issueId,
        });
      } catch (err) {
        logger.error(
          { err, userId, commentId: p.commentId },
          'notify-mentions: createNotification failed',
        );
      }
    }
  });
}
