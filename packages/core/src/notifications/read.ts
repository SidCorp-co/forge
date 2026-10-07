import { and, count, desc, eq, exists, inArray, isNull, type SQL, sql } from 'drizzle-orm';
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
 * ISS-289 — what an open delivery is, in one place: not a resolved notice, and carrying at least one
 * record still true (in `projectId`, where given). The badge counts these and the bell lists them, so
 * the two cannot read different populations. It selects the delivery and leaves its records alone: a
 * group of three with two still firing is listed reading 2 of 3, never 2 of 2.
 */
export function openDelivery(projectId?: string): SQL {
  const openRecord = db
    .select({ one: sql`1` })
    .from(notificationDeliveryMembers)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(
      and(
        eq(notificationDeliveryMembers.deliveryId, notificationDeliveries.id),
        isNull(notifications.resolvedAt),
        stillTrue,
        ...(projectId ? [eq(notifications.projectId, projectId)] : []),
      ),
    );
  return sql`(${eq(notificationDeliveries.resolvedNotice, false)} AND ${exists(openRecord)})`;
}

/**
 * How many of the caller's deliveries are open — the rows the bell lists. A grouped delivery
 * carrying fifteen firing parks is one row and reads one: counting its records put 136 on a badge
 * over a list of 21 open rows (FB-76).
 */
export async function openNotificationCount(
  userId: string,
  projectId: string | undefined,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.userId, userId), openDelivery(projectId)));
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
