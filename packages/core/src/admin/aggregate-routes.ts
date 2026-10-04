/**
 * Admin cross-tenant aggregate endpoints for the Operator Ops Console (Step 1,
 * ISS-651): GET /overview, /adoption, /workspaces. Own requireAdmin gate (like
 * `pipeline-health-routes.ts`) so this router can be imported standalone in a
 * vitest suite. The reads live in `read.ts`.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readAdminAdoption, readAdminOverview, readAdminWorkspaces } from './read.js';
import { GLANCE_WINDOWS } from './types.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const overviewQuerySchema = z.object({ window: z.enum(GLANCE_WINDOWS).default('24h') });

export const adminAggregateRoutes = new Hono<{ Variables: AuthVars }>();
adminAggregateRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminAggregateRoutes.get(
  '/overview',
  zValidator('query', overviewQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { window } = c.req.valid('query');
    return c.json(await readAdminOverview(window));
  },
);

const adoptionQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(52).default(12),
  bucket: z.enum(['week', 'day']).default('week'),
});

adminAggregateRoutes.get(
  '/adoption',
  zValidator('query', adoptionQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { weeks, bucket } = c.req.valid('query');
    return c.json(await readAdminAdoption(weeks, bucket));
  },
);

const workspacesQuerySchema = z.object({
  window: z.enum(GLANCE_WINDOWS).default('7d'),
  sort: z.enum(['runs', 'spend', 'leadTime']).default('runs'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

adminAggregateRoutes.get(
  '/workspaces',
  zValidator('query', workspacesQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { window, sort, limit } = c.req.valid('query');
    const { rows, total } = await readAdminWorkspaces(window, sort, limit);
    return c.json(listResponse(c, rows, total, { limit, offset: 0 }));
  },
);
