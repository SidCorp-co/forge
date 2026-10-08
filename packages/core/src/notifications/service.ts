import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
} from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';
import { liveConditionOf, ownsDelivery } from './read.js';

/** Every unread delivery of the caller, marked read; answers how many. */
export async function markAllDeliveriesRead(userId: string): Promise<number> {
  const updated = await db
    .update(notificationDeliveries)
    .set({ readAt: new Date() })
    .where(and(eq(notificationDeliveries.userId, userId), isNull(notificationDeliveries.readAt)))
    .returning({ id: notificationDeliveries.id });
  return updated.length;
}

/** One of the caller's deliveries, marked read or unread; null when it is not theirs. */
export async function setDeliveryRead(deliveryId: string, userId: string, read: boolean) {
  return db.transaction(async (tx) => {
    const [marked] = await tx
      .update(notificationDeliveries)
      .set({ readAt: read ? new Date() : null })
      .where(
        and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.userId, userId)),
      )
      .returning();
    if (marked && read) {
      await emitEvent(tx, 'notification.read', { notificationId: marked.id, userId });
    }
    return marked ?? null;
  });
}

type DeleteDeliveryOutcome =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'CONDITION_STILL_TRUE'; live: { title: string; type: string } };

/** One of the caller's deliveries, deleted — unless it carries a condition that is still true. */
export async function deleteDelivery(
  deliveryId: string,
  userId: string,
): Promise<DeleteDeliveryOutcome> {
  if (!(await ownsDelivery(deliveryId, userId))) return { ok: false, code: 'NOT_FOUND' };
  const live = await liveConditionOf(deliveryId);
  if (live) return { ok: false, code: 'CONDITION_STILL_TRUE', live };
  await db.delete(notificationDeliveries).where(eq(notificationDeliveries.id, deliveryId));
  return { ok: true };
}

/** The caller's unread deliveries of the notices that carried one status report, marked read on opening it. */
export async function markStatusReportRead(
  userId: string,
  statusReportId: string,
): Promise<number> {
  const carrying = db
    .select({ id: notificationDeliveryMembers.deliveryId })
    .from(notificationDeliveryMembers)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(eq(notifications.statusReportId, statusReportId));
  const updated = await db
    .update(notificationDeliveries)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationDeliveries.userId, userId),
        isNull(notificationDeliveries.readAt),
        inArray(notificationDeliveries.id, carrying),
      ),
    )
    .returning({ id: notificationDeliveries.id });
  return updated.length;
}
