import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { deviceStatuses } from '../db/schema.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import {
  type AuthVars,
  assertEmailVerified,
  authUserRow,
  requireAuth,
} from '../middleware/auth.js';
import { onAdminList, requireAdmin } from '../middleware/require-admin.js';
import { zValidator } from '../middleware/zod-validator.js';
import { computeAlerts } from './alert-queries.js';
import { listAdminAudit, listAdminDevices, listAdminProjects, listAdminUsers } from './read.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});

const devicesQuerySchema = paginationSchema.extend({
  status: z.enum(deviceStatuses).optional(),
});

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
  since: z.iso.datetime().optional(),
});

export const adminRoutes = new Hono<{ Variables: AuthVars }>();

const adminProtected = new Hono<{ Variables: AuthVars }>();
adminProtected.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminProtected.get(
  '/users',
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { limit, offset, q } = c.req.valid('query');
    const { rows, total } = await listAdminUsers({ limit, offset, q });
    return c.json(listResponse(c, rows, total, { limit, offset }));
  },
);

adminProtected.get(
  '/projects',
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { limit, offset, q } = c.req.valid('query');
    const { rows, total } = await listAdminProjects({ limit, offset, q });
    return c.json(listResponse(c, rows, total, { limit, offset }));
  },
);

adminProtected.get(
  '/devices',
  zValidator('query', devicesQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { limit, offset, status } = c.req.valid('query');
    const { rows, total } = await listAdminDevices({ limit, offset, status });
    return c.json(listResponse(c, rows, total, { limit, offset }));
  },
);

adminProtected.get(
  '/audit',
  zValidator('query', auditQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { limit, offset, action, actorId, since } = c.req.valid('query');
    const { rows, total } = await listAdminAudit({
      limit,
      offset,
      action,
      actorId,
      since: since ? new Date(since) : undefined,
    });
    return c.json(listResponse(c, rows, total, { limit, offset }));
  },
);

const whoamiRoutes = new Hono<{ Variables: AuthVars }>();
whoamiRoutes.use('*', requireAuth(), assertEmailVerified());
whoamiRoutes.get('/whoami', async (c) => {
  const row = await authUserRow(c, c.get('userId'));
  if (!row) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }
  return c.json({ isAdmin: onAdminList(row.email), email: row.email });
});

adminRoutes.route('/', whoamiRoutes);
adminRoutes.route('/', adminProtected);

export { adminAggregateRoutes } from './aggregate-routes.js';

const alertsQuerySchema = z.object({
  staleSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
});

export const adminAlertRoutes = new Hono<{ Variables: AuthVars }>();
adminAlertRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminAlertRoutes.get(
  '/alerts',
  zValidator('query', alertsQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { staleSeconds } = c.req.valid('query');
    const alerts = await computeAlerts(staleSeconds === undefined ? {} : { staleSeconds });
    return c.json(listResponse(c, alerts, alerts.length, { limit: alerts.length, offset: 0 }));
  },
);
