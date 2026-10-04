import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type NotificationType,
  notificationDeliveries,
  notificationDeliveryMembers,
  notificationSilences,
  notifications,
} from '../db/schema.js';
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

/** Close the tasks this delivery carries; a condition is not reachable from here. Null when not the caller's. */
export async function closeDeliveryTasks(
  deliveryId: string,
  userId: string,
  to: 'done' | 'dismissed',
): Promise<{ closed: number } | null> {
  if (!(await ownsDelivery(deliveryId, userId))) return null;

  const memberIds = await db
    .select({ id: notificationDeliveryMembers.notificationId })
    .from(notificationDeliveryMembers)
    .where(eq(notificationDeliveryMembers.deliveryId, deliveryId));
  if (memberIds.length === 0) return { closed: 0 };

  const closed = await db
    .update(notifications)
    .set({ state: to, resolvedAt: new Date() })
    .where(
      and(
        inArray(
          notifications.id,
          memberIds.map((m) => m.id),
        ),
        eq(notifications.kind, 'task'),
        isNull(notifications.resolvedAt),
      ),
    )
    .returning({ id: notifications.id });
  return { closed: closed.length };
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

/** A silence the caller states, until `expiresAt`. */
export async function createSilence(input: {
  createdBy: string;
  type: NotificationType | null;
  projectId: string | null;
  resolutionKey: string | null;
  reason: string;
  expiresAt: Date;
}) {
  const [row] = await db.insert(notificationSilences).values(input).returning();
  return row;
}

/** One of the caller's silences, ended now; false when it is not theirs. */
export async function endSilence(silenceId: string, userId: string): Promise<boolean> {
  const updated = await db
    .update(notificationSilences)
    .set({ expiresAt: new Date() })
    .where(and(eq(notificationSilences.id, silenceId), eq(notificationSilences.createdBy, userId)))
    .returning({ id: notificationSilences.id });
  return updated.length > 0;
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
}): Promise<{ id: string; delivered: number } | null> {
  const recipients = input.recipients ?? (input.userId ? [input.userId] : []);
  const result = await recordAndDeliver({ ...input, recipients });
  return result;
}
