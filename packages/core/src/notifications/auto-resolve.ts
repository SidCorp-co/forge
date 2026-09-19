import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';

/**
 * Auto-resolve (ISS-510): mark every UNRESOLVED notification carrying
 * `resolutionKey` as read and stamp `resolvedAt`, then emit `notificationRead`
 * per cleared row so the recipient's bell + unread count update live.
 *
 * Mark-read (not delete) keeps history auditable. The key embeds the entity it
 * tracks (e.g. `wedge:<jobId>`), so clearing by key alone scopes to the
 * right rows across all affected users without a per-user filter.
 *
 * Idempotent: only unstamped rows match, so a repeat call after the condition
 * has already cleared updates nothing and emits nothing. Best-effort by
 * contract — failures are logged, never thrown, so the originating transition
 * still succeeds.
 *
 * @returns the number of rows cleared.
 */
export async function resolveNotifications(resolutionKey: string): Promise<number> {
  if (!resolutionKey) return 0;
  try {
    const cleared = await db.execute<{ id: string; state: string }>(sql`
      UPDATE notifications n
      SET resolved_at = now(),
          state = CASE WHEN n.kind = 'condition' THEN 'resolved' ELSE n.state END
      FROM (
        SELECT id FROM notifications
        WHERE resolution_key = ${resolutionKey} AND resolved_at IS NULL
        ORDER BY id
        FOR UPDATE
      ) prev
      WHERE n.id = prev.id
      RETURNING n.id, n.state
    `);

    for (const row of cleared) {
      await sendResolvedNotice(row.id);
    }
    return cleared.length;
  } catch (err) {
    logger.error({ err, resolutionKey }, 'auto-resolve: resolveNotifications failed');
    return 0;
  }
}

export async function sendResolvedNotice(notificationId: string): Promise<number> {
  const [record] = await db
    .select({
      type: notifications.type,
      title: notifications.title,
      projectId: notifications.projectId,
      issueId: notifications.issueId,
      secondaryIssueId: notifications.secondaryIssueId,
      agentSessionId: notifications.agentSessionId,
      severity: notifications.severity,
      resolutionKey: notifications.resolutionKey,
    })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1);
  if (!record) return 0;

  const told = await db
    .select({ userId: notificationDeliveries.userId })
    .from(notificationDeliveryMembers)
    .innerJoin(
      notificationDeliveries,
      eq(notificationDeliveries.id, notificationDeliveryMembers.deliveryId),
    )
    .where(
      and(
        eq(notificationDeliveryMembers.notificationId, notificationId),
        eq(notificationDeliveries.resolvedNotice, false),
      ),
    );

  const recipients = [...new Set(told.map((t) => t.userId))];
  for (const userId of recipients) {
    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({
        userId,
        channel: 'bell',
        resolvedNotice: true,
        title: `Resolved — ${record.title}`,
      })
      .returning({ id: notificationDeliveries.id });
    if (!delivery) continue;
    await db
      .insert(notificationDeliveryMembers)
      .values({ deliveryId: delivery.id, notificationId })
      .onConflictDoNothing();
    await hooks.emit('notificationCreated', {
      notificationId,
      userId,
      projectId: record.projectId,
      type: record.type,
      title: `Resolved — ${record.title}`,
      body: null,
      severity: 'success',
      resolutionKey: record.resolutionKey,
      issueId: record.issueId,
      secondaryIssueId: record.secondaryIssueId,
      agentSessionId: record.agentSessionId,
    });
  }
  return recipients.length;
}
