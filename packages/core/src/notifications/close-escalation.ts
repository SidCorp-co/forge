/**
 * ISS-1063 — closing a `pm_escalation` task when its question is answered.
 *
 * This lives in `notifications/` rather than in `pm/routes.ts` for the reason the whole
 * issue is about: what a notification's state means is this module's to decide, and a
 * second module reaching into the table with its own idea of "handled" is how `read` came
 * to mean four different things. `pm/routes.ts` says the question was answered; this says
 * what that does to the record.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
} from '../db/schema.js';
import { hooks } from '../pipeline/hooks.js';

/**
 * Close every open escalation task carrying this decision, and mark read the deliveries
 * that carried them.
 *
 * Both halves, because they are different facts and both are true here: the work the task
 * asked for is DONE (so it stops counting as open, where marking it read used to leave it
 * counting for ever), and the person who answered has plainly SEEN it.
 *
 * @returns how many escalation records were closed.
 */
export async function closeEscalationTasks(projectId: string, decisionId: string): Promise<number> {
  const closed = await db
    .update(notifications)
    .set({ state: 'done', resolvedAt: new Date() })
    .where(
      and(
        eq(notifications.type, 'pm_escalation'),
        eq(notifications.projectId, projectId),
        isNull(notifications.resolvedAt),
        sql`(${notifications.body}::jsonb->>'decisionId') = ${decisionId}`,
      ),
    )
    .returning({ id: notifications.id });

  for (const row of closed) {
    const told = await db
      .update(notificationDeliveries)
      .set({ readAt: new Date() })
      .where(
        and(
          isNull(notificationDeliveries.readAt),
          inArray(
            notificationDeliveries.id,
            db
              .select({ id: notificationDeliveryMembers.deliveryId })
              .from(notificationDeliveryMembers)
              .where(eq(notificationDeliveryMembers.notificationId, row.id)),
          ),
        ),
      )
      .returning({ userId: notificationDeliveries.userId });
    for (const t of told) {
      await hooks.emit('notificationRead', { notificationId: row.id, userId: t.userId });
    }
  }
  return closed.length;
}
