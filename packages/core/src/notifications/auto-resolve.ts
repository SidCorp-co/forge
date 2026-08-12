import { and, eq, isNull } from 'drizzle-orm';
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
 * Idempotent: by default only unread rows match, so a repeat call after the
 * condition has already cleared updates nothing and emits nothing. Best-effort
 * by contract — failures are logged, never thrown, so the originating
 * transition still succeeds.
 *
 * `opts.includeRead` (ISS-652): also stamp `resolvedAt` on already-READ rows
 * still active (`resolved_at IS NULL`). Ops-alert dedup uses a partial unique
 * index scoped to `resolved_at IS NULL`, so an acknowledged (read) alert that
 * kept `resolved_at NULL` would block a later same-severity recurrence from
 * inserting — the incident would clear from the bell but never re-fire. Clearing
 * read rows on the healthy pass ends the episode so a recurrence can claim a
 * fresh row. Acknowledgement still suppresses re-notification WHILE the condition
 * is active (this path runs only when the alert has returned to `ok`).
 *
 * @returns the number of rows cleared.
 */
export async function resolveNotifications(
  resolutionKey: string,
  opts: { includeRead?: boolean } = {},
): Promise<number> {
  if (!resolutionKey) return 0;
  try {
    const activeFilter = opts.includeRead
      ? isNull(notifications.resolvedAt)
      : eq(notifications.read, false);
    const cleared = await db
      .update(notifications)
      .set({ read: true, resolvedAt: new Date() })
      .where(and(eq(notifications.resolutionKey, resolutionKey), activeFilter))
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
