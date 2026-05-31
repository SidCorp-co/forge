import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notifications, userPreferences } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z.object({
  projectId: z.uuid().optional(),
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const unreadCountQuerySchema = z.object({
  projectId: z.uuid().optional(),
});

const markAllReadBodySchema = z
  .object({
    projectId: z.uuid().optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    read: z.boolean(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const notificationRoutes = new Hono<{ Variables: AuthVars }>();
notificationRoutes.use('*', requireAuth(), assertEmailVerified());

notificationRoutes.get(
  '/unread-count',
  zValidator('query', unreadCountQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const conditions = [eq(notifications.userId, userId), eq(notifications.read, false)];
    if (projectId) conditions.push(eq(notifications.projectId, projectId));

    const [row] = await db
      .select({ n: count() })
      .from(notifications)
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
    const { projectId } = c.req.valid('json');
    const userId = c.get('userId');

    const conditions = [eq(notifications.userId, userId), eq(notifications.read, false)];
    if (projectId) conditions.push(eq(notifications.projectId, projectId));

    const updated = await db
      .update(notifications)
      .set({ read: true })
      .where(and(...conditions))
      .returning({ id: notifications.id });

    return c.json({ updated: updated.length });
  },
);

notificationRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, unreadOnly, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const conditions = [eq(notifications.userId, userId)];
    if (projectId) conditions.push(eq(notifications.projectId, projectId));
    if (unreadOnly) conditions.push(eq(notifications.read, false));

    const where = and(...conditions);

    const [totalRow] = await db.select({ n: count() }).from(notifications).where(where);
    setTotalCount(c, totalRow?.n ?? 0);

    const rows = await db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json(rows);
  },
);

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
      .update(notifications)
      .set({ read })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning();
    const row = updated[0];
    if (!row) throw notFound('notification not found');

    if (read) {
      await hooks.emit('notificationRead', { notificationId: row.id, userId });
    }

    return c.json(row);
  },
);

notificationRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const deleted = await db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (deleted.length === 0) throw notFound('notification not found');

    return c.body(null, 204);
  },
);

/**
 * Internal helper for hook subscribers to create a notification.
 * Inserts the row, then emits `notificationCreated` so WS bridges can publish
 * to `userRoom(userId)`. There is no public POST endpoint — notifications are
 * always produced server-side by domain events.
 */
export async function createNotification(input: {
  userId: string;
  projectId?: string | null;
  type: 'issue_status_changed' | 'comment_added' | 'agent_completed' | 'mention';
  title: string;
  body?: string | null;
  issueId?: string | null;
  agentSessionId?: string | null;
}): Promise<{ id: string } | null> {
  // Delivery preference gate: a user can opt out of `mention` notifications via
  // `user_preferences.notify_on_mention` (Settings → Notifications). Default is
  // opted-in, so an absent preferences row notifies as before. Only `mention`
  // is gated — it is the only user-initiated type; system/escalation types are
  // always delivered.
  if (input.type === 'mention') {
    const [prefs] = await db
      .select({ notifyOnMention: userPreferences.notifyOnMention })
      .from(userPreferences)
      .where(eq(userPreferences.userId, input.userId))
      .limit(1);
    if (prefs && !prefs.notifyOnMention) return null;
  }

  const inserted = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      projectId: input.projectId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      issueId: input.issueId ?? null,
      agentSessionId: input.agentSessionId ?? null,
    })
    .returning({ id: notifications.id });
  const row = inserted[0];
  if (!row) throw new Error('notifications: insert returned no row');

  await hooks.emit('notificationCreated', {
    notificationId: row.id,
    userId: input.userId,
    projectId: input.projectId ?? null,
    type: input.type,
    title: input.title,
    issueId: input.issueId ?? null,
    agentSessionId: input.agentSessionId ?? null,
  });

  return { id: row.id };
}
