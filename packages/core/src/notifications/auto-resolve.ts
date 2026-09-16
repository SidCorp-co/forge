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
    // cm:guard take the pre-update `read` from a LOCKED pre-image in the SAME statement, never from a separate earlier SELECT — RETURNING yields the NEW row, where `read` is always true and cannot tell an unread row from one the operator had already opened, and the hook decrements a client-side unread count so emitting it twice for one row double-counts. A prior read-then-update pair was safe only while each resolution key had exactly ONE clearer; `paused:<runId>` (ISS-879) has two — the run-left-paused subscriber and the empty-queue sweep — and they can both see the row unread before either commits. The sub-SELECT's `FOR UPDATE` is the ONLY re-check of `resolved_at IS NULL` before the write — the UPDATE's own WHERE is just the `n.id = prev.id` join — so removing it lets both callers claim the same row and emit. Witnessed, not merely argued: `tests/integration/auto-resolve-concurrent-e2e.test.ts` forces the interleaving with a second connection holding the row lock, and without this clause the double-emit happens.
    // cm:guard match the UPDATE on `resolved_at IS NULL`, NOT on `read = false` — the two answer different questions ("has the condition cleared" vs "has a human looked") and this filter was once the second. A row the operator had already opened could never be stamped, so `resolved_at` stayed NULL forever on exactly the notifications someone was paying attention to; emitPipelineWedge's dedupe reads that column, so a read-then-fixed wedge would be suppressed permanently.
    // cm:why `ORDER BY id` on the locking sub-select — two concurrent clearers of the same key take the row locks in the same order, so they queue instead of deadlocking
    // cm:why ISS-1063 — the UPDATE no longer touches `read`, because `read` is not on this
    // table any more: it is `notification_deliveries.read_at`, it belongs to a person, and
    // resolving a record is the system saying the condition ended. The two stopped sharing
    // a row, so the pre-image this used to lock for its `read` value is no longer needed —
    // what it guarded against (two clearers both emitting for one row) is now guarded by
    // the same `FOR UPDATE` re-check of `resolved_at IS NULL`, which is what actually
    // serialized them.
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

/**
 * ISS-1063 — `send_resolved`: tell the condition ENDED to exactly the people who were
 * told it started, and to nobody else.
 *
 * Forge never said this before: a condition that cleared simply stopped being in the
 * list, so nobody could tell a problem that went away from one nobody had looked at. The
 * "and nobody else" half is what makes it safe — a record that was `pending`, `inhibited`
 * or silenced earned no delivery, so it announces nothing when it clears. Otherwise
 * inhibition would trade one burst of alarms for one burst of all-clears.
 */
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
    // cm:why the hook is `notificationCreated` and not `notificationRead`: a resolved
    // notice is a NEW delivery somebody has not seen. Firing the read event would
    // refresh the same query keys and look identical on the wire, which is exactly why
    // it would be the wrong one — the client would be told a thing was opened when a
    // thing was written.
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
