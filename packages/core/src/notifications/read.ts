import { and, countDistinct, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
} from '../db/schema.js';

/**
 * ISS-1063 — what "still true for me" means, in one place.
 *
 * A `condition` that is `firing` and a `task` that is `open` or `acknowledged`. A
 * `signal` is never here: an event cannot stop having happened, so counting one as open
 * is what made the owner's bell read 5663 while 3914 of those rows were status changes.
 * A `pending` or `inhibited` condition is not here either — nobody was told about it.
 */
export const stillTrue = sql`(
  (${notifications.kind} = 'condition' AND ${notifications.state} = 'firing')
  OR (${notifications.kind} = 'task' AND ${notifications.state} IN ('open', 'acknowledged'))
)`;

/**
 * How many distinct records reachable through the caller's deliveries are still true — a
 * grouped delivery carrying fifteen firing parks reads fifteen.
 */
export async function openNotificationCount(
  userId: string,
  projectId: string | undefined,
): Promise<number> {
  const conditions = [
    eq(notificationDeliveries.userId, userId),
    eq(notificationDeliveries.resolvedNotice, false),
    isNull(notifications.resolvedAt),
    stillTrue,
  ];
  if (projectId) conditions.push(eq(notifications.projectId, projectId));

  const [row] = await db
    .select({ n: countDistinct(notifications.id) })
    .from(notificationDeliveries)
    .innerJoin(
      notificationDeliveryMembers,
      eq(notificationDeliveryMembers.deliveryId, notificationDeliveries.id),
    )
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(and(...conditions));
  return row?.n ?? 0;
}

/** Whether `deliveryId` is one of the caller's deliveries. */
export async function ownsDelivery(deliveryId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.userId, userId)),
    )
    .limit(1);
  return row !== undefined;
}

/** The records behind one delivery, still-open ones first, then newest first; null when not the caller's. */
export async function deliveryMembers(deliveryId: string, userId: string) {
  if (!(await ownsDelivery(deliveryId, userId))) return null;
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      kind: notifications.kind,
      state: notifications.state,
      title: notifications.title,
      body: notifications.body,
      severity: notifications.severity,
      projectId: notifications.projectId,
      issueId: notifications.issueId,
      secondaryIssueId: notifications.secondaryIssueId,
      resolvedAt: notifications.resolvedAt,
      createdAt: notifications.createdAt,
      open: sql<boolean>`(${notifications.resolvedAt} IS NULL AND ${stillTrue})`,
    })
    .from(notificationDeliveryMembers)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(eq(notificationDeliveryMembers.deliveryId, deliveryId))
    .orderBy(
      desc(sql`(${notifications.resolvedAt} IS NULL AND ${stillTrue})`),
      desc(notifications.createdAt),
    );
}

/** A condition this delivery carries that is still live, if any. */
export async function liveConditionOf(
  deliveryId: string,
): Promise<{ title: string; type: string } | null> {
  const [live] = await db
    .select({ title: notifications.title, type: notifications.type })
    .from(notificationDeliveryMembers)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(
      and(
        eq(notificationDeliveryMembers.deliveryId, deliveryId),
        eq(notifications.kind, 'condition'),
        isNull(notifications.resolvedAt),
        inArray(notifications.state, ['pending', 'firing', 'inhibited']),
      ),
    )
    .limit(1);
  return live ?? null;
}
