import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import { personName } from '../lib/person-name.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { emitNotification } from './emit.js';

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

    // The mentioner's slot is filled as every person slot is, never from their address (ISS-1229 r20).
    let actorName = personName(null, 'start');
    if (actorId) {
      try {
        const [row] = await db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, actorId))
          .limit(1);
        actorName = personName(row?.displayName, 'start');
      } catch (err) {
        logger.error({ err, actorId }, 'notify-mentions: actor lookup failed');
      }
    }

    for (const userId of p.mentionedUserIds) {
      if (userId === actorId) continue;
      try {
        await emitNotification({
          userId,
          projectId: p.projectId,
          type: 'mention',
          title: `${actorName} mentioned you in "${issueTitle}"`,
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
