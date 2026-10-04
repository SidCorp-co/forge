import { and, countDistinct, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notificationSilences,
  notifications,
  projects,
} from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { deliveryLine, deliverySubject } from './subject.js';

/**
 * ISS-1063 — what "still true for me" means, in one place.
 *
 * A `condition` that is `firing` and a `task` that is `open` or `acknowledged`. A
 * `signal` is never here: an event cannot stop having happened, so counting one as open
 * is what made the owner's bell read 5663 while 3914 of those rows were status changes.
 * A `pending` or `inhibited` condition is not here either — nobody was told about it.
 */
const stillTrue = sql`(
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

/** One page of the caller's deliveries, newest first, each with its subject and line. */
export async function listDeliveries(
  userId: string,
  q: { projectId?: string | undefined; openOnly: boolean; page: number; pageSize: number },
) {
  const conditions = [eq(notificationDeliveries.userId, userId)];
  if (q.projectId) conditions.push(eq(notifications.projectId, q.projectId));
  if (q.openOnly) {
    conditions.push(isNull(notifications.resolvedAt));
    conditions.push(stillTrue);
  }
  const where = and(...conditions);

  const [totalRow] = await db
    .select({ n: countDistinct(notificationDeliveries.id) })
    .from(notificationDeliveries)
    .innerJoin(
      notificationDeliveryMembers,
      eq(notificationDeliveryMembers.deliveryId, notificationDeliveries.id),
    )
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(where);

  const rows = await db
    .select({
      id: notificationDeliveries.id,
      readAt: notificationDeliveries.readAt,
      groupKey: notificationDeliveries.groupKey,
      resolvedNotice: notificationDeliveries.resolvedNotice,
      createdAt: notificationDeliveries.createdAt,
      members: sql<number>`count(${notificationDeliveryMembers.notificationId})::int`,
      openMembers: sql<number>`(count(*) FILTER (WHERE ${notifications.resolvedAt} IS NULL AND ${stillTrue}))::int`,
      type: sql<string>`min(${notifications.type})`,
      kind: sql<string>`min(${notifications.kind})`,
      tier: sql<string>`min(${notifications.tier})`,
      title: sql<string>`coalesce(${notificationDeliveries.title}, min(${notifications.title}))`,
      body: sql<string | null>`min(${notifications.body})`,
      severity: sql<string | null>`min(${notifications.severity})`,
      projectId: sql<string | null>`min(${notifications.projectId}::text)`,
      issueId: sql<string | null>`min(${notifications.issueId}::text)`,
      secondaryIssueId: sql<string | null>`min(${notifications.secondaryIssueId}::text)`,
      agentSessionId: sql<string | null>`min(${notifications.agentSessionId}::text)`,
      notificationId: sql<string>`min(${notifications.id}::text)`,
    })
    .from(notificationDeliveries)
    .innerJoin(
      notificationDeliveryMembers,
      eq(notificationDeliveryMembers.deliveryId, notificationDeliveries.id),
    )
    .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
    .where(where)
    .groupBy(notificationDeliveries.id, notificationDeliveries.title)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const distinct = (ids: (string | null)[]) => [
    ...new Set(ids.filter((i): i is string => i !== null)),
  ];
  const projectIds = distinct(rows.map((r) => r.projectId));
  const [issueKeys, slugRows] = await Promise.all([
    issueDisplayIds(distinct(rows.map((r) => (r.members === 1 ? r.issueId : null)))),
    projectIds.length
      ? db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
  ]);
  const slugs = new Map(slugRows.map((p) => [p.id, p.slug]));
  const items = rows.map((r) => {
    const subject = deliverySubject(r, issueKeys, slugs);
    return { ...r, subject, line: deliveryLine(r.title, r.type, subject?.key ?? null) };
  });
  return { items, total: totalRow?.n ?? 0 };
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

/** The caller's unexpired silences, newest first. */
export async function listActiveSilences(userId: string) {
  return db
    .select()
    .from(notificationSilences)
    .where(
      and(eq(notificationSilences.createdBy, userId), gt(notificationSilences.expiresAt, new Date())),
    )
    .orderBy(desc(notificationSilences.createdAt));
}
