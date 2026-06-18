import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';

/**
 * Auto-resolve (ISS-510): mark every UNREAD notification carrying `resolutionKey`
 * as read and stamp `resolvedAt`, then emit `notificationRead` per cleared row
 * so the recipient's bell + unread count update live (no reload).
 *
 * Mark-read (not delete) keeps history auditable. The key embeds the entity it
 * tracks (e.g. `issue:<issueId>:status`), so clearing by key alone scopes to the
 * right rows across all affected users without a per-user filter.
 *
 * Idempotent: only unread rows match, so a repeat call after the condition has
 * already cleared updates nothing and emits nothing. Best-effort by contract —
 * failures are logged, never thrown, so the originating transition still
 * succeeds.
 *
 * @returns the number of rows cleared.
 */
export async function resolveNotifications(resolutionKey: string): Promise<number> {
  if (!resolutionKey) return 0;
  try {
    const cleared = await db
      .update(notifications)
      .set({ read: true, resolvedAt: new Date() })
      .where(and(eq(notifications.resolutionKey, resolutionKey), eq(notifications.read, false)))
      .returning({ id: notifications.id, userId: notifications.userId });

    for (const row of cleared) {
      await hooks.emit('notificationRead', { notificationId: row.id, userId: row.userId });
    }
    return cleared.length;
  } catch (err) {
    logger.error({ err, resolutionKey }, 'auto-resolve: resolveNotifications failed');
    return 0;
  }
}
