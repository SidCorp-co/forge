import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { computeAlerts } from './alert-queries.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const alertsQuerySchema = z.object({
  staleSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
});

export const adminAlertRoutes = new Hono<{ Variables: AuthVars }>();
adminAlertRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminAlertRoutes.get(
  '/alerts',
  zValidator('query', alertsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { staleSeconds } = c.req.valid('query');
    const alerts = await computeAlerts(staleSeconds === undefined ? {} : { staleSeconds });
    return c.json(listResponse(c, alerts, alerts.length, { limit: alerts.length, offset: 0 }));
  },
);
