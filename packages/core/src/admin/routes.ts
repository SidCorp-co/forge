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
import {
  listAdminAudit,
  listAdminDevices,
  listAdminProjects,
  listAdminUsers,
  readRetrievalBreakdown,
} from './read.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});

const devicesQuerySchema = paginationSchema.extend({
  status: z.enum(deviceStatuses).optional(),
});

const retrievalBreakdownQuerySchema = z.object({
  projectId: z.uuid(),
  since: z.iso.datetime().optional(),
});

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
  since: z.iso.datetime().optional(),
});

export const adminRoutes = new Hono<{ Variables: AuthVars }>();

const adminProtected = new Hono<{ Variables: AuthVars }>();
adminProtected.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

const RETRIEVAL_BREAKDOWN_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

adminProtected.get(
  '/retrieval/breakdown',
  zValidator('query', retrievalBreakdownQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, since } = c.req.valid('query');
    const sinceDate = since
      ? new Date(since)
      : new Date(Date.now() - RETRIEVAL_BREAKDOWN_DEFAULT_WINDOW_MS);
    const rows = await readRetrievalBreakdown(projectId, sinceDate);
    return c.json({ projectId, since: sinceDate.toISOString(), strategies: rows });
  },
);

adminProtected.get(
  '/users',
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
