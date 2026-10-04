import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type NotificationType, notificationDeliveries } from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';
import { recordAndDeliver } from './deliver.js';
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

export type DeleteDeliveryOutcome =
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

export async function createNotification(input: {
  userId?: string;
  recipients?: string[];
  projectId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  issueId?: string | null;
  secondaryIssueId?: string | null;
  agentSessionId?: string | null;
  scheduleRunId?: string | null;
  severity?: string | null;
  resolutionKey?: string | null;
  dedupeKey?: string | null;
  groupKey?: string | null;
  groupTitle?: string | null;
}): Promise<{ id: string; delivered: number }> {
  const recipients = input.recipients ?? (input.userId ? [input.userId] : []);
  return recordAndDeliver({ ...input, recipients });
}
