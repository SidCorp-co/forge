import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';

/**
 * Auto-resolve (ISS-510): mark every UNRESOLVED notification carrying
 * `resolutionKey` as read and stamp `resolvedAt`, then emit `notificationRead`
 * per cleared row so the recipient's bell + unread count update live.
 *
 * Mark-read (not delete) keeps history auditable. The key embeds the entity it
 * tracks (e.g. `issue:<issueId>:status`), so clearing by key alone scopes to the
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
    // cm:guard read this BEFORE the update — RETURNING yields the NEW row, so `read` there is always true and could not tell an unread row from one the operator had already opened. The hook decrements a client-side unread count, so emitting it for an already-read row double-counts.
    const wasUnread = await db
      .select({ id: notifications.id, userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.resolutionKey, resolutionKey),
          isNull(notifications.resolvedAt),
          eq(notifications.read, false),
        ),
      );

    // cm:guard match on `resolvedAt IS NULL`, NOT `read = false` — the two answer different questions ("has the condition cleared" vs "has a human looked") and this filter was the second. A row the operator had already opened could never be stamped, so `resolvedAt` stayed NULL forever on exactly the notifications someone was paying attention to; emitPipelineWedge's dedupe reads that column, so a read-then-fixed wedge would be suppressed permanently.
    const cleared = await db
      .update(notifications)
      .set({ read: true, resolvedAt: new Date() })
      .where(and(eq(notifications.resolutionKey, resolutionKey), isNull(notifications.resolvedAt)))
      .returning({ id: notifications.id });

    for (const row of wasUnread) {
      await hooks.emit('notificationRead', { notificationId: row.id, userId: row.userId });
    }
    return cleared.length;
  } catch (err) {
    logger.error({ err, resolutionKey }, 'auto-resolve: resolveNotifications failed');
    return 0;
  }
}
