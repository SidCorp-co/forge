import type { NotificationRefusalCode } from '@forge/contracts/notifications';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { fromPage, listResponse } from '../lib/pagination.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { listDeliveries } from './deliveries-read.js';
import { deliveryMembers, openNotificationCount } from './read.js';
import { deleteDelivery, markAllDeliveriesRead, setDeliveryRead } from './service.js';

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

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const refuse = refuser<NotificationRefusalCode>('NOTIFICATION_REFUSED');

export const notificationRoutes = new Hono<{ Variables: AuthVars }>();
notificationRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * How many things are still true for the caller.
 *
 * ISS-1063 replaced `GET /unread-count` with this rather than redefining it: a route
 * named `unread-count` returning an open count is a silent substitution, and web-v2's
 * only caller moved in the same change. The count is over DISTINCT RECORDS reachable
 * through the caller's deliveries, not over deliveries — a grouped delivery carrying
 * fifteen firing parks reads fifteen, and resolving one of them reads fourteen.
 */
notificationRoutes.get('/open-count', zValidator('query', openCountQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const userId = c.get('userId');

  return c.json({ count: await openNotificationCount(userId, projectId) });
});

notificationRoutes.post('/mark-all-read', zValidator('json', markAllReadBodySchema), async (c) => {
  const userId = c.get('userId');
  return c.json({ updated: await markAllDeliveriesRead(userId) });
});

notificationRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { projectId, openOnly, page, pageSize } = c.req.valid('query');
  const userId = c.get('userId');

  const { items, total } = await listDeliveries(userId, { projectId, openOnly, page, pageSize });
  return c.json(listResponse(c, items, total, fromPage(page, pageSize)));
});

/**
 * Mark one delivery read, or unread.
 *
 * ISS-1063 — this writes `notification_deliveries.read_at` and NOTHING else. It cannot
 * resolve anything: a condition is resolved by the system re-evaluating it, and a task by
 * the two routes below.
 */
notificationRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', patchBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { read } = c.req.valid('json');
    const userId = c.get('userId');

    const row = await setDeliveryRead(id, userId, read);
    if (!row) throw notFound('notification not found');
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
notificationRoutes.get('/:id/members', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const rows = await deliveryMembers(id, userId);
  if (!rows) throw notFound('notification not found');
  return c.json(rows);
});

notificationRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  const outcome = await deleteDelivery(id, userId);
  if (!outcome.ok && outcome.code === 'NOT_FOUND') throw notFound('notification not found');
  if (!outcome.ok && outcome.code === 'CONDITION_STILL_TRUE') {
    const { live } = outcome;
    throw refuse(
      'CONDITION_STILL_TRUE',
      `This notification carries a condition that is still true — '${live.title}' ` +
        `(${live.type}) — and deleting it would only mean being told again on the next ` +
        'sweep. A condition ends when the system sees it end.',
    );
  }
  return c.body(null, 204);
});
