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
    // cm:guard take the pre-update `read` from a LOCKED pre-image in the SAME statement, never from a separate earlier SELECT — RETURNING yields the NEW row, where `read` is always true and cannot tell an unread row from one the operator had already opened, and the hook decrements a client-side unread count so emitting it twice for one row double-counts. A prior read-then-update pair was safe only while each resolution key had exactly ONE clearer; `paused:<runId>` (ISS-879) has two — the run-left-paused subscriber and the empty-queue sweep — and they can both see the row unread before either commits. The sub-SELECT's `FOR UPDATE` is the ONLY re-check of `resolved_at IS NULL` before the write — the UPDATE's own WHERE is just the `n.id = prev.id` join — so removing it lets both callers claim the same row and emit. Held by construction, not by a test: the concurrent e2e case passes against the pre-fix shape too, because that harness cannot interleave the two statements.
    // cm:guard match the UPDATE on `resolved_at IS NULL`, NOT on `read = false` — the two answer different questions ("has the condition cleared" vs "has a human looked") and this filter was once the second. A row the operator had already opened could never be stamped, so `resolved_at` stayed NULL forever on exactly the notifications someone was paying attention to; emitPipelineWedge's dedupe reads that column, so a read-then-fixed wedge would be suppressed permanently.
    // cm:why `ORDER BY id` on the locking sub-select — two concurrent clearers of the same key take the row locks in the same order, so they queue instead of deadlocking
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
