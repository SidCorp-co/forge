import { and, countDistinct, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
  projects,
} from '../db/schema.js';
import { issueDisplayIds } from '../issues/index.js';
import { stillTrue } from './read.js';
import { deliveryLine, deliverySubject } from './subject.js';

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
      severity: sql<string>`min(${notifications.severity})`,
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
          .select({ id: projects.id, slug: projects.slug, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
  ]);
  const slugs = new Map(slugRows.map((p) => [p.id, p.slug]));
  const named = new Map(slugRows.map((p) => [p.id, { slug: p.slug, name: p.name }]));
  const items = rows.map((r) => {
    const subject = deliverySubject(r, issueKeys, slugs);
    const project = r.projectId ? (named.get(r.projectId) ?? null) : null;
    return { ...r, subject, project, line: deliveryLine(r.title, subject?.key ?? null) };
  });
  return { items, total: totalRow?.n ?? 0 };
}
