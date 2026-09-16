import { zValidator } from '@hono/zod-validator';
import { and, countDistinct, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import type { NotificationType } from '../db/schema.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
} from '../db/schema.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { recordAndDeliver } from './deliver.js';
import { silenceRoutes } from './silences-routes.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z.object({
  projectId: z.uuid().optional(),
  openOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const openCountQuerySchema = z.object({ projectId: z.uuid().optional() });
const markAllReadBodySchema = z.object({ projectId: z.uuid().optional() }).strict();
const patchBodySchema = z.object({ read: z.boolean() }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

/**
 * ISS-1063 — what "still true for me" means, in one place.
 *
 * A `condition` that is `firing` and a `task` that is `open` or `acknowledged`. A
 * `signal` is never here: an event cannot stop having happened, so counting one as open
 * is what made the owner's bell read 5663 while 3914 of those rows were status changes.
 * A `pending` or `inhibited` condition is not here either — nobody was told about it.
 */
// cm:guard this predicate is over `state`, never over `read`. The read state lives on the delivery and answers whether a human looked; putting it in here is the defect ISS-1063 was filed about, and it is the one thing this whole module exists to keep apart.
const stillTrue = sql`(
  (${notifications.kind} = 'condition' AND ${notifications.state} = 'firing')
  OR (${notifications.kind} = 'task' AND ${notifications.state} IN ('open', 'acknowledged'))
)`;

export const notificationRoutes = new Hono<{ Variables: AuthVars }>();
notificationRoutes.use('*', requireAuth(), assertEmailVerified());
notificationRoutes.route('/silences', silenceRoutes);

/**
 * How many things are still true for the caller.
 *
 * ISS-1063 replaced `GET /unread-count` with this rather than redefining it: a route
 * named `unread-count` returning an open count is a silent substitution, and web-v2's
 * only caller moved in the same change. The count is over DISTINCT RECORDS reachable
 * through the caller's deliveries, not over deliveries — a grouped delivery carrying
 * fifteen firing parks reads fifteen, and resolving one of them reads fourteen.
 */
notificationRoutes.get(
  '/open-count',
  zValidator('query', openCountQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

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

    return c.json({ count: row?.n ?? 0 });
  },
);

notificationRoutes.post(
  '/mark-all-read',
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
    return c.json({ updated: updated.length });
  },
);

notificationRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, openOnly, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const conditions = [eq(notificationDeliveries.userId, userId)];
    if (projectId) conditions.push(eq(notifications.projectId, projectId));
    if (openOnly) {
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

    // cm:why one row per DELIVERY with its member count, not one per record: a grouped
    // delivery is one line in the bell naming fifteen parks, and the reader expands it.
    const rows = await db
      .select({
        id: notificationDeliveries.id,
        readAt: notificationDeliveries.readAt,
        groupKey: notificationDeliveries.groupKey,
        resolvedNotice: notificationDeliveries.resolvedNotice,
        createdAt: notificationDeliveries.createdAt,
        // cm:why the explicit `::int` on both counts: postgres returns `count()` as bigint, which reaches JSON as a STRING. The web compares it (`members > 1`) and prints it, and a string that coerces in every comparison it happens to be in is the kind of wrong that shows up as one odd row months later.
        members: sql<number>`count(${notificationDeliveryMembers.notificationId})::int`,
        openMembers: sql<number>`(count(*) FILTER (WHERE ${notifications.resolvedAt} IS NULL AND ${stillTrue}))::int`,
        type: sql<string>`min(${notifications.type})`,
        kind: sql<string>`min(${notifications.kind})`,
        tier: sql<string>`min(${notifications.tier})`,
        // cm:why the delivery's own title wins: a grouped delivery names the cause the fifteen share, and `min()` over its members would pick one of the fifteen at random
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
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json(listResponse(c, rows, totalRow?.n ?? 0, fromPage(page, pageSize)));
  },
);

/**
 * Mark one delivery read, or unread.
 *
 * ISS-1063 — this writes `notification_deliveries.read_at` and NOTHING else. It cannot
 * resolve anything: a condition is resolved by the system re-evaluating it, and a task by
 * the two routes below.
 */
notificationRoutes.patch(
  '/:id',
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
    return c.json(row);
  },
);

/**
 * The records behind one delivery.
 *
 * ISS-1063 — grouping turns fifteen bell rows into one, and without this route that is a
 * loss: the reader would be told fifteen issues are parked and given no way to reach any
 * of them. The list route answers the counts; this answers the members, newest first,
 * still-open ones first.
 */
notificationRoutes.get(
  '/:id/members',
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
        issueId: notifications.issueId,
        secondaryIssueId: notifications.secondaryIssueId,
        resolvedAt: notifications.resolvedAt,
        createdAt: notifications.createdAt,
        open: sql<boolean>`(${notifications.resolvedAt} IS NULL AND ${stillTrue})`,
      })
      .from(notificationDeliveryMembers)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveryMembers.notificationId))
      .where(eq(notificationDeliveryMembers.deliveryId, id))
      .orderBy(
        desc(sql`(${notifications.resolvedAt} IS NULL AND ${stillTrue})`),
        desc(notifications.createdAt),
      );

    return c.json(rows);
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

  // cm:guard scoped to `kind = 'task'`, and that scope is the whole point. A person may
  // finish work; a person may not declare that a condition stopped being true. Widen this
  // and the open count becomes a number people can change by looking at it again.
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
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => c.json(await closeTasks(c.req.valid('param').id, c.get('userId'), state)),
  );
}

notificationRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const deleted = await db
      .delete(notificationDeliveries)
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.userId, userId)))
      .returning({ id: notificationDeliveries.id });
    if (deleted.length === 0) throw notFound('notification not found');
    return c.body(null, 204);
  },
);

/**
 * The internal producer surface, kept at its old name and its old shape so that every
 * emitter did not have to move in the same change as the schema.
 *
 * ISS-1063 — `userId` became `recipients`, because one condition told to six admins is
 * one record and six deliveries rather than six records. Everything else this used to do
 * — the mention preference gate, the row insert, the `notificationCreated` hook — now
 * lives in `deliver.ts`, alongside the four things that decide whether anybody is told.
 */
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
  severity?: string | null;
  resolutionKey?: string | null;
  dedupeKey?: string | null;
  decisionId?: string | null;
  groupKey?: string | null;
  groupTitle?: string | null;
}): Promise<{ id: string; delivered: number } | null> {
  const recipients = input.recipients ?? (input.userId ? [input.userId] : []);
  const result = await recordAndDeliver({ ...input, recipients });
  return result;
}
