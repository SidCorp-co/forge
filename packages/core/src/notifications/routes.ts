import type { StuckIssueKind } from '@forge/contracts/notifications';
import { and, countDistinct, desc, eq, inArray, isNull, type SQLWrapper, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import type { NotificationType } from '../db/schema.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
  notificationTypes,
  projects,
} from '../db/schema.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { heldAsFailedJobWhere } from '../me/attention-failed-jobs.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { readPendingInvitations } from '../projects/pending-invitations.js';
import { readerStuckKindSql } from '../projects/stuck-issue-kinds.js';
import { recordAndDeliver } from './deliver.js';
import { explanationOfGroupKey } from './explanations.js';
import {
  closedSchema,
  deleteNotification,
  deliveryListSchema,
  deliveryMembersSchema,
  deliveryRowSchema,
  dismissNotification,
  doneNotification,
  listNotifications,
  markAllRead,
  markAllReadSchema,
  notificationMembers,
  openCount,
  openCountSchema,
  patchNotification,
} from './routes-reference.js';
import { silenceRoutes } from './silences-routes.js';
import { bellTitlesFor, retitledFor } from './waiting-titles.js';

const idParamSchema = z.object({ id: z.uuid() });

const flag = z
  .union([z.literal('true'), z.literal('false'), z.boolean()])
  .optional()
  .transform((v) => v === true || v === 'true');

const listQuerySchema = z.object({
  projectId: z.uuid().optional(),
  openOnly: flag,
  /** Only deliveries of this type — applied before the page is cut, so a page is all matches. */
  type: z.enum(notificationTypes).optional(),
  /** Only deliveries that are still unread, as {@link unreadDeliveryOf} reads it. */
  unread: flag,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const openCountQuerySchema = z.object({ projectId: z.uuid().optional() });
// A `projectId` was once accepted here and never narrowed the update, so a caller who sent one
// marked every project's notifications read. It is refused by name now.
const markAllReadBodySchema = z.object({}).strict();
const patchBodySchema = z.object({ read: z.boolean() }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (message: string) =>
  new HTTPException(409, { message, cause: { code: 'CONDITION_STILL_TRUE' } });

/**
 * A record about an archived project asks nothing of anyone: its project's page answers not found,
 * so the bell neither counts it nor lists a row made only of such records (ISS-1229 r15).
 */
const onLiveProject = (projectId: SQLWrapper) => sql`NOT EXISTS (
  SELECT 1 FROM projects ap WHERE ap.id = ${projectId} AND ap.archived_at IS NOT NULL
)`;

/**
 * ISS-1063 — what "still true for me" means, in one place.
 *
 * A `condition` that is `firing` and a `task` that is `open` or `acknowledged`. A
 * `signal` is never here: an event cannot stop having happened, so counting one as open
 * is what made the owner's bell read 5663 while 3914 of those rows were status changes.
 * A `pending` or `inhibited` condition is not here either — nobody was told about it.
 */
const stillTrueOf = (n: { kind: SQLWrapper; state: SQLWrapper; projectId: SQLWrapper }) => sql`(
  ((${n.kind} = 'condition' AND ${n.state} = 'firing')
    OR (${n.kind} = 'task' AND ${n.state} IN ('open', 'acknowledged')))
  AND ${onLiveProject(n.projectId)}
)`;
const stillTrue = stillTrueOf(notifications);

/**
 * One issue, one row (ISS-1229 r15, the master's ruling): a stuck-issue notice on an issue the reader's
 * failed jobs list is told there, as that failed job, so the bell neither counts nor lists it.
 */
const toldTo = (userId: string, n: { type: SQLWrapper; issueId: SQLWrapper }) => sql`NOT (
  ${n.type} = 'issue_stranded' AND EXISTS (
    SELECT 1 FROM issues WHERE issues.id = ${n.issueId} AND ${heldAsFailedJobWhere(userId)}
  )
)`;

/**
 * ISS-1168 — whether a delivery still asks to be read, as state and not as text.
 *
 * `read_at` says whether a PERSON looked, and nothing but a person writes it. Whether there is still
 * anything to look at is a fact about the records: a delivery that announces a resolution is history,
 * a delivery whose conditions and tasks have all ended has nothing left to ask, and an event cannot
 * end, so it asks until it is read. Deriving it keeps both facts true: resolving a condition writes
 * no read stamp for somebody who never looked, and the owner's inbox still stops demanding it.
 */
const carried = {
  kind: sql`cn.kind`,
  state: sql`cn.state`,
  projectId: sql`cn.project_id`,
  type: sql`cn.type`,
  issueId: sql`cn.issue_id`,
};
const unreadDeliveryOf = (userId: string) => sql`(
  ${notificationDeliveries.readAt} IS NULL
  AND NOT ${notificationDeliveries.resolvedNotice}
  AND EXISTS (
    SELECT 1 FROM notification_delivery_members cb
    JOIN notifications cn ON cn.id = cb.notification_id
    WHERE cb.delivery_id = ${notificationDeliveries.id}
      AND ${toldTo(userId, carried)}
      AND ((cn.kind = 'signal' AND ${onLiveProject(carried.projectId)})
        OR (cn.resolved_at IS NULL AND ${stillTrueOf(carried)}))
  )
)`;

export const notificationRoutes = new Hono<{ Variables: AuthVars }>();
notificationRoutes.use('*', requireAuth(), assertEmailVerified());
notificationRoutes.route('/silences', silenceRoutes);

/**
 * How many bell rows are still open for the caller: what the badge on the panel counts.
 *
 * ISS-1063 replaced `GET /unread-count` with this rather than redefining it: a route
 * named `unread-count` returning an open count is a silent substitution. It counted the
 * records inside the rows until ISS-1229 r13, when an Org Member's badge read 623 over three
 * grouped rows: the badge sits on the panel, so it counts what the panel shows — each row
 * carrying a record still true is one, however many records it groups. The panel offers an
 * invitation as the pending invitation, with Accept and Decline, and never as its
 * `invitation_received` record, so the count does the same (ISS-1229 r14): a record whose
 * invitation was accepted, declined or expired is counted by nothing the reader can see.
 */
notificationRoutes.get(
  '/open-count',
  openCount,
  zValidator('query', openCountQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const ofProject = projectId ? sql`AND cn.project_id = ${projectId}` : sql``;
    // A row spanning two projects belongs to neither, so it is counted once, in the whole count.
    const onlyThisProject = projectId
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM notification_delivery_members ob
          JOIN notifications cn ON cn.id = ob.notification_id
          WHERE ob.delivery_id = ${notificationDeliveries.id}
            AND cn.project_id IS DISTINCT FROM ${projectId}
            AND cn.type <> 'invitation_received'
            AND cn.resolved_at IS NULL
            AND ${stillTrueOf(carried)}
            AND ${toldTo(userId, carried)}
        )`
      : sql``;
    const [[row], invitations] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.userId, userId),
            eq(notificationDeliveries.resolvedNotice, false),
            sql`EXISTS (
              SELECT 1 FROM notification_delivery_members cb
              JOIN notifications cn ON cn.id = cb.notification_id
              WHERE cb.delivery_id = ${notificationDeliveries.id}
                AND cn.type <> 'invitation_received'
                AND cn.resolved_at IS NULL
                AND ${stillTrueOf(carried)}
                AND ${toldTo(userId, carried)}
                ${ofProject}
            ) ${onlyThisProject}`,
          ),
        ),
      readPendingInvitations(userId),
    ]);
    const offered = (invitations ?? []).filter(
      (inv) => projectId === undefined || inv.projectId === projectId,
    ).length;

    return c.json(answer(openCountSchema, { count: (row?.n ?? 0) + offered }));
  },
);

notificationRoutes.post(
  '/mark-all-read',
  markAllRead,
  zValidator('json', markAllReadBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const updated = await db
      .update(notificationDeliveries)
      .set({ readAt: new Date() })
      .where(and(eq(notificationDeliveries.userId, userId), isNull(notificationDeliveries.readAt)))
      .returning({ id: notificationDeliveries.id });
    return c.json(answer(markAllReadSchema, { updated: updated.length }));
  },
);

notificationRoutes.get(
  '/',
  listNotifications,
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, openOnly, type, unread, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    // The filters choose WHICH deliveries are listed; they never thin out what a listed delivery
    // carries, or a group seen through a project filter would read as the one record that survived.
    const ofRecords = [
      sql`cn.kind IS NOT NULL`,
      onLiveProject(carried.projectId),
      toldTo(userId, carried),
    ];
    const unreadDelivery = unreadDeliveryOf(userId);
    if (projectId) ofRecords.push(sql`cn.project_id = ${projectId}`);
    if (type) ofRecords.push(sql`cn.type = ${type}`);
    if (openOnly) ofRecords.push(sql`(cn.resolved_at IS NULL AND ${stillTrueOf(carried)})`);
    const conditions = [
      eq(notificationDeliveries.userId, userId),
      sql`EXISTS (
        SELECT 1 FROM notification_delivery_members cb
        JOIN notifications cn ON cn.id = cb.notification_id
        WHERE cb.delivery_id = ${notificationDeliveries.id} AND ${and(...ofRecords)}
      )`,
    ];
    if (unread) conditions.push(unreadDelivery);
    // One resolution, one row (ISS-1229 r13): a resolution notice stored before then is not listed
    // beside the row that raised its record, which reads resolved itself. Nothing stores one now.
    conditions.push(sql`NOT (${notificationDeliveries.resolvedNotice} AND EXISTS (
      SELECT 1 FROM notification_delivery_members rm
      JOIN notification_delivery_members om ON om.notification_id = rm.notification_id
      JOIN notification_deliveries od ON od.id = om.delivery_id
      WHERE rm.delivery_id = ${notificationDeliveries.id}
        AND od.user_id = ${notificationDeliveries.userId}
        AND NOT od.resolved_notice
    ))`);
    const where = and(...conditions);

    const [totalRow] = await db
      .select({ n: countDistinct(notificationDeliveries.id) })
      .from(notificationDeliveries)
      .where(where);

    // A delivery carrying several records belongs to none of them: its title is the cause, and the
    // body, the issue and the project are only reported where every record agrees, because `min()`
    // of three members is an arbitrary one of them (ISS-1168).
    const several = sql`count(*) > 1`;
    const rows = await db
      .select({
        id: notificationDeliveries.id,
        readAt: notificationDeliveries.readAt,
        groupKey: notificationDeliveries.groupKey,
        resolvedNotice: notificationDeliveries.resolvedNotice,
        createdAt: notificationDeliveries.createdAt,
        toldAt: sql<Date>`max(${notificationDeliveryMembers.deliveredAt})`.mapWith(
          notificationDeliveries.createdAt,
        ),
        unread: sql<boolean>`${unreadDelivery}`,
        members: sql<number>`count(${notificationDeliveryMembers.notificationId})::int`,
        openMembers: sql<number>`(count(*) FILTER (WHERE ${notifications.resolvedAt} IS NULL AND ${stillTrue}))::int`,
        type: sql<string>`min(${notifications.type})`,
        kind: sql<string>`min(${notifications.kind})`,
        tier: sql<string>`min(${notifications.tier})`,
        title: sql<string>`CASE WHEN ${notificationDeliveries.resolvedNotice} OR ${several} THEN coalesce(${notificationDeliveries.title}, min(${notifications.title})) ELSE min(${notifications.title}) END`,
        body: sql<
          string | null
        >`CASE WHEN ${notificationDeliveries.resolvedNotice} OR ${several} THEN NULL ELSE min(${notifications.body}) END`,
        severity: sql<string | null>`min(${notifications.severity})`,
        projectId: sql<
          string | null
        >`CASE WHEN count(DISTINCT ${notifications.projectId}) = 1 AND count(${notifications.projectId}) = count(*) THEN min(${notifications.projectId}::text) END`,
        issueId: sql<
          string | null
        >`CASE WHEN ${several} THEN NULL ELSE min(${notifications.issueId}::text) END`,
        secondaryIssueId: sql<
          string | null
        >`CASE WHEN ${several} THEN NULL ELSE min(${notifications.secondaryIssueId}::text) END`,
        agentSessionId: sql<
          string | null
        >`CASE WHEN ${several} THEN NULL ELSE min(${notifications.agentSessionId}::text) END`,
        notificationId: sql<string>`min(${notifications.id}::text)`,
        // The tag a stuck row wears is its kind's, which every record a sweep groups shares; a park
        // is told to this reader as theirs only where they owe it (ISS-1229 r16).
        stuckKind: sql<StuckIssueKind | null>`CASE WHEN min(${notifications.type}) = 'issue_stranded' THEN ${readerStuckKindSql(sql`min(${notifications.resolutionKey})`, sql`min(${notifications.issueId}::text)::uuid`, userId)} END`,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationDeliveryMembers,
        eq(notificationDeliveryMembers.deliveryId, notificationDeliveries.id),
      )
      // A row's figures are its live records': a grouped row holding an archived project's says nothing of it.
      .innerJoin(
        notifications,
        and(
          eq(notifications.id, notificationDeliveryMembers.notificationId),
          onLiveProject(notifications.projectId),
          toldTo(userId, notifications),
        ),
      )
      .where(where)
      .groupBy(notificationDeliveries.id, notificationDeliveries.title)
      .orderBy(
        desc(sql`max(${notificationDeliveryMembers.deliveredAt})`),
        desc(notificationDeliveries.createdAt),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const named = await projectsNamed(rows.map((r) => r.projectId));
    const titles = await bellTitlesFor(userId, rows);
    const items = rows.map((r, i) => ({
      ...r,
      title: titles[i] ?? r.title,
      explanation: explanationOfGroupKey(r.groupKey),
      projectSlug: (r.projectId && named.get(r.projectId)?.slug) || null,
      projectName: (r.projectId && named.get(r.projectId)?.name) || null,
    }));

    return c.json(
      answer(
        deliveryListSchema,
        listResponse(c, items, totalRow?.n ?? 0, fromPage(page, pageSize)),
      ),
    );
  },
);

/** The slug and name of each project a page of rows is about, in one read. */
async function projectsNamed(
  ids: readonly (string | null)[],
): Promise<Map<string, { slug: string; name: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const found = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, wanted));
  return new Map(found.map((p) => [p.id, { slug: p.slug, name: p.name }]));
}

/**
 * Mark one delivery read, or unread.
 *
 * ISS-1063 — this writes `notification_deliveries.read_at` and NOTHING else. It cannot
 * resolve anything: a condition is resolved by the system re-evaluating it, and a task by
 * the two routes below.
 */
notificationRoutes.patch(
  '/:id',
  patchNotification,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { read } = c.req.valid('json');
    const userId = c.get('userId');

    const updated = await db
      .update(notificationDeliveries)
      .set({ readAt: read ? new Date() : null })
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.userId, userId)))
      .returning();
    const row = updated[0];
    if (!row) throw notFound('notification not found');

    if (read) await hooks.emit('notificationRead', { notificationId: row.id, userId });
    return c.json(answer(deliveryRowSchema, row));
  },
);

/**
 * The records behind one delivery.
 *
 * ISS-1063 — grouping turns fifteen bell rows into one, and without this route that is a
 * loss: the reader would be told fifteen issues are parked and given no way to reach any
 * of them. The list route answers the counts; this answers the members, newest first: a condition
 * or task that has ended leaves the group, so nothing it said in the present tense is left standing
 * beside the ones still true (ISS-1229 r16). An event cannot end, so a group of events lists all.
 */
notificationRoutes.get(
  '/:id/members',
  notificationMembers,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [delivery] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.userId, userId)))
      .limit(1);
    if (!delivery) throw notFound('notification not found');

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        kind: notifications.kind,
        state: notifications.state,
        title: notifications.title,
        body: notifications.body,
        severity: notifications.severity,
        projectId: notifications.projectId,
        projectSlug: projects.slug,
        projectName: projects.name,
        issueId: notifications.issueId,
        secondaryIssueId: notifications.secondaryIssueId,
        resolvedAt: notifications.resolvedAt,
        createdAt: notifications.createdAt,
        deliveredAt: notificationDeliveryMembers.deliveredAt,
        open: sql<boolean>`(${notifications.resolvedAt} IS NULL AND ${stillTrue})`,
      })
      .from(notificationDeliveryMembers)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
      .leftJoin(projects, eq(projects.id, notifications.projectId))
      .where(
        and(
          eq(notificationDeliveryMembers.deliveryId, id),
          onLiveProject(notifications.projectId),
          toldTo(userId, notifications),
          sql`(${notifications.kind} = 'signal' OR (${notifications.resolvedAt} IS NULL AND ${stillTrue}))`,
        ),
      )
      .orderBy(desc(notificationDeliveryMembers.deliveredAt));

    return c.json(answer(deliveryMembersSchema, await retitledFor(userId, rows)));
  },
);

/** Close the tasks this delivery carries. A condition is not reachable from here. */
async function closeTasks(deliveryId: string, userId: string, to: 'done' | 'dismissed') {
  const [delivery] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.userId, userId)),
    )
    .limit(1);
  if (!delivery) throw notFound('notification not found');

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

for (const [path, state] of [
  ['/:id/done', 'done'],
  ['/:id/dismiss', 'dismissed'],
] as const) {
  notificationRoutes.post(
    path,
    state === 'done' ? doneNotification : dismissNotification,
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) =>
      c.json(
        answer(closedSchema, await closeTasks(c.req.valid('param').id, c.get('userId'), state)),
      ),
  );
}

notificationRoutes.delete(
  '/:id',
  deleteNotification,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const [own] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.userId, userId)))
      .limit(1);
    if (!own) throw notFound('notification not found');

    const [live] = await db
      .select({ title: notifications.title, type: notifications.type })
      .from(notificationDeliveryMembers)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
      .where(
        and(
          eq(notificationDeliveryMembers.deliveryId, id),
          eq(notifications.kind, 'condition'),
          isNull(notifications.resolvedAt),
          inArray(notifications.state, ['pending', 'firing', 'inhibited']),
        ),
      )
      .limit(1);
    if (live) {
      throw conflict(
        `This notification carries a condition that is still true — '${live.title}' ` +
          `(${live.type}) — and deleting it would only mean being told again on the next ` +
          'sweep. A condition ends when the system sees it end. To stop hearing about it ' +
          'meanwhile, POST /api/notifications/silences with a matcher and an expiry.',
      );
    }

    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    return c.body(null, 204);
  },
);

export async function createNotification(
  input: {
    userId?: string;
    recipients?: string[];
    projectId?: string | null;
    type: NotificationType;
    title: string;
    body?: string | null;
    issueId?: string | null;
    subject?: string | null;
    secondaryIssueId?: string | null;
    agentSessionId?: string | null;
    severity?: string | null;
    resolutionKey?: string | null;
    dedupeKey?: string | null;
    decisionId?: string | null;
    groupKey?: string | null;
    groupTitle?: string | null;
  },
  now?: Date,
): Promise<{ id: string; delivered: number } | null> {
  const recipients = input.recipients ?? (input.userId ? [input.userId] : []);
  return recordAndDeliver({ ...input, recipients }, now);
}
