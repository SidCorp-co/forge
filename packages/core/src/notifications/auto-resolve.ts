import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
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
    const cleared = await db.execute<{ id: string; user_id: string; was_unread: boolean }>(sql`
      UPDATE notifications n
      SET read = true, resolved_at = now()
      FROM (
        SELECT id, read FROM notifications
        WHERE resolution_key = ${resolutionKey} AND resolved_at IS NULL
        ORDER BY id
        FOR UPDATE
      ) prev
      WHERE n.id = prev.id
      RETURNING n.id, n.user_id, (NOT prev.read) AS was_unread
    `);

    for (const row of cleared) {
      if (!row.was_unread) continue;
      await hooks.emit('notificationRead', { notificationId: row.id, userId: row.user_id });
    }
    return cleared.length;
  } catch (err) {
    logger.error({ err, resolutionKey }, 'auto-resolve: resolveNotifications failed');
    return 0;
  }
}
